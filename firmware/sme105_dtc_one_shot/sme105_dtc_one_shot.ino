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
#include "cart_b_plan.h"

// ESP32 DevKit V1 + MAX487; GPIO16=RO, GPIO17=DI, GPIO18=DE.
// This build only performs an explicitly requested 2400-baud reference
// handshake and device-side ISR timestamp capture. It cannot send B.
// There is NO validated SME-105 synchronized B command/turnaround sequence.
// Reference sources disagree: flxkrmr B=26 A4; doncreat0r B=26 0E, and
// doncreat0r's command buffer transmits in several frame IDs, not only ID2.
// One word written into ID2 slot1 would be an unverified bus collision risk.
#ifndef SME105_ENABLE_CART_B_TX
#define SME105_ENABLE_CART_B_TX 0
#endif
#if SME105_ENABLE_CART_B_TX != 0
#error "No safe B transmitter: verify full command block, slot timing and DE turnaround first"
#endif

namespace {
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kAckWindowMs = 400;
constexpr uint32_t kAckQuietMs = 20;
constexpr uint32_t kCaptureMs = 10000;
constexpr uint64_t kTxDeadlineUs = 100000;
constexpr size_t kEventLimit = 8192;
constexpr uint32_t kMinPlanLeadUs = 200;
constexpr uint32_t kMaxPlanLeadUs = 1200;
constexpr uint8_t kEchoId[11] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x82, 0x00, 0x00, 0x00, 0x83};
constexpr uint8_t kGoCart[11] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x05};
constexpr uint8_t kBReferenceFlx[2] = {0x26, 0xA4};
constexpr uint8_t kBReferenceDon[2] = {0x26, 0x0E};

struct RxEvent {
  uint32_t completeUs;
  uint8_t octet;
};

// Written only in UART2 ISR, read only after interrupts are shut down.
RxEvent events[kEventLimit];
volatile uint32_t eventCount = 0;
volatile uint32_t uartErrors = 0;
volatile uint32_t coalescedInterrupts = 0;
volatile uint32_t overLimitEvents = 0;
volatile bool txCutoff = false;
bool attemptUsed = false;
bool rawUartActive = false;
bool serialUartActive = false;
bool planRequested = false;
cart_b_plan::FourWordDryRun bPlan;
char commandLine[32] = {};
size_t lineLength = 0;
HardwareSerial dcl(2);
intr_handle_t rawUartHandle = nullptr;
hw_timer_t* deadlineTimer = nullptr;
hw_timer_t* planTimer = nullptr; // Arduino timer index 2 = TIMERG0 timer 1

// Direct write is safe in the hardware timer interrupt, and avoids calling
// Arduino GPIO helpers from that ISR. A real external DE pulldown is still
// required for reset/power-failure safety.
void IRAM_ATTR cutoffIsr() {
  GPIO.out_w1tc = (1UL << 18);
  txCutoff = true;
}

void driverOff() { gpio_set_level(kDe, 0); }
void onSerialError(hardwareSerial_error_t) { ++uartErrors; }

uint8_t vParity(uint8_t first, uint8_t id) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^ id ^ 10) << 4) | id);
}

