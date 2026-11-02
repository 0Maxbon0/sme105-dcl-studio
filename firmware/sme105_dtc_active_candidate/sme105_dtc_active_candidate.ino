#include <Arduino.h>
#include <HardwareSerial.h>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <soc/soc.h>
#include <soc/gpio_struct.h>
#include <soc/timer_group_struct.h>
#include <soc/uart_struct.h>
#include <cstring>
#include "cart_b_active_model.h"
#include "stop_line_matcher.h"

// UNQUALIFIED EXPERIMENT. No vehicle/EEC-IV source proof or physical TX
// timing proof. Build default cannot transmit B, even if the operator sends
// BENCH_B_A4_ONCE or BENCH_B_0E_ONCE. There is no hardware authorization yet.
// This is a separate source experiment and must NEVER be flashed to vehicle.
#ifndef SME105_ACTIVE_B_TX
#define SME105_ACTIVE_B_TX 0
#endif
#if SME105_ACTIVE_B_TX != 0
#error "Active B build forbidden until analyzer proves all four physical slots, TX_DONE and DE cutoff"
#endif

namespace {
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr uint32_t kObserveMs = 10000;
constexpr uint32_t kAckWindowMs = 400;
constexpr uint32_t kAckQuietMs = 20;
constexpr uint64_t kHandshakeCutoffUs = 100000;
constexpr uint32_t kSlotCutoffUs = 2250;  // <2.3ms, <2500us slot
constexpr uint32_t kMinSlotLeadUs = 180;
constexpr uint32_t kMaxSlotLeadUs = 1250;
constexpr size_t kMaxEvents = 8192;
constexpr uint8_t kEchoId[11] = {0,0,0,0,0,1,0x82,0,0,0,0x83};
constexpr uint8_t kGoCart[11] = {0,0,0,0,0,1,0x04,0,0,0,0x05};

struct RxEvent { uint32_t completeUs; uint8_t octet; };
RxEvent observations[kMaxEvents];
volatile uint32_t rxCount = 0;
volatile uint32_t uartErrors = 0;
volatile uint32_t coalesced = 0;
volatile uint32_t dropped = 0;
volatile bool cutoffTriggered = false;
volatile bool slotInFlight = false;
// Host STOP and the timer ISR must serialize the final decision to assert DE.
volatile bool stopLatched = false;
portMUX_TYPE slotGuard = portMUX_INITIALIZER_UNLOCKED;
bool rawEnabled = false;
bool referenceUartEnabled = false;
bool oneShotConsumed = false;
bool requestMode = false;
bool stopByHost = false;
char commandLine[32] = {};
size_t lineUsed = 0;

HardwareSerial referenceBus(2);
hw_timer_t* watchdog = nullptr;  // Arduino timer 0: TIMERG0 timer0
hw_timer_t* slotTimer = nullptr; // Arduino timer 2: TIMERG0 timer1
intr_handle_t rawHandle = nullptr;
cart_candidate::FourWordRequest request(cart_candidate::Variant::FlxA4);

bool hostStopRequested();

void driverOff() { gpio_set_level(kDe, 0); }

void IRAM_ATTR offISR() { GPIO.out_w1tc = 1UL << 18; }
void IRAM_ATTR disableSlotAlarm() { TIMERG0.hw_timer[1].config.alarm_en = 0; }
void IRAM_ATTR disableCutoffAlarm() { TIMERG0.hw_timer[0].config.alarm_en = 0; }

bool IRAM_ATTR armAbsoluteTimer(uint8_t index, uint32_t deltaUs) {
  // Both group-0 counters run at 1 MHz (divider=80) and never pause.
  // Direct group registers keep ISR paths free of IDF task mutexes.
  if (index > 1) return false;
  TIMERG0.hw_timer[index].config.alarm_en = 0;
  TIMERG0.hw_timer[index].update = 1;
  const uint64_t counter =
      (static_cast<uint64_t>(TIMERG0.hw_timer[index].cnt_high) << 32) |
      TIMERG0.hw_timer[index].cnt_low;
  const uint64_t until = counter + deltaUs;
  TIMERG0.hw_timer[index].alarm_high = static_cast<uint32_t>(until >> 32);
  TIMERG0.hw_timer[index].alarm_low = static_cast<uint32_t>(until);
  if (index == 0) TIMERG0.int_clr_timers.t0 = 1;
  else TIMERG0.int_clr_timers.t1 = 1;
  TIMERG0.hw_timer[index].config.alarm_en = 1;
  return true;
}

bool IRAM_ATTR armSlot(uint32_t targetUs) {
  if (!slotTimer || !watchdog) return false;
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  const int32_t lead = static_cast<int32_t>(targetUs - now);
  if (lead < static_cast<int32_t>(kMinSlotLeadUs) ||
      lead > static_cast<int32_t>(kMaxSlotLeadUs)) return false;
  return armAbsoluteTimer(1, static_cast<uint32_t>(lead));
}

void IRAM_ATTR failIsr(cart_candidate::Fault fault) {
  offISR();
  disableSlotAlarm();
  disableCutoffAlarm();
  UART2.int_ena.tx_done = 0;
  slotInFlight = false;
  request.abort(fault);
}

// Hardware watchdog is armed BEFORE DE is driven high for each B word.
// If TX_DONE is late/missing, DE drops independently of UART and USB tasks.
void IRAM_ATTR watchdogISR() {
  offISR();
  disableCutoffAlarm();
  cutoffTriggered = true;
  if (slotInFlight) failIsr(cart_candidate::Fault::Timeout);
}

// TIMERG0/T1 slot target ISR. The only allowed UART data are the four
// source-pinned pairs; never accepts externally supplied bytes or lengths.
void IRAM_ATTR slotISR() {
  disableSlotAlarm();
  portENTER_CRITICAL_ISR(&slotGuard);
  if (!requestMode || request.stage != cart_candidate::Stage::Request ||
      !SME105_ACTIVE_B_TX || stopLatched) {
    portEXIT_CRITICAL_ISR(&slotGuard);
    return;
  }
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  if (!request.onTimer(now) || slotInFlight ||
      UART2.status.txfifo_cnt != 0 ||
      !(GPIO.in & (1UL << 16))) {
    failIsr(cart_candidate::Fault::LateTimer);
    portEXIT_CRITICAL_ISR(&slotGuard);
    return;
  }
  // A disabled 2400 TX UART must not compete with this dedicated raw UART.
  if (!armAbsoluteTimer(0, kSlotCutoffUs)) {
    failIsr(cart_candidate::Fault::Timeout);
    portEXIT_CRITICAL_ISR(&slotGuard);
    return;
  }
  UART2.int_clr.tx_done = 1;
  UART2.int_ena.tx_done = 1;
  slotInFlight = true;
  GPIO.out_w1ts = 1UL << 18;
  const cart_candidate::Word next =
      cart_candidate::word(request.variant(), request.completed);
  UART2.fifo.rw_byte = next.first;
  UART2.fifo.rw_byte = next.second;
  portEXIT_CRITICAL_ISR(&slotGuard);
}

void stopActiveRequest() {
  // STOP is a hard local interrupt interlock, not merely a flag examined on
  // the following frame. No timer ISR may drive DE after this returns.
  portENTER_CRITICAL(&slotGuard);
  stopLatched = true;
  offISR();
  disableSlotAlarm();
  disableCutoffAlarm();
  UART2.int_ena.tx_done = 0;
  UART2.conf0.txfifo_rst = 1;
  UART2.conf0.txfifo_rst = 0;
  slotInFlight = false;
  if (requestMode) request.abort(cart_candidate::Fault::Timeout);
  portEXIT_CRITICAL(&slotGuard);
}

void IRAM_ATTR uartISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++uartErrors;
    if (requestMode) failIsr(cart_candidate::Fault::RxError);
  }
  const uint32_t count = UART2.status.rxfifo_cnt;
  if (count > 1) {
    ++coalesced;
    if (requestMode) failIsr(cart_candidate::Fault::RxError);
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t octet = static_cast<uint8_t>(UART2.fifo.rw_byte);
    const uint32_t atUs = static_cast<uint32_t>(esp_timer_get_time());
    const uint32_t pos = rxCount;
    if (pos < kMaxEvents) {
      observations[pos].completeUs = atUs;
      observations[pos].octet = octet;
      rxCount = pos + 1;
    } else ++dropped;
    if (requestMode && request.stage != cart_candidate::Stage::Failed &&
        request.stage != cart_candidate::Stage::Response) {
      if (uartErrors || coalesced || dropped || pos >= kMaxEvents) {
        failIsr(cart_candidate::Fault::RxError);
      } else {
        const auto status = request.onByte(octet, atUs);
        if (status == cart_candidate::Event::ArmSlot) {
          if (!armSlot(request.targetUs[request.requested - 1])) {
            failIsr(cart_candidate::Fault::LateTimer);
          }
        } else if (status == cart_candidate::Event::Abort) {
          failIsr(request.fault);
        }
      }
    }
  }
  if (pending & (1UL << 14)) {  // UART TX_DONE: both bytes fully shifted
    offISR();
    disableCutoffAlarm();
    UART2.int_ena.tx_done = 0;
    const bool wasTransmitting = slotInFlight;
    slotInFlight = false;
    if (requestMode && wasTransmitting &&
        request.stage != cart_candidate::Stage::Failed) {
      const auto result = request.onTxDone(
          static_cast<uint32_t>(esp_timer_get_time()));
      if (result == cart_candidate::Event::Abort) failIsr(request.fault);
      // After four exact echoes and four TX_DONE events the model switches
      // to Response. There is no fifth timer scheduling or requeue.
    } else if (requestMode && !wasTransmitting) {
      failIsr(cart_candidate::Fault::UnexpectedTxDone);
    }
  }
  UART2.int_clr.val = pending;
}

