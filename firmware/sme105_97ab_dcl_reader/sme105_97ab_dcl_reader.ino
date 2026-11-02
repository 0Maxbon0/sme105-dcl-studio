#include <Arduino.h>
#include <HardwareSerial.h>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <driver/rmt.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <soc/soc.h>
#include <soc/gpio_struct.h>
#include <soc/gpio_sig_map.h>
#include <soc/rmt_struct.h>
#include <soc/timer_group_struct.h>
#include <soc/uart_struct.h>
#include <cstring>
#include "cart_b_active_model.h"
#include "stop_line_matcher.h"

// Ford 97AB-12A650-KA (SME-105) field research image.
// No TX at boot. Explicit one-shot commands only, never clear/KOEO/actuation.
// The physical CAR adapter must be validated before any ECU-connected attempt.
// Evidence from bench only cannot authenticate real ECU DTC response.
constexpr bool kBEnabled = true;

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
intr_handle_t txHandle = nullptr;
uint8_t rmtChannelsReady = 0;
bool benchMode = false;
volatile uint8_t benchTxDone = 0;
volatile uint32_t benchTxDoneUs = 0;
cart_candidate::FourWordRequest request(cart_candidate::Variant::FlxA4);

bool hostStopRequested();

void driverOff() {
  // A canceled RMT pulse must never regain ownership of DE on GPIO18.
  GPIO.out_w1tc = (1UL << 18);
  GPIO.func_out_sel_cfg[18].func_sel = SIG_GPIO_OUT_IDX;
}

void IRAM_ATTR offISR() {
  GPIO.out_w1tc = 1UL << 18;
  GPIO.func_out_sel_cfg[18].func_sel = SIG_GPIO_OUT_IDX;
}
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
      !kBEnabled || stopLatched) {
    portEXIT_CRITICAL_ISR(&slotGuard);
    return;
  }
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  if (!request.onTimer(now) || slotInFlight || rmtChannelsReady != 4 ||
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
  const int channel = 2 + request.completed;
  GPIO.func_out_sel_cfg[18].func_sel = RMT_SIG_OUT2_IDX + request.completed;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 1;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 0;
  RMT.conf_ch[channel].conf1.tx_start = 1;
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

// MAX487 RO is on GPIO16. UART1 RX is the hardware receiver proved on the
// real isolated A/B bench; UART2's RX had returned D1 for a clean 55 waveform.
void IRAM_ATTR uartISR(void*) {
  const uint32_t pending = UART1.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++uartErrors;
    if (requestMode) failIsr(cart_candidate::Fault::RxError);
  }
  const uint32_t count = UART1.status.rxfifo_cnt;
  if (count > 1) {
    ++coalesced;
    if (requestMode) failIsr(cart_candidate::Fault::RxError);
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t octet = static_cast<uint8_t>(UART1.fifo.rw_byte);
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
  UART1.int_clr.val = pending;
}

void IRAM_ATTR txDoneISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & (1UL << 14)) {  // UART2 TX_DONE: final stop bit shifted
    offISR();
    disableCutoffAlarm();
    UART2.int_ena.tx_done = 0;
    const bool wasTransmitting = slotInFlight;
    slotInFlight = false;
    if (benchMode) {
      benchTxDoneUs = static_cast<uint32_t>(esp_timer_get_time());
      ++benchTxDone;
    } else if (requestMode && wasTransmitting &&
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
      if (ch < 0) return false;
      if (n >= sizeof(answer)) {
        Serial.print(F("REF_ACK_OVERFLOW first16="));
        for (size_t i = 0; i < n; ++i) {
          if (i) Serial.print(' ');
          printHex(answer[i]);
        }
        Serial.print(F(" extra=")); printHex(static_cast<uint8_t>(ch));
        Serial.println(F(" no_gocart=1"));
        return false;
      }
      answer[n++] = static_cast<uint8_t>(ch);
      last = millis();
    }
    if (n >= 12 && millis() - last >= kAckQuietMs) break;
    delay(1);
  }
  Serial.print(F("REF_ACK count=")); Serial.print(n);
  Serial.print(F(" raw="));
  for (size_t i = 0; i < n; ++i) {
    if (i) Serial.print(' ');
    printHex(answer[i]);
  }
  Serial.print(F(" uart_errors=")); Serial.println(uartErrors);
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
  if (uart_param_config(UART_NUM_1, &cfg) != ESP_OK ||
      uart_param_config(UART_NUM_2, &cfg) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kRx,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_set_pin(UART_NUM_2, kTx, UART_PIN_NO_CHANGE,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  // Match the electrically successful MAX487 bench UART1 receive route.
  gpio_pad_select_gpio(static_cast<gpio_num_t>(kRx));
  gpio_matrix_in(kRx, U1RXD_IN_IDX, false);
  if (GPIO.func_in_sel_cfg[U1RXD_IN_IDX].func_sel != kRx ||
      GPIO.func_in_sel_cfg[U1RXD_IN_IDX].sig_in_sel != 1) return false;
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U2TXD_OUT_IDX, false, false);
  UART1.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1;
  UART1.conf0.rxfifo_rst = 0;
  UART2.int_ena.val = 0;
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.txfifo_rst = 1;
  UART2.conf0.txfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1;
  // Native interrupts after Arduino's Serial2.end() avoid the previously
  // observed uart_isr_register StoreProhibited; never register onto the
  // deleted Arduino UART2 driver's handle.
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uartISR, nullptr, &rawHandle) != ESP_OK) return false;
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &txDoneISR, nullptr, &txHandle) != ESP_OK) {
    (void)esp_intr_free(rawHandle);
    rawHandle = nullptr;
    return false;
  }
  rawEnabled = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  // TX_DONE stays disabled until the hardware slot ISR queues exactly 2 bytes.
  return true;
}