void printHex(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void IRAM_ATTR disablePlanAlarm() {
  // Direct timer-group register access: no IDF mutex/task calls inside ISR.
  TIMERG0.hw_timer[1].config.alarm_en = 0;
}

bool IRAM_ATTR armPlanAlarm(uint32_t dueUs) {
  if (!planTimer) return false;
  const uint32_t nowUs = static_cast<uint32_t>(esp_timer_get_time());
  const int32_t leadUs = static_cast<int32_t>(dueUs - nowUs);
  if (leadUs < static_cast<int32_t>(kMinPlanLeadUs) ||
      leadUs > static_cast<int32_t>(kMaxPlanLeadUs)) return false;
  // 1 MHz dedicated free-running timer. Arm an absolute target from the
  // UART ISR; no delayMicroseconds or FreeRTOS task participates in timing.
  TIMERG0.hw_timer[1].update = 1;
  const uint64_t counter =
      (static_cast<uint64_t>(TIMERG0.hw_timer[1].cnt_high) << 32) |
      TIMERG0.hw_timer[1].cnt_low;
  const uint64_t target = counter + static_cast<uint32_t>(leadUs);
  disablePlanAlarm();
  TIMERG0.hw_timer[1].alarm_high = static_cast<uint32_t>(target >> 32);
  TIMERG0.hw_timer[1].alarm_low = static_cast<uint32_t>(target);
  TIMERG0.int_clr_timers.t1 = 1;
  TIMERG0.hw_timer[1].config.alarm_en = 1;
  return true;
}

// Hardware timer ISR is a timing-only witness; it never drives DE, UART TX,
// or a GPIO. Four predicted slot starts are measured in this safe dry run.
void IRAM_ATTR planSlotIsr() {
  disablePlanAlarm();
  if (!planRequested) return;
  const uint32_t nowUs = static_cast<uint32_t>(esp_timer_get_time());
  (void)bPlan.onTimer(nowUs);
}

// IDF4.4 UART2 raw FIFO access. With RX full threshold 1, each interrupt
// timestamps its byte after stop bit completion, BEFORE any USB logging.
// If interrupt latency coalesces bytes, the capture is marked untrustworthy;
// the code never fabricates individual completion times from a FIFO batch.
void IRAM_ATTR cartRxIsr(void*) {
  const uint32_t status = UART2.int_st.val;
  if (status & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++uartErrors;  // parity/framing/overflow/timeout: fail the capture
  }
  const uint32_t n = UART2.status.rxfifo_cnt;
  if (n > 1) ++coalescedInterrupts;
  if (planRequested && (uartErrors || coalescedInterrupts)) {
    bPlan.abort(cart_b_plan::Reason::RxCompromised);
    disablePlanAlarm();
  }
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t byteValue = static_cast<uint8_t>(UART2.fifo.rw_byte);
    const uint32_t atUs = static_cast<uint32_t>(esp_timer_get_time());
    const uint32_t index = eventCount;
    if (index < kEventLimit) {
      events[index].completeUs = atUs;
      events[index].octet = byteValue;
      eventCount = index + 1;
    } else {
      ++overLimitEvents;
    }
    if (planRequested && bPlan.stage != cart_b_plan::Stage::Failed &&
        bPlan.stage != cart_b_plan::Stage::Complete) {
      if (uartErrors || coalescedInterrupts || overLimitEvents || index >= kEventLimit) {
        bPlan.abort(cart_b_plan::Reason::RxCompromised);
        disablePlanAlarm();
      } else {
        const cart_b_plan::Outcome result = bPlan.onByte(byteValue, atUs);
        if (result == cart_b_plan::Outcome::ScheduleSlot) {
          const uint8_t wordIndex = bPlan.scheduled - 1;
          if (!armPlanAlarm(bPlan.dueUs[wordIndex])) {
            bPlan.abort(cart_b_plan::Reason::TimerTooLate);
            disablePlanAlarm();
          }
        } else if (result == cart_b_plan::Outcome::Rejected) {
          disablePlanAlarm();
        }
      }
    }
  }
  UART2.int_clr.val = status;
}

bool begin2400() {
  driverOff();
  dcl.setRxBufferSize(256);
  dcl.begin(2400, SERIAL_8N2, kRx, kTx);
  dcl.onReceiveError(onSerialError);
  serialUartActive = true;
  return deadlineTimer != nullptr;
}

void end2400() {
  driverOff();
  if (serialUartActive) dcl.end();
  serialUartActive = false;
  pinMode(kTx, INPUT);
}