void onSerialError(hardwareSerial_error_t) { ++uartErrors; }

void printHex(uint8_t b) {
  if (b < 16) Serial.print('0');
  Serial.print(b, HEX);
}

bool begin2400() {
  driverOff();
  if (!watchdog) return false;
  referenceBus.setRxBufferSize(256);
  referenceBus.begin(2400, SERIAL_8N2, kRx, kTx);
  referenceBus.onReceiveError(onSerialError);
  referenceUartEnabled = true;
  return true;
}

void end2400() {
  driverOff();
  if (referenceUartEnabled) referenceBus.end();
  referenceUartEnabled = false;
  pinMode(kTx, INPUT);
}

bool transmitReference(const uint8_t (&bytes)[11], const char* name) {
  driverOff();
  if (hostStopRequested()) {
    stopByHost = true;
    stopActiveRequest();
    return false;
  }
  if (!watchdog || uartErrors || digitalRead(kRx) != HIGH) return false;
  cutoffTriggered = false;
  timerWrite(watchdog, 0);
  timerAlarmWrite(watchdog, kHandshakeCutoffUs, false);
  timerAlarmEnable(watchdog);
  gpio_set_level(kDe, 1);
  delayMicroseconds(20);
  const size_t queued = referenceBus.write(bytes, sizeof(bytes));
  referenceBus.flush();
  driverOff();
  timerAlarmDisable(watchdog);
  Serial.print(F("REF_TX frame=")); Serial.print(name);
  Serial.print(F(" n=")); Serial.print(queued);
  Serial.print(F(" cutoff=")); Serial.println(cutoffTriggered ? 1 : 0);
  return queued == sizeof(bytes) && !cutoffTriggered && uartErrors == 0;
}