void close9600() {
  driverOff();
  disableSlotAlarm();
  disableCutoffAlarm();
  UART1.int_ena.val = 0;
  UART2.int_ena.val = 0;
  if (rawEnabled && rawHandle) (void)esp_intr_free(rawHandle);
  if (txHandle) (void)esp_intr_free(txHandle);
  rawEnabled = false;
  rawHandle = nullptr;
  txHandle = nullptr;
  pinMode(kTx, INPUT);
}

bool setupDeRmt() {
  // Each four-word command slot has its own one-shot autonomous 2180us gate.
  // Even if the CPU stalls after starting the pulse, RMT returns DE LOW.
  rmt_config_t gate = {};
  gate.rmt_mode = RMT_MODE_TX;
  gate.gpio_num = GPIO_NUM_18;
  gate.clk_div = 80;
  gate.mem_block_num = 1;
  gate.tx_config.loop_en = false;
  gate.tx_config.carrier_en = false;
  gate.tx_config.idle_output_en = true;
  gate.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  rmt_item32_t pulse = {};
  pulse.duration0 = 2180;
  pulse.level0 = 1;
  pulse.duration1 = 80;
  pulse.level1 = 0;
  for (int i = 0; i < 4; ++i) {
    const auto channel = static_cast<rmt_channel_t>(RMT_CHANNEL_2 + i);
    gate.channel = channel;
    if (rmt_config(&gate) != ESP_OK ||
        rmt_driver_install(channel, 0, 0) != ESP_OK) return false;
    ++rmtChannelsReady;
    if (rmt_fill_tx_items(channel, &pulse, 1, 0) != ESP_OK) return false;
  }
  driverOff();
  return true;
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
  Serial.println(F("CART_TIMEBASE source=UART1_RX_FIFO_ISR time=us latency_uncalibrated=1"));
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
  // A lingering CART stream after a previous session is not an invitation
  // to start another 2400 baud master handshake over active ECU traffic.
  if (!begin2400() || (sendB &&
       (!slotTimer || !watchdog || rmtChannelsReady != 4))) {
    end2400(); Serial.println(F("ABORT reference_init_failed")); return;
  }
  uint32_t preBytes = 0;
  const uint32_t preStart = millis();
  while (millis() - preStart < 150) {
    while (referenceBus.available()) {
      if (referenceBus.read() >= 0) ++preBytes;
      if (preBytes >= 32) break;
    }
    if (preBytes || uartErrors || digitalRead(kRx) != HIGH) break;
    delay(1);
  }
  if (preBytes || uartErrors || digitalRead(kRx) != HIGH) {
    end2400();
    Serial.print(F("ABORT prehandshake_busy bytes=")); Serial.print(preBytes);
    Serial.print(F(" uart_errors=")); Serial.println(uartErrors);
    return;
  }
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
  Serial.println(F("COMMANDS STATUS | PINS | HELP | PREVIEW_B_A4 | PREVIEW_B_0E | RX_TEST | DESK_MAX_ONCE | OBSERVE_CART_ONCE | READ_DTC_A4_ONCE | READ_DTC_0E_ONCE | STOP"));
  Serial.println(F("97AB-12A650-KA; B attempts manual one-shot, unqualified on vehicle; no auto TX at boot"));
  Serial.println(F("Never clears DTCs, starts KOEO tests, repeats TX, or accepts arbitrary opcodes"));
}