bool txReference11(const uint8_t (&frame)[11], const char* name) {
  driverOff();
  if (!deadlineTimer || uartErrors || digitalRead(kRx) != HIGH) {
    Serial.print(F("ABORT_PRECHECK frame=")); Serial.println(name);
    return false;
  }
  // Timer0 uses an 80:1 divider for microsecond timeout, independently of
  // serial/USB task scheduling. Arm it before asserting DE.
  txCutoff = false;
  timerWrite(deadlineTimer, 0);
  timerAlarmEnable(deadlineTimer);
  gpio_set_level(kDe, 1);
  delayMicroseconds(20);
  const size_t written = dcl.write(frame, sizeof(frame));
  dcl.flush();
  driverOff();
  timerAlarmDisable(deadlineTimer);
  Serial.print(F("REF_TX frame=")); Serial.print(name);
  Serial.print(F(" bytes=")); Serial.print(written);
  Serial.print(F(" cutoff=")); Serial.println(txCutoff ? 1 : 0);
  return written == sizeof(frame) && !txCutoff && uartErrors == 0;
}

bool candidateAck() {
  uint8_t response[16] = {};
  size_t n = 0;
  const uint32_t started = millis();
  uint32_t lastRxMs = started;
  while (millis() - started < kAckWindowMs) {
    while (dcl.available()) {
      const int value = dcl.read();
      if (value < 0 || n >= sizeof(response)) {
        Serial.println(F("ACK_REJECT overflow"));
        return false;
      }
      response[n++] = static_cast<uint8_t>(value);
      lastRxMs = millis();
    }
    if (n >= 12 && millis() - lastRxMs >= kAckQuietMs) break;
    delay(1);
  }
  Serial.print(F("REF_ACK bytes=")); Serial.print(n);
  Serial.print(F(" raw="));
  for (size_t i = 0; i < n; ++i) {
    if (i) Serial.print(' ');
    printHex(response[i]);
  }
  Serial.println();
  const bool pass = n == 12 && std::memcmp(response, kEchoId, 11) == 0 &&
      response[11] == 0x01 && uartErrors == 0;
  Serial.println(pass ? F("ACK_CANDIDATE origin=UNVERIFIED") : F("ACK_REJECT exact_echo_plus_01_required"));
  return pass;
}

bool beginRaw9600() {
  end2400();
  eventCount = 0;
  coalescedInterrupts = 0;
  overLimitEvents = 0;
  uartErrors = 0;
  bPlan = cart_b_plan::FourWordDryRun();
  if (planTimer) timerAlarmDisable(planTimer);
  const uart_config_t config = {
      .baud_rate = 9600,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .rx_flow_ctrl_thresh = 0,
      .source_clk = UART_SCLK_APB,
  };
  if (uart_param_config(UART_NUM_2, &config) != ESP_OK ||
      uart_set_pin(UART_NUM_2, UART_PIN_NO_CHANGE, kRx,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  UART2.int_ena.val = 0;
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.rxfifo_rst = 1;
  UART2.conf0.rxfifo_rst = 0;
  UART2.conf1.rxfifo_full_thrhd = 1;
  // dcl.end() has deleted Arduino's UART driver. IDF uart_isr_register()
  // dereferences that deleted driver's p_uart_obj (the actual observed
  // StoreProhibited PC=uart_isr_register after GO_CART). Register the bare
  // UART2 hardware interrupt instead, independently of IDF UART driver state.
  // This receiver intentionally owns RX FIFO and its interrupt status.
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &cartRxIsr, nullptr, &rawUartHandle) != ESP_OK) return false;
  rawUartActive = true;
  UART2.int_ena.rxfifo_full = 1;
  UART2.int_ena.rxfifo_ovf = 1;
  UART2.int_ena.frm_err = 1;
  UART2.int_ena.parity_err = 1;
  return true;
}

void endRaw9600() {
  driverOff();
  if (planTimer) timerAlarmDisable(planTimer);
  UART2.int_ena.val = 0;
  if (rawUartActive && rawUartHandle) (void)esp_intr_free(rawUartHandle);
  rawUartHandle = nullptr;
  rawUartActive = false;
}