bool exactCandidateAck() {
  uint8_t answer[16] = {};
  size_t n = 0;
  const uint32_t began = millis();
  uint32_t last = began;
  while (millis() - began < kAckWindowMs) {
    if (hostStopRequested()) {
      stopByHost = true;
      stopActiveRequest();
      return false;
    }
    while (referenceBus.available()) {
      const int ch = referenceBus.read();
      if (ch < 0 || n >= sizeof(answer)) return false;
      answer[n++] = static_cast<uint8_t>(ch);
      last = millis();
    }
    if (n >= 12 && millis() - last >= kAckQuietMs) break;
    delay(1);
  }
  const bool valid = n == 12 && !std::memcmp(answer, kEchoId, 11) &&
      answer[11] == 0x01 && uartErrors == 0;
  Serial.println(valid ? F("ACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED") :
                         F("ACK_REJECT exact_candidate_required"));
  return valid;
}

bool open9600() {
  end2400();
  rxCount = 0; dropped = 0; coalesced = 0; uartErrors = 0;
  slotInFlight = false;
  cutoffTriggered = false;
  disableSlotAlarm();
  disableCutoffAlarm();
  const uart_config_t cfg = {
      .baud_rate = 9600,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .rx_flow_ctrl_thresh = 0,
      .source_clk = UART_SCLK_APB,
  };
  if (uart_param_config(UART_NUM_2, &cfg) != ESP_OK ||
      uart_set_pin(UART_NUM_2, kTx, kRx,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  UART2.int_ena.val = 0;
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.rxfifo_rst = 1;
  UART2.conf0.rxfifo_rst = 0;
  UART2.conf0.txfifo_rst = 1;
  UART2.conf0.txfifo_rst = 0;
  UART2.conf1.rxfifo_full_thrhd = 1;
  // Arduino's 2400-baud Serial2.end() removes the IDF UART driver object;
  // uart_isr_register() dereferences it and crashes. Install the native
  // UART2 interrupt directly; our ISR owns FIFO, status and TX_DONE.
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uartISR, nullptr, &rawHandle) != ESP_OK) return false;
  rawEnabled = true;
  UART2.int_ena.rxfifo_full = 1;
  UART2.int_ena.rxfifo_ovf = 1;
  UART2.int_ena.frm_err = 1;
  UART2.int_ena.parity_err = 1;
  // TX_DONE stays disabled until the hardware slot ISR queues exactly 2 bytes.
  return true;
}