void previewB(cart_candidate::Variant variant) {
  // Fully passive software preview: no EchoID, GoCART, slot timer, FIFO
  // writes or DE assertion. This is not ECU-specific authorization.
  driverOff();
  Serial.print(F("B_PREVIEW variant="));
  Serial.print(variant == cart_candidate::Variant::FlxA4 ? F("26A4") : F("260E"));
  Serial.print(F(" cmd_frames=4 next_block_response_slot_limit="));
  Serial.print(variant == cart_candidate::Variant::FlxA4 ? 4 : 14);
  Serial.println(F(" actual_bus_tx=0 ecu_verified=0 vehicle_authorized=0"));
  for (uint8_t frame = 0; frame < 4; ++frame) {
    const cart_candidate::Word word = cart_candidate::word(variant, frame);
    Serial.print(F("B_PREVIEW_WORD frame=")); Serial.print(frame);
    Serial.print(F(" slot=1 word=")); printHex(word.first); printHex(word.second);
    Serial.println(F(" uart_bytes=0"));
  }
}

void rxTest() {
  // USB commanded RX-only native interrupt lifecycle. Never starts DE/RMT.
  if (!open9600()) {
    close9600();
    Serial.println(F("RX_TEST FAIL init"));
    return;
  }
  delay(40);
  const uint32_t n = rxCount, err = uartErrors, coal = coalesced;
  close9600();
  Serial.print(F("RX_TEST ")); Serial.print(err || coal ? F("FAIL") : F("PASS"));
  Serial.print(F(" rx=")); Serial.print(n);
  Serial.print(F(" errors=")); Serial.print(err);
  Serial.print(F(" coalesced=")); Serial.print(coal);
  Serial.println(F(" vehicle_tx=0 DE=LOW"));
}

bool eventsSafe(uint32_t first, const uint8_t (&expected)[2]) {
  // Called only with the native RX ISR still enabled; count and contents
  // are checked after both bytes have been fully received into DRAM.
  if (first + 1 >= rxCount || first + 1 >= kMaxEvents) return false;
  return observations[first].octet == expected[0] &&
         observations[first + 1].octet == expected[1];
}

void deskMaxOnce() {
  // Physically isolated MAX487 local RO echo, using the CURRENT wiring.
  // This does NOT require the retired XY-K485/GPIO19 or DE sense GPIO21.
  oneShotConsumed = true;
  requestMode = false;
  benchMode = true;
  benchTxDone = 0;
  driverOff();
  if (rmtChannelsReady != 4 || !watchdog || !open9600() ||
      digitalRead(kRx) != HIGH) {
    close9600();
    benchMode = false;
    Serial.println(F("DESK_END FAIL init_or_idle B_TX=0 ECU_TX=0"));
    return;
  }
  const uint8_t words[4][2] = {{0x55, 0xAA}, {0x33, 0xCC},
                               {0x0F, 0xF0}, {0x69, 0x96}};
  bool pass = true;
  uint8_t completed = 0;
  Serial.println(F("DESK_BEGIN MAX_UART1_RX16_UART2_TX17_RMT_DE18 no_car=1"));
  for (int i = 0; i < 4 && pass; ++i) {
    const uint32_t startRx = rxCount;
    const uint32_t errorsBefore = uartErrors + coalesced + dropped;
    benchTxDone = 0;
    benchTxDoneUs = 0;
    const uint32_t startUs = static_cast<uint32_t>(esp_timer_get_time());
    if (UART2.status.txfifo_cnt || digitalRead(kRx) != HIGH ||
        !armAbsoluteTimer(0, kSlotCutoffUs)) {
      pass = false;
      break;
    }
    UART2.int_clr.tx_done = 1;
    UART2.int_ena.tx_done = 1;
    const int ch = 2 + i;
    GPIO.func_out_sel_cfg[18].func_sel = RMT_SIG_OUT2_IDX + i;
    RMT.conf_ch[ch].conf1.mem_rd_rst = 1;
    RMT.conf_ch[ch].conf1.mem_rd_rst = 0;
    RMT.conf_ch[ch].conf1.tx_start = 1;
    UART2.fifo.rw_byte = words[i][0];
    UART2.fifo.rw_byte = words[i][1];
    while (static_cast<uint32_t>(esp_timer_get_time()) - startUs < 3300 &&
           (!benchTxDone || rxCount < startRx + 2))
      delayMicroseconds(30);
    offISR();
    disableCutoffAlarm();
    const uint32_t n = rxCount - startRx;
    const uint32_t doneUs = benchTxDoneUs;
    const bool exact = n == 2 && eventsSafe(startRx, words[i]);
    const bool good = exact && benchTxDone == 1 &&
        doneUs - startUs >= 1900 && doneUs - startUs < 2250 &&
        !cutoffTriggered && uartErrors + coalesced + dropped == errorsBefore;
    Serial.print(F("DESK_WORD index=")); Serial.print(i);
    Serial.print(F(" expected=")); printHex(words[i][0]); printHex(words[i][1]);
    Serial.print(F(" rx_count=")); Serial.print(n);
    Serial.print(F(" tx_done=")); Serial.print(benchTxDone);
    Serial.print(F(" delta_us=")); Serial.print(doneUs - startUs);
    Serial.print(F(" match=")); Serial.println(good ? 1 : 0);
    if (!good) { pass = false; break; }
    ++completed;
    delay(8);
  }
  close9600();
  benchMode = false;
  Serial.print(F("DESK_END ")); Serial.print(pass && completed == 4 ? F("PASS") : F("FAIL"));
  Serial.print(F(" completed=")); Serial.print(completed);
  Serial.print(F(" uart_errors=")); Serial.print(uartErrors);
  Serial.print(F(" cutoff=")); Serial.print(cutoffTriggered ? 1 : 0);
  Serial.println(F(" B_TX=0 ECU_TX=0 DE=LOW"));
}