void reportDryRunPlan() {
  if (!planRequested) return;
  Serial.print(F("CART_B_PLAN stage="));
  switch (bPlan.stage) {
    case cart_b_plan::Stage::SeekId0: Serial.print(F("SEEK")); break;
    case cart_b_plan::Stage::Baseline: Serial.print(F("BASELINE")); break;
    case cart_b_plan::Stage::CommandCycle: Serial.print(F("COMMAND_CYCLE")); break;
    case cart_b_plan::Stage::Complete: Serial.print(F("COMPLETE")); break;
    case cart_b_plan::Stage::Failed: Serial.print(F("FAILED")); break;
  }
  Serial.print(F(" reason=")); Serial.print(static_cast<unsigned>(bPlan.reason));
  Serial.print(F(" baseline_frames=")); Serial.print(bPlan.baselineFrames);
  Serial.print(F(" command_frames=")); Serial.print(bPlan.commandFrames);
  Serial.print(F(" phase_bits=")); Serial.print(bPlan.headerPhaseBits);
  Serial.print(F(" scheduled=")); Serial.print(bPlan.scheduled);
  Serial.print(F(" fired=")); Serial.print(bPlan.fired);
  Serial.println(F(" mode=DRY_RUN tx_bytes=0 ecu_verified=0"));
  for (uint8_t i = 0; i < bPlan.scheduled && i < 4; ++i) {
    const cart_b_plan::Word word = cart_b_plan::wordForFrame(i);
    Serial.print(F("CART_B_SLOT frame=")); Serial.print(i);
    Serial.print(F(" slot=1 opcode=")); printHex(word.first); printHex(word.second);
    Serial.print(F(" target_us=")); Serial.print(bPlan.dueUs[i]);
    Serial.print(F(" fired_us=")); Serial.print(bPlan.firedUs[i]);
    Serial.println(F(" dry_run=1 tx_bytes=0"));
  }
}

void reportIdOnlyBaseline(uint32_t n) {
  // Strict, deliberately narrow diagnostic of the observed ID-only stream.
  // Presence of slot words requires off-device timed parsing. No scanner TX
  // is authorized by this counter, even after many correct 16-ID cycles.
  if (n < 128 || n >= kEventLimit || (n & 3) || uartErrors || coalescedInterrupts ||
      overLimitEvents) {
    Serial.println(F("CART_BASELINE id_only_cycles=0 validated=0"));
    return;
  }
  uint8_t wanted = 0;
  int8_t headerPhaseBits = -1;
  uint32_t frames = 0;
  uint32_t previousSyncUs = 0;
  for (uint32_t i = 0; i < n; i += 4) {
    const RxEvent& a = events[i];
    const RxEvent& b = events[i + 1];
    const RxEvent& c = events[i + 2];
    const RxEvent& d = events[i + 3];
    if (a.octet || b.octet || d.octet != vParity(c.octet, wanted)) break;
    const uint32_t dtA = b.completeUs - a.completeUs;
    const uint32_t dtB = c.completeUs - b.completeUs;
    const uint32_t dtC = d.completeUs - c.completeUs;
    const int8_t phase = dtB >= 867 && dtB <= 1217 ? 0 :
        (dtB >= 1283 && dtB <= 1633 ? 4 : -1);
    if (dtA < 867 || dtA > 1217 || phase < 0 ||
        dtC < 867 || dtC > 1217 ||
        (headerPhaseBits >= 0 && phase != headerPhaseBits)) break;
    headerPhaseBits = phase;
    if (frames) {
      const uint32_t frameGapUs = b.completeUs - previousSyncUs;
      if (frameGapUs < 9825 || frameGapUs > 10175) break;
    }
    previousSyncUs = b.completeUs;
    wanted = (wanted + 1) & 15;
    ++frames;
  }
  Serial.print(F("CART_BASELINE id_only_cycles=")); Serial.print(frames / 16);
  Serial.print(F(" id_only_frames=")); Serial.print(frames);
  Serial.print(F(" header_phase_bits=")); Serial.print(headerPhaseBits);
  Serial.print(F(" validated="));
  Serial.println(frames >= 32 && frames == n / 4 && !(frames % 16) ? 1 : 0);
}