void close9600() {
  driverOff();
  disableSlotAlarm();
  disableCutoffAlarm();
  UART2.int_ena.val = 0;
  if (rawEnabled && rawHandle) (void)esp_intr_free(rawHandle);
  rawEnabled = false;
  rawHandle = nullptr;
  pinMode(kTx, INPUT);
}

bool hostStopRequested() {
  static StopLineMatcher matcher;
  while (Serial.available()) {
    if (matcher.consume(static_cast<char>(Serial.read()))) return true;
  }
  return false;
}

void dumpReport() {
  const uint32_t n = rxCount;
  Serial.print(F("CART_CAPTURE n=")); Serial.print(n);
  Serial.print(F(" uart_errors=")); Serial.print(uartErrors);
  Serial.print(F(" coalesced=")); Serial.print(coalesced);
  Serial.print(F(" dropped=")); Serial.print(dropped);
  Serial.print(F(" capped=")); Serial.print(n == kMaxEvents ? 1 : 0);
  Serial.print(F(" cutoff=")); Serial.println(cutoffTriggered ? 1 : 0);
  if (requestMode) {
    Serial.print(F("CART_B_STATE stage=")); Serial.print(static_cast<unsigned>(request.stage));
    Serial.print(F(" reason=")); Serial.print(static_cast<unsigned>(request.fault));
    Serial.print(F(" baseline=")); Serial.print(request.baselineFrames);
    Serial.print(F(" scheduled=")); Serial.print(request.requested);
    Serial.print(F(" echoed=")); Serial.print(request.completed);
    Serial.print(F(" variant="));
    Serial.println(request.variant() == cart_candidate::Variant::FlxA4 ? F("26A4") : F("260E"));
    for (uint8_t i = 0; i < request.requested && i < 4; ++i) {
      const auto code = cart_candidate::word(request.variant(), i);
      // Only report CART_TX once all four have received exact local echoes
      // and observed timely TX_DONE. A partial attempt is not such a witness.
      const bool complete = request.stage == cart_candidate::Stage::Response &&
          request.completed == 4 && !uartErrors && !dropped && !coalesced &&
          !cutoffTriggered;
      Serial.print(complete ? F("CART_TX start_us=") : F("CART_TX_ATTEMPT start_us="));
      Serial.print(request.startUs[i]);
      Serial.print(F(" end_us=")); Serial.print(request.doneUs[i]);
      Serial.print(F(" frame=")); Serial.print(i);
      Serial.print(F(" slot=1 opcode=")); printHex(code.first); printHex(code.second);
      Serial.print(F(" uart_errors=")); Serial.print(uartErrors);
      Serial.print(F(" cutoff=")); Serial.print(cutoffTriggered ? 1 : 0);
      Serial.print(F(" echo_verified=")); Serial.println(i < request.completed ? 1 : 0);
    }
  }
  Serial.println(F("CART_TIMEBASE source=UART2_RX_FIFO_ISR time=us latency_uncalibrated=1"));
  for (uint32_t i = 0; i < n; ++i) {
    Serial.print(F("CART_EVT t_us=")); Serial.print(observations[i].completeUs);
    Serial.print(F(" byte=")); printHex(observations[i].octet);
    Serial.println();
  }
  Serial.print(F("CART_END bytes=")); Serial.print(n);
  Serial.print(F(" uart_errors=")); Serial.print(uartErrors);
  Serial.print(F(" dropped=")); Serial.print(dropped);
  Serial.print(F(" cutoff=")); Serial.print(cutoffTriggered ? 1 : 0);
  Serial.println(F(" ecu_verified=0 dtc_verified=0"));
}