void command() {
  if (!std::strcmp(commandLine, "STATUS")) {
    driverOff();
    Serial.print(F("STATUS SME105_97AB_READER_V1 ecu=97AB-12A650-KA DE=LOW auto_tx=0 attempt_used="));
    Serial.print(oneShotConsumed ? 1 : 0);
    Serial.print(F(" timers=")); Serial.print(watchdog && slotTimer ? 2 : 0);
    Serial.print(F(" gate4=")); Serial.println(rmtChannelsReady == 4 ? 1 : 0);
  } else if (!std::strcmp(commandLine, "HELP")) help();
  else if (!std::strcmp(commandLine, "PREVIEW_B_A4") ||
           !std::strcmp(commandLine, "PREVIEW_B_0E")) {
    previewB(!std::strcmp(commandLine, "PREVIEW_B_A4") ?
        cart_candidate::Variant::FlxA4 : cart_candidate::Variant::Don0E);
  }
  else if (!std::strcmp(commandLine, "PINS")) {
    driverOff();
    Serial.print(F("PINS ro16=")); Serial.print(digitalRead(kRx) == HIGH ? 1 : 0);
    Serial.print(F(" de18=")); Serial.print(digitalRead(18) == HIGH ? 1 : 0);
    Serial.print(F(" gate4=")); Serial.print(rmtChannelsReady == 4 ? 1 : 0);
    Serial.println(F(" DE=LOW no_tx=1"));
  }
  else if (!std::strcmp(commandLine, "RX_TEST")) rxTest();
  else if (!std::strcmp(commandLine, "DESK_MAX_ONCE")) {
    if (oneShotConsumed) Serial.println(F("DENIED one_attempt_consumed"));
    else deskMaxOnce();
  }
  else if (!std::strcmp(commandLine, "OBSERVE_CART_ONCE")) {
    if (oneShotConsumed) Serial.println(F("DENIED one_attempt_consumed"));
    else attempt(cart_candidate::Variant::FlxA4, false);
  } else if (!std::strcmp(commandLine, "READ_DTC_A4_ONCE") ||
             !std::strcmp(commandLine, "READ_DTC_0E_ONCE")) {
    if (oneShotConsumed) Serial.println(F("DENIED one_attempt_consumed"));
    else {
      attempt(!std::strcmp(commandLine, "READ_DTC_A4_ONCE") ?
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
  if (!setupDeRmt()) {
    Serial.begin(115200);
    Serial.println(F("FATAL RMT_GATE_INIT_FAILED: TX attempts forbidden"));
  }
  delay(250);
  Serial.println(F("SME105_97AB_READER_V1 NO_AUTO_TX MANUAL_ONE_SHOT"));
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