void dumpCapture() {
  const uint32_t captured = eventCount;
  Serial.print(F("CART_CAPTURE n=")); Serial.print(captured);
  Serial.print(F(" uart_errors=")); Serial.print(uartErrors);
  Serial.print(F(" coalesced=")); Serial.print(coalescedInterrupts);
  Serial.print(F(" overflow=")); Serial.print(overLimitEvents);
  Serial.print(F(" cutoff=")); Serial.print(txCutoff ? 1 : 0);
  Serial.print(F(" capped=")); Serial.println(captured >= kEventLimit ? 1 : 0);
  reportDryRunPlan();
  reportIdOnlyBaseline(captured);
  Serial.println(F("CART_TIMEBASE source=UART2_RX_ISR unit=us event=FIFO_interrupt_after_stop_bit"));
  for (uint32_t i = 0; i < captured; ++i) {
    Serial.print(F("CART_EVT t_us="));
    Serial.print(events[i].completeUs);
    Serial.print(F(" byte=")); printHex(events[i].octet);
    Serial.println();
  }
  Serial.println(F("CART_END DTC_UNVERIFIED B_TX_LOCKED"));
}

void captureOnce(bool withDryRunPlan) {
  attemptUsed = true;  // consume before any handshake TX
  planRequested = withDryRunPlan;
  uartErrors = 0;
  driverOff();
  if (!begin2400() || (planRequested && !planTimer)) {
    end2400();
    Serial.println(F("ABORT timer_initialization_failed"));
    return;
  }
  while (dcl.available()) (void)dcl.read();
  if (!txReference11(kEchoId, "ECHO_ID") || !candidateAck() ||
      !txReference11(kGoCart, "GO_CART")) {
    end2400();
    Serial.println(F("CART_ABORT handshake_or_ack_failed TX_LOCKED"));
    return;
  }
  if (!beginRaw9600()) {
    endRaw9600();
    Serial.println(F("CART_ABORT UART_ISR_INITIALIZATION_FAILED TX_LOCKED"));
    return;
  }
  const uint32_t begun = millis();
  // USB output happens AFTER disabling the RX ISR. This loop never emits
  // bus data or yields a software-scheduled UART transmit opportunity.
  while (millis() - begun < kCaptureMs) {
    if (eventCount >= kEventLimit || uartErrors || overLimitEvents || coalescedInterrupts) break;
    if (planRequested && (bPlan.stage == cart_b_plan::Stage::Failed ||
                          bPlan.stage == cart_b_plan::Stage::Complete)) break;
    delay(1);
  }
  endRaw9600();
  Serial.println(F("CART_BEGIN recorded_9600_8N1 RX_ISR duration_ms_max=10000 B_TX=OFF"));
  dumpCapture();
}

void selftestRawReceiver() {
  // USB-side, zero DCL TX: exercise the exact post-handshake UART driver
  // release -> native ISR registration path, including cleanup.
  driverOff();
  if (!beginRaw9600()) {
    endRaw9600();
    Serial.println(F("RAW_ISR_SELFTEST FAIL irq=UNAVAILABLE B_TX_LOCKED"));
    return;
  }
  delay(40);
  endRaw9600();
  Serial.print(F("RAW_ISR_SELFTEST PASS irq=READY rx_events="));
  Serial.print(eventCount);
  Serial.print(F(" uart_errors="));
  Serial.print(uartErrors);
  Serial.println(F(" B_TX_LOCKED"));
}