void attempt(cart_candidate::Variant variant, bool sendB) {
  oneShotConsumed = true; // consume before the first handshake TX
  stopLatched = false; // no slot alarm or active transmit exists yet
  requestMode = sendB;
  stopByHost = false;
  request = cart_candidate::FourWordRequest(variant);
  uartErrors = 0;
  driverOff();
  if (!begin2400() || (sendB && (!slotTimer || !watchdog))) {
    end2400(); Serial.println(F("ABORT reference_init_failed")); return;
  }
  while (referenceBus.available()) (void)referenceBus.read();
  if (!transmitReference(kEchoId, "ECHO_ID") ||
      !exactCandidateAck() || !transmitReference(kGoCart, "GO_CART")) {
    end2400(); Serial.println(F("ABORT exact_handshake_failed")); return;
  }
  if (!open9600()) {
    close9600(); Serial.println(F("ABORT raw_uart_init_failed")); return;
  }
  const uint32_t begun = millis();
  while (millis() - begun < kObserveMs) {
    if (hostStopRequested()) {
      stopByHost = true;
      stopActiveRequest();
      break;
    }
    if (uartErrors || coalesced || dropped || rxCount == kMaxEvents ||
        (sendB && request.stage == cart_candidate::Stage::Failed)) break;
    delay(1);
  }
  close9600();
  Serial.print(F("CART_RUN mode="));
  Serial.print(sendB ? F("ACTIVE_CANDIDATE") : F("PASSIVE_AFTER_HANDSHAKE"));
  Serial.print(F(" stopped=")); Serial.println(stopByHost ? 1 : 0);
  dumpReport();
}

void help() {
  Serial.println(F("COMMANDS STATUS | HELP | OBSERVE_CART_ONCE | BENCH_B_A4_ONCE | BENCH_B_0E_ONCE | STOP"));
  Serial.println(F("B active requests are compile-locked until independent analyzer-based safety proof"));
  Serial.println(F("Never clears DTCs, starts KOEO tests, repeats TX, or accepts arbitrary opcodes"));
}

void command() {
  if (!std::strcmp(commandLine, "STATUS")) {
    driverOff();
    Serial.print(F("STATUS SME105_ACTIVE_CANDIDATE_V1 DE=LOW B_TX=LOCKED attempt_used="));
    Serial.print(oneShotConsumed ? 1 : 0);
    Serial.print(F(" timers=")); Serial.println(watchdog && slotTimer ? 2 : 0);
  } else if (!std::strcmp(commandLine, "HELP")) help();
  else if (!std::strcmp(commandLine, "OBSERVE_CART_ONCE")) {
    if (oneShotConsumed) Serial.println(F("DENIED one_attempt_consumed"));
    else attempt(cart_candidate::Variant::FlxA4, false);
  } else if (!std::strcmp(commandLine, "BENCH_B_A4_ONCE") ||
             !std::strcmp(commandLine, "BENCH_B_0E_ONCE")) {
    if (oneShotConsumed) Serial.println(F("DENIED one_attempt_consumed"));
    else if (!SME105_ACTIVE_B_TX) {
      Serial.println(F("DENIED COMPILE_LOCK hardware timing / contention / DE turnaround UNVERIFIED"));
    } else {
      attempt(!std::strcmp(commandLine, "BENCH_B_A4_ONCE") ?
          cart_candidate::Variant::FlxA4 : cart_candidate::Variant::Don0E, true);
    }
  } else if (!std::strcmp(commandLine, "STOP")) {
    driverOff(); Serial.println(F("STOP DE_LOW"));
  } else if (commandLine[0]) Serial.println(F("DENIED unsupported_command"));
}
} // namespace

void setup() {
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  driverOff();
  pinMode(kTx, INPUT);
  pinMode(19, INPUT);
  Serial.begin(115200);
  watchdog = timerBegin(0, 80, true);
  if (watchdog) {
    timerAttachInterruptFlag(watchdog, &watchdogISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmWrite(watchdog, kHandshakeCutoffUs, false);
    timerAlarmDisable(watchdog);
  }
  slotTimer = timerBegin(2, 80, true);
  if (slotTimer) {
    timerAttachInterruptFlag(slotTimer, &slotISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmDisable(slotTimer);
  }
  delay(250);
  Serial.println(F("SME105_ACTIVE_CANDIDATE_V1 NO_AUTO_TX ACTIVE_B_BUILD_LOCKED"));
  help();
}

void loop() {
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (lineUsed) {
        commandLine[lineUsed] = 0;
        command();
        lineUsed = 0;
        commandLine[0] = 0;
      }
    } else if (ch >= ' ' && ch <= '~' && lineUsed < sizeof(commandLine)-1) {
      commandLine[lineUsed++] = ch;
    } else {
      lineUsed = 0;
      commandLine[0] = 0;
      Serial.println(F("DENIED invalid_or_overlong_command"));
    }
  }
}