void help() {
  Serial.println(F("COMMANDS STATUS | HELP | SELFTEST_RX_ISR | CAPTURE_CART_ONCE | PLAN_B_ONCE | READ_B_ONCE | STOP"));
  Serial.println(F("SELFTEST_RX_ISR initializes post-Arduino UART2 RX interrupt without bus TX"));
  Serial.println(F("CAPTURE_CART_ONCE explicitly runs EchoID/strict ACK/GoCART then 10s ISR RX logging"));
  Serial.println(F("READ_B_ONCE is compile-time locked: reference B=26A4 vs 260E, block/slot and DE unknown"));
  Serial.println(F("PLAN_B_ONCE uses one baseline ID0..15, then hardware ISR dry-runs 4 slot1 words ID0..3, zero B TX"));
  Serial.println(F("No DTC TX, clear, KOEO, actuator, arbitrary TX or repeat attempts"));
}

void command() {
  if (!std::strcmp(commandLine, "HELP")) help();
  else if (!std::strcmp(commandLine, "STATUS")) {
    driverOff();
    Serial.print(F("STATUS SME105_DTC_ONE_SHOT_V2 DE=LOW B_TX=COMPILE_LOCKED used="));
    Serial.print(attemptUsed ? 1 : 0);
    Serial.print(F(" deadline_timer=")); Serial.println(deadlineTimer ? 1 : 0);
  } else if (!std::strcmp(commandLine, "SELFTEST_RX_ISR")) {
    selftestRawReceiver();
  } else if (!std::strcmp(commandLine, "CAPTURE_CART_ONCE")) {
    if (attemptUsed) Serial.println(F("DENIED already_consumed_this_boot"));
    else captureOnce(false);
  } else if (!std::strcmp(commandLine, "PLAN_B_ONCE")) {
    if (attemptUsed) Serial.println(F("DENIED already_consumed_this_boot"));
    else captureOnce(true);
  } else if (!std::strcmp(commandLine, "READ_B_ONCE")) {
    Serial.print(F("DENIED B_TX_COMPILE_LOCKED. Reference "));
    printHex(kBReferenceFlx[0]); printHex(kBReferenceFlx[1]);
    Serial.print(F(" conflicts_with "));
    printHex(kBReferenceDon[0]); printHex(kBReferenceDon[1]);
    Serial.println(F("; no complete verified 4-frame command block or collision-free slot timing"));
  } else if (!std::strcmp(commandLine, "STOP")) {
    driverOff();
    Serial.println(F("STOP DE_LOW"));
  } else if (commandLine[0]) Serial.println(F("DENIED unknown_command"));
}
}  // namespace

void setup() {
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  driverOff();
  pinMode(kTx, INPUT);
  pinMode(19, INPUT);
  Serial.begin(kUsbBaud);
  deadlineTimer = timerBegin(0, 80, true);
  if (deadlineTimer) {
    timerAttachInterrupt(deadlineTimer, &cutoffIsr, true);
    timerAlarmWrite(deadlineTimer, kTxDeadlineUs, false);
    timerAlarmDisable(deadlineTimer);
  }
  planTimer = timerBegin(2, 80, true);
  if (planTimer) {
    timerAttachInterruptFlag(planTimer, &planSlotIsr, false, ESP_INTR_FLAG_IRAM);
    timerAlarmDisable(planTimer);
  }
  delay(250);
  Serial.println(F("SME105_DTC_ONE_SHOT_V2 NO_AUTO_TX B_OPCODE_DISABLED"));
  help();
}

void loop() {
  while (Serial.available() > 0) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (lineLength) {
        commandLine[lineLength] = 0;
        command();
        lineLength = 0;
        commandLine[0] = 0;
      }
    } else if (ch >= ' ' && ch <= '~' && lineLength < sizeof(commandLine) - 1) {
      commandLine[lineLength++] = ch;
    } else {
      lineLength = 0;
      commandLine[0] = 0;
      Serial.println(F("DENIED command_input_overflow_or_invalid"));
    }
  }
}
