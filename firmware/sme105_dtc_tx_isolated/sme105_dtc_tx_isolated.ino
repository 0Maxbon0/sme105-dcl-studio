#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/rmt.h>
#include <driver/uart.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <freertos/ringbuf.h>
#include <soc/gpio_struct.h>
#include <soc/gpio_sig_map.h>
#include <soc/rmt_struct.h>
#include <soc/timer_group_struct.h>
#include <soc/uart_struct.h>
#include <esp32/rom/gpio.h>
#include <cstring>

// Standalone 3.3V GPIO bench, not a vehicle application.
// Four deliberately NON-CART sample pairs. No ECHO_ID, GO_CART or B request.
#if !defined(SME105_VEHICLE_TX) || SME105_VEHICLE_TX != 0
#error "This bench must never be compiled with vehicle transmission enabled"
#endif

namespace {
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr int kTx = 17;
constexpr int kExternalEcho = 16;
constexpr int kExternalDeSense = 19;
constexpr uint32_t kCutoffUs = 2250;
constexpr uint32_t kSlotSpacingUs = 10000;
constexpr uint32_t kSlotLeadUs = 500;
constexpr uint32_t kWordTimeoutUs = 3600;
constexpr int kWords = 4;
DRAM_ATTR uint8_t samples[kWords][2] = {{0x55, 0xAA}, {0x33, 0xCC},
                                          {0x0F, 0xF0}, {0x69, 0x96}};

struct WordWitness {
  uint32_t targetUs = 0;
  volatile uint32_t firedUs = 0;
  volatile uint32_t txDoneUs = 0;
  volatile uint32_t echoAtUs[2] = {};
  volatile uint8_t received[2] = {};
  volatile uint8_t receivedCount = 0;
  volatile uint8_t txDoneCount = 0;
  volatile uint8_t error = 0;
  volatile uint8_t cutoff = 0;
  uint32_t deRmtHighUs = 0;
  uint32_t deRmtItems = 0;
  uint32_t txRmtItems = 0;
  uint32_t txRmtEdges = 0;
};

WordWitness witness[kWords];
volatile int activeWord = -1;
volatile bool stopped = false;
volatile bool oneShotUsed = false;
volatile uint32_t irqErrors = 0;
volatile uint32_t irqRxCoalesced = 0;
volatile bool rmtSlotOnly = false;
volatile uint32_t rmtSlotFiredUs = 0;
hw_timer_t* cutoff = nullptr;
hw_timer_t* slot = nullptr;
intr_handle_t uartHandle = nullptr;
RingbufHandle_t txRing = nullptr;
RingbufHandle_t deRing = nullptr;
bool rmtReady = false;
bool rmtTxReady = false;
bool uartReady = false;
bool internalMode = true;
char line[48] = {};
uint8_t lineLen = 0;

void IRAM_ATTR deLow() {
  // Force low even if autonomous RMT output is currently HIGH: route the pad
  // back to software GPIO. The RMT waveform also has its own finite duration.
  GPIO.out_w1tc = 1UL << 18;
  GPIO.func_out_sel_cfg[18].func_sel = SIG_GPIO_OUT_IDX;
}
void IRAM_ATTR stopAlarms() {
  TIMERG0.hw_timer[0].config.alarm_en = 0;
  TIMERG0.hw_timer[1].config.alarm_en = 0;
}
void IRAM_ATTR abortNow(uint8_t code) {
  deLow();
  stopAlarms();
  UART1.int_ena.tx_done = 0;
  if (activeWord >= 0 && activeWord < kWords)
    witness[activeWord].error = code;
  stopped = true;
}
bool IRAM_ATTR armGroupTimer(uint8_t timerNumber, uint32_t deltaUs) {
  if (timerNumber > 1 || !deltaUs) return false;
  TIMERG0.hw_timer[timerNumber].config.alarm_en = 0;
  TIMERG0.hw_timer[timerNumber].update = 1;
  const uint64_t now =
      (static_cast<uint64_t>(TIMERG0.hw_timer[timerNumber].cnt_high) << 32) |
      TIMERG0.hw_timer[timerNumber].cnt_low;
  const uint64_t target = now + deltaUs;
  TIMERG0.hw_timer[timerNumber].alarm_high = static_cast<uint32_t>(target >> 32);
  TIMERG0.hw_timer[timerNumber].alarm_low = static_cast<uint32_t>(target);
  if (timerNumber == 0) TIMERG0.int_clr_timers.t0 = 1;
  else TIMERG0.int_clr_timers.t1 = 1;
  TIMERG0.hw_timer[timerNumber].config.alarm_en = 1;
  return true;
}
void IRAM_ATTR cutoffISR() {
  // CPU interrupt, NOT a separate hardware electrical interlock.
  deLow();
  TIMERG0.hw_timer[0].config.alarm_en = 0;
  if (activeWord >= 0 && activeWord < kWords) {
    witness[activeWord].cutoff = 1;
    abortNow(7);
  }
}
void IRAM_ATTR slotISR() {
  TIMERG0.hw_timer[1].config.alarm_en = 0;
  if (rmtSlotOnly) {
    rmtSlotFiredUs = static_cast<uint32_t>(esp_timer_get_time());
    // The RMT pulse was filled in task context before the timer alarm. The
    // ISR only advances the RMT hardware RAM read pointer and starts TX.
    RMT.conf_ch[2].conf1.mem_rd_rst = 1;
    RMT.conf_ch[2].conf1.mem_rd_rst = 0;
    RMT.conf_ch[2].conf1.tx_start = 1;
    rmtSlotOnly = false;
    return;
  }
  const int index = activeWord;
  if (stopped || index < 0 || index >= kWords ||
      UART1.status.txfifo_cnt != 0 || !cutoff || !rmtTxReady ||
      !armGroupTimer(0, kCutoffUs)) {
    abortNow(2);
    return;
  }
  WordWitness& w = witness[index];
  w.firedUs = static_cast<uint32_t>(esp_timer_get_time());
  // Arm the CPU cutoff BEFORE enabling the output driver.
  UART1.int_clr.tx_done = 1;
  UART1.int_ena.tx_done = 1;
  // RMT is a hardware one-shot ~2180us HIGH then idle LOW. The timer ISR
  // only starts it; even if UART IRQ or CPU stalls, the peripheral drops DE.
  GPIO.func_out_sel_cfg[18].func_sel = RMT_SIG_OUT2_IDX;
  RMT.conf_ch[2].conf1.mem_rd_rst = 1;
  RMT.conf_ch[2].conf1.mem_rd_rst = 0;
  RMT.conf_ch[2].conf1.tx_start = 1;
  // 2 bytes only, no writes on an interrupt or reset without USB command.
  UART1.fifo.rw_byte = samples[index][0];
  UART1.fifo.rw_byte = samples[index][1];
}
void IRAM_ATTR uartISR(void*) {
  const uint32_t pending = UART1.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++irqErrors;
    abortNow(3);
  }
  const uint32_t count = UART1.status.rxfifo_cnt;
  if (count > 1) {
    ++irqRxCoalesced;
    abortNow(4);
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t byte = static_cast<uint8_t>(UART1.fifo.rw_byte);
    const int index = activeWord;
    if (index < 0 || index >= kWords || stopped) {
      abortNow(5);
      continue;
    }
    WordWitness& w = witness[index];
    const uint8_t position = w.receivedCount;
    if (position >= 2 || byte != samples[index][position]) {
      abortNow(6);
      continue;
    }
    w.received[position] = byte;
    w.echoAtUs[position] = static_cast<uint32_t>(esp_timer_get_time());
    w.receivedCount = position + 1;
  }
  if (pending & (1UL << 14)) {
    deLow();
    TIMERG0.hw_timer[0].config.alarm_en = 0;
    UART1.int_ena.tx_done = 0;
    const int index = activeWord;
    if (index >= 0 && index < kWords && !stopped) {
      witness[index].txDoneUs = static_cast<uint32_t>(esp_timer_get_time());
      ++witness[index].txDoneCount;
    } else abortNow(8);
  }
  UART1.int_clr.val = pending;
}
void stopAll() {
  stopped = true;
  deLow();
  stopAlarms();
  UART1.int_ena.val = 0;
  UART1.conf0.txfifo_rst = 1;
  UART1.conf0.txfifo_rst = 0;
  activeWord = -1;
}
bool startUart(bool internal) {
  uartReady = false;
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
      uart_set_pin(UART_NUM_1, kTx, kExternalEcho,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK)
    return false;
  // The UART and RMT receivers sample the GPIO input matrix; never attach
  // any other physical output to GPIO17 or GPIO18 in internal bench mode.
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_INPUT_OUTPUT);
  if (internal) gpio_matrix_in(GPIO_NUM_17, U1RXD_IN_IDX, false);
  UART1.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1;
  UART1.conf0.rxfifo_rst = 0;
  UART1.conf0.txfifo_rst = 1;
  UART1.conf0.txfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1;
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM, uartISR,
                     nullptr, &uartHandle) != ESP_OK) return false;
  uartReady = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  return true;
}
void closeUart() {
  stopAll();
  if (uartReady && uartHandle) (void)esp_intr_free(uartHandle);
  uartHandle = nullptr;
  uartReady = false;
  pinMode(kTx, INPUT);
}
bool rmtChannel(rmt_channel_t channel, gpio_num_t pin,
                RingbufHandle_t* ring) {
  rmt_config_t config = {};
  config.rmt_mode = RMT_MODE_RX;
  config.channel = channel;
  config.gpio_num = pin;
  config.clk_div = 80; // 1us ticks, independently buffered edge durations
  config.mem_block_num = 1;
  config.rx_config.filter_en = false;
  config.rx_config.idle_threshold = 3000;
  return rmt_config(&config) == ESP_OK &&
      rmt_driver_install(channel, 1024, 0) == ESP_OK &&
      rmt_get_ringbuf_handle(channel, ring) == ESP_OK && *ring;
}
bool startRmt(bool internal) {
  txRing = nullptr;
  deRing = nullptr;
  // The sample is observed at a DISTINCT input pad. Sharing GPIO17 with RMT
  // input routing prevented UART TX from reaching the output on real ESP32.
  if (!rmtChannel(RMT_CHANNEL_0, GPIO_NUM_16, &txRing)) return false;
  if (!rmtChannel(RMT_CHANNEL_1, internal ? GPIO_NUM_18 : GPIO_NUM_19,
                  &deRing)) return false;
  // RMT RX init resets pad routing. Restore UART output signal routing, not
  // merely GPIO direction: the first hardware attempt measured DE correctly
  // but saw no GPIO17 edge or echo when UART mux was left overridden.
  if (uart_set_pin(UART_NUM_1, kTx, kExternalEcho,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK)
    return false;
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U1TXD_OUT_IDX, false, false);
  if (internal) gpio_matrix_in(GPIO_NUM_17, U1RXD_IN_IDX, false);
  if (internal) gpio_set_direction(GPIO_NUM_18, GPIO_MODE_INPUT_OUTPUT);
  // Prepare an autonomous DE safety window. No pulse is started here.
  rmt_config_t gate = {};
  gate.rmt_mode = RMT_MODE_TX;
  gate.channel = RMT_CHANNEL_2;
  gate.gpio_num = GPIO_NUM_18;
  gate.clk_div = 80;
  gate.mem_block_num = 1;
  gate.tx_config.loop_en = false;
  gate.tx_config.carrier_en = false;
  gate.tx_config.idle_output_en = true;
  gate.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  rmt_item32_t pulse = {};
  pulse.duration0 = 2180; pulse.level0 = 1;
  pulse.duration1 = 80; pulse.level1 = 0;
  if (rmt_config(&gate) != ESP_OK ||
      rmt_driver_install(RMT_CHANNEL_2, 0, 0) != ESP_OK) return false;
  rmtTxReady = true;
  if (rmt_fill_tx_items(RMT_CHANNEL_2, &pulse, 1, 0) != ESP_OK) return false;
  // Both receive channels stay on input-only GPIO16 and GPIO19.
  deLow();
  rmtReady = true;
  return true;
}
void closeRmt() {
  if (rmtTxReady) {
    deLow();
    (void)rmt_tx_stop(RMT_CHANNEL_2);
    (void)rmt_driver_uninstall(RMT_CHANNEL_2);
    rmtTxReady = false;
  }
  if (!rmtReady) return;
  (void)rmt_rx_stop(RMT_CHANNEL_0);
  (void)rmt_rx_stop(RMT_CHANNEL_1);
  (void)rmt_driver_uninstall(RMT_CHANNEL_0);
  (void)rmt_driver_uninstall(RMT_CHANNEL_1);
  rmtReady = false;
}
void captureRmt(rmt_channel_t ch, RingbufHandle_t ring, int index, bool de) {
  size_t bytes = 0;
  void* packet = nullptr;
  while ((packet = xRingbufferReceive(ring, &bytes, pdMS_TO_TICKS(12)))) {
    const size_t count = bytes / sizeof(rmt_item32_t);
    for (size_t i = 0; i < count; ++i) {
      const auto& item = static_cast<const rmt_item32_t*>(packet)[i];
      if (de) {
        witness[index].deRmtItems++;
        if (item.level0) witness[index].deRmtHighUs += item.duration0;
        if (item.level1) witness[index].deRmtHighUs += item.duration1;
      } else {
        witness[index].txRmtItems++;
        if (item.duration0) ++witness[index].txRmtEdges;
        if (item.duration1) ++witness[index].txRmtEdges;
      }
    }
    vRingbufferReturnItem(ring, packet);
    bytes = 0;
  }
  (void)ch;
}
void hexByte(uint8_t x) {
  if (x < 16) Serial.print('0');
  Serial.print(x, HEX);
}
void printReport(bool ok, int completed) {
  Serial.print(F("BENCH_END result="));
  Serial.print(ok ? F("PASS_GPIO_JUMPERS_ONLY") : F("FAIL_CLOSED"));
  Serial.print(F(" completed=")); Serial.print(completed);
  Serial.print(F(" irq_errors=")); Serial.print(irqErrors);
  Serial.print(F(" coalesced=")); Serial.print(irqRxCoalesced);
  Serial.println(F(" B_TX=0 ECU_TX=0 no_auto_retry=1 de_mode=RMT_AUTONOMOUS"));
  for (int i = 0; i < kWords; ++i) {
    const WordWitness& w = witness[i];
    Serial.print(F("WORD index=")); Serial.print(i);
    Serial.print(F(" sample=")); hexByte(samples[i][0]); hexByte(samples[i][1]);
    Serial.print(F(" target_us=")); Serial.print(w.targetUs);
    Serial.print(F(" fired_us=")); Serial.print(w.firedUs);
    Serial.print(F(" done_us=")); Serial.print(w.txDoneUs);
    Serial.print(F(" echo_count=")); Serial.print(w.receivedCount);
    Serial.print(F(" echo0_us=")); Serial.print(w.echoAtUs[0]);
    Serial.print(F(" echo1_us=")); Serial.print(w.echoAtUs[1]);
    Serial.print(F(" tx_done_count=")); Serial.print(w.txDoneCount);
    Serial.print(F(" cutoff=")); Serial.print(w.cutoff);
    Serial.print(F(" error=")); Serial.print(w.error);
    Serial.print(F(" de_rmt_high_us=")); Serial.print(w.deRmtHighUs);
    Serial.print(F(" de_rmt_items=")); Serial.print(w.deRmtItems);
    Serial.print(F(" tx_rmt_items=")); Serial.print(w.txRmtItems);
    Serial.print(F(" tx_rmt_edges=")); Serial.println(w.txRmtEdges);
  }
  Serial.println(F("LIMITS RMT_samples_gpio_pad_only no_RS485_voltage no_collision_proof cutoff_CPU_ISR_only"));
}
bool verifyPhysicalJumpers() {
  // Two distinct input pads must follow BOTH logic levels before any UART
  // FIFO write. No UART opcode is transmitted here. Desk-only: GPIO18 is
  // pulsed HIGH for a few microseconds, so never call with vehicle attached.
  deLow();
  pinMode(kTx, OUTPUT);
  digitalWrite(kTx, HIGH);
  delayMicroseconds(25);
  const bool txHigh = digitalRead(kExternalEcho) == HIGH;
  digitalWrite(kTx, LOW);
  delayMicroseconds(25);
  const bool txLow = digitalRead(kExternalEcho) == LOW;
  digitalWrite(kTx, HIGH);
  const bool deLowSeen = digitalRead(kExternalDeSense) == LOW;
  GPIO.out_w1ts = 1UL << 18;
  delayMicroseconds(35);
  const bool deHighSeen = digitalRead(kExternalDeSense) == HIGH;
  deLow();
  delayMicroseconds(15);
  const bool deReleased = digitalRead(kExternalDeSense) == LOW;
  pinMode(kTx, INPUT);
  Serial.print(F("JUMPER_CHECK tx_high=")); Serial.print(txHigh ? 1 : 0);
  Serial.print(F(" tx_low=")); Serial.print(txLow ? 1 : 0);
  Serial.print(F(" de_low=")); Serial.print(deLowSeen ? 1 : 0);
  Serial.print(F(" de_high=")); Serial.print(deHighSeen ? 1 : 0);
  Serial.print(F(" de_release=")); Serial.print(deReleased ? 1 : 0);
  Serial.println(F(" uart_bytes=0"));
  return txHigh && txLow && deLowSeen && deHighSeen && deReleased;
}
bool run(bool internal) {
  oneShotUsed = true;
  internalMode = internal;
  stopped = false;
  irqErrors = irqRxCoalesced = 0;
  activeWord = -1;
  std::memset(witness, 0, sizeof(witness));
  deLow();
  if (!internal && !verifyPhysicalJumpers()) {
    Serial.println(F("BENCH_ABORT JUMPERS_NOT_VERIFIED no_uart_bytes=1 DE=LOW"));
    return false;
  }
  if (!cutoff || !slot || !startUart(internal)) {
    Serial.println(F("BENCH_ABORT UART_OR_TIMER_INIT"));
    closeUart(); return false;
  }
  if (!startRmt(internal)) {
    Serial.println(F("BENCH_ABORT RMT_INIT"));
    closeUart(); closeRmt(); return false;
  }
  // External mode requires a real 1k jumper 17->16 and 18->19.
  // This precheck NEVER asserts DE or sends UART bytes.
  if (digitalRead(internal ? kTx : kExternalEcho) != HIGH ||
      ( !internal && digitalRead(kExternalDeSense) != LOW)) {
    Serial.println(F("BENCH_ABORT ECHO_OR_DE_SENSE_NOT_IDLE"));
    closeUart(); closeRmt(); return false;
  }
  Serial.println(internal ? F("BENCH_BEGIN mode=INTERNAL_GPIO_MATRIX no_vehicle=1") :
                            F("BENCH_BEGIN mode=EXTERNAL_JUMPER no_vehicle=1"));
  const uint32_t epoch = static_cast<uint32_t>(esp_timer_get_time()) + 5000;
  int completed = 0;
  for (int i = 0; i < kWords && !stopped; ++i) {
    WordWitness& w = witness[i];
    w.targetUs = epoch + i * kSlotSpacingUs;
    // Start hardware edge sampling before each timed 2-byte emission.
    if (rmt_rx_start(RMT_CHANNEL_0, true) != ESP_OK ||
        rmt_rx_start(RMT_CHANNEL_1, true) != ESP_OK) {
      w.error = 9; stopped = true; break;
    }
    while (static_cast<int32_t>(w.targetUs - static_cast<uint32_t>(esp_timer_get_time())) > static_cast<int32_t>(kSlotLeadUs)) {
      if (Serial.available()) { stopped = true; w.error = 10; break; }
      const int32_t lead = static_cast<int32_t>(w.targetUs - static_cast<uint32_t>(esp_timer_get_time()));
      if (lead > 2200) delay(1);
      else delayMicroseconds(25);
    }
    if (stopped) break;
    activeWord = i;
    const int32_t remaining = static_cast<int32_t>(w.targetUs - static_cast<uint32_t>(esp_timer_get_time()));
    if (remaining < 250 || remaining > 1250 ||
        !armGroupTimer(1, static_cast<uint32_t>(remaining))) {
      w.error = 11; stopped = true; break;
    }
    const uint32_t timeout = w.targetUs + kWordTimeoutUs;
    while (!stopped && !w.txDoneCount &&
           static_cast<int32_t>(timeout - static_cast<uint32_t>(esp_timer_get_time())) > 0) {
      if (Serial.available()) { abortNow(10); break; }
      delayMicroseconds(20);
    }
    if (!stopped && !w.txDoneCount) abortNow(12);
    if (!stopped && (w.receivedCount != 2 || w.txDoneCount != 1 ||
        (w.txDoneUs - w.firedUs) < 1900 ||
        (w.txDoneUs - w.firedUs) >= kCutoffUs)) abortNow(13);
    deLow();
    TIMERG0.hw_timer[0].config.alarm_en = 0;
    // Wait for RMT 3ms idle threshold after DE/TX transitions.
    delay(4);
    (void)rmt_rx_stop(RMT_CHANNEL_0);
    (void)rmt_rx_stop(RMT_CHANNEL_1);
    captureRmt(RMT_CHANNEL_0, txRing, i, false);
    captureRmt(RMT_CHANNEL_1, deRing, i, true);
    // RMT high duration and pad edges are NOT independent external bus proof.
    if (!stopped && (w.deRmtHighUs < 1950 ||
        w.deRmtHighUs >= kCutoffUs || w.deRmtItems == 0 ||
        w.txRmtEdges < 8)) {
      w.error = 14; stopped = true;
    }
    activeWord = -1;
    if (!stopped) ++completed;
  }
  const bool pass = completed == kWords && !stopped && irqErrors == 0 &&
                    irqRxCoalesced == 0 && digitalRead(kDe) == LOW;
  closeUart();
  closeRmt();
  printReport(pass, completed);
  return pass;
}
bool runAutonomousDe(bool fromSlotTimer) {
  // Deliberately NO UART initialization or TX. Output is one 2180us hardware
  // RMT pulse and hard idle-low; the task then sleeps beyond pulse duration.
  // This does not imply the ECU's differential bus is safe.
  oneShotUsed = true;
  deLow();
  rmtSlotOnly = false;
  rmtSlotFiredUs = 0;
  RingbufHandle_t sense = nullptr;
  bool rxInstalled = false;
  bool txInstalled = false;
  bool good = false;
  uint32_t highUs = 0;
  uint32_t count = 0;
  uint32_t padHighUs = 0;
  uint32_t outMux = 0;
  if (rmtChannel(RMT_CHANNEL_1, GPIO_NUM_18, &sense)) {
    rxInstalled = true;
    rmt_config_t config = {};
    config.rmt_mode = RMT_MODE_TX;
    config.channel = RMT_CHANNEL_2;
    config.gpio_num = GPIO_NUM_18;
    config.clk_div = 80;
    config.mem_block_num = 1;
    config.tx_config.loop_en = false;
    config.tx_config.carrier_en = false;
    config.tx_config.idle_output_en = true;
    config.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
    if (rmt_config(&config) == ESP_OK &&
        rmt_driver_install(RMT_CHANNEL_2, 0, 0) == ESP_OK) {
      txInstalled = true;
      gpio_set_direction(GPIO_NUM_18, GPIO_MODE_INPUT_OUTPUT);
      // RX channel pin initialization may overwrite the shared pad route.
      // Explicitly route RMT TX channel 2 to the output matrix after both
      // drivers have finished their GPIO setup.
      gpio_matrix_out(GPIO_NUM_18, RMT_SIG_OUT2_IDX, false, false);
      outMux = GPIO.func_out_sel_cfg[18].func_sel;
      rmt_item32_t pulse = {};
      pulse.duration0 = 2180;
      pulse.level0 = 1;
      pulse.duration1 = 80;
      pulse.level1 = 0;
      bool launched = false;
      if (rmt_rx_start(RMT_CHANNEL_1, true) == ESP_OK) {
        if (fromSlotTimer && slot &&
            rmt_fill_tx_items(RMT_CHANNEL_2, &pulse, 1, 0) == ESP_OK) {
          rmtSlotOnly = true;
          launched = armGroupTimer(1, 2500);
        } else if (!fromSlotTimer) {
          launched = rmt_write_items(RMT_CHANNEL_2, &pulse, 1, false) == ESP_OK;
        }
      }
      if (launched) {
        // GPIO pad sampling is diagnostic only; the RMT peripheral owns its
        // output, and this CPU poll never writes or releases GPIO18.
        uint32_t rise = 0;
        uint32_t fall = 0;
        bool observedHigh = false;
        const uint32_t pollStart = static_cast<uint32_t>(esp_timer_get_time());
        while (static_cast<uint32_t>(esp_timer_get_time()) - pollStart < (fromSlotTimer ? 6800U : 3800U)) {
          const uint32_t at = static_cast<uint32_t>(esp_timer_get_time());
          const bool padHigh = (GPIO.in & (1UL << 18)) != 0;
          if (padHigh && !observedHigh) { observedHigh = true; rise = at; }
          if (!padHigh && observedHigh) { fall = at; break; }
        }
        if (rise && fall && fall >= rise) padHighUs = fall - rise;
        delay(5);
        (void)rmt_rx_stop(RMT_CHANNEL_1);
        size_t bytes = 0;
        void* packet = nullptr;
        while ((packet = xRingbufferReceive(sense, &bytes, pdMS_TO_TICKS(10)))) {
          const size_t n = bytes / sizeof(rmt_item32_t);
          for (size_t i = 0; i < n; ++i) {
            const rmt_item32_t& item = static_cast<const rmt_item32_t*>(packet)[i];
            if (item.level0) highUs += item.duration0;
            if (item.level1) highUs += item.duration1;
            ++count;
          }
          vRingbufferReturnItem(sense, packet);
          bytes = 0;
        }
        good = (!fromSlotTimer || rmtSlotFiredUs != 0) &&
            count > 0 && highUs >= 2110 && highUs < 2250 &&
            digitalRead(kDe) == LOW;
      }
    }
  }
  if (txInstalled) (void)rmt_driver_uninstall(RMT_CHANNEL_2);
  rmtSlotOnly = false;
  TIMERG0.hw_timer[1].config.alarm_en = 0;
  if (rxInstalled) {
    (void)rmt_rx_stop(RMT_CHANNEL_1);
    (void)rmt_driver_uninstall(RMT_CHANNEL_1);
  }
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  deLow();
  Serial.print(F("DE_AUTONOMOUS result="));
  Serial.print(good ? F("PASS_RMT_GPIO_PAD_ONLY") : F("FAIL_CLOSED"));
  Serial.print(F(" launch=")); Serial.print(fromSlotTimer ? F("ISR") : F("TASK"));
  Serial.print(F(" fired_us=")); Serial.print(rmtSlotFiredUs);
  Serial.print(F(" high_us=")); Serial.print(highUs);
  Serial.print(F(" rmt_items=")); Serial.print(count);
  Serial.print(F(" pad_poll_high_us=")); Serial.print(padHighUs);
  Serial.print(F(" mux=")); Serial.print(outMux);
  Serial.println(F(" commanded_us=2180 task_delay_ms=8 UART_TX=0 B_TX=0 ECU_TX=0 one_shot=1"));
  Serial.println(F("DE_LIMITS RMT_output_and_input_same_GPIO_not_external_bus_proof"));
  return good;
}
void respond() {
  if (!strcmp(line, "STATUS")) {
    deLow();
    Serial.print(F("STATUS SME105_TX_ISOLATED_V1 vehicle_tx=LOCKED DE=LOW used="));
    Serial.println(oneShotUsed ? 1 : 0);
  } else if (!strcmp(line, "BENCH_INTERNAL_ONCE")) {
    Serial.println(F("DENIED internal_loopback_not_physical_use_two_jumpers"));
  } else if (!strcmp(line, "BENCH_AUTONOMOUS_DE_ONCE")) {
    if (oneShotUsed) Serial.println(F("DENIED used; power-cycle for new bench"));
    else (void)runAutonomousDe(false);
  } else if (!strcmp(line, "BENCH_TIMED_RMT_DE_ONCE")) {
    if (oneShotUsed) Serial.println(F("DENIED used; power-cycle for new bench"));
    else (void)runAutonomousDe(true);
  } else if (!strcmp(line, "PIN_CHECK")) {
    deLow();
    Serial.print(F("PIN_CHECK tx_echo16=")); Serial.print(digitalRead(kExternalEcho));
    Serial.print(F(" de_sense19=")); Serial.print(digitalRead(kExternalDeSense));
    Serial.println(F(" DE=LOW no_tx=1 external_jumpers_needed=1"));
  } else if (!strcmp(line, "BENCH_JUMPERS_ONCE")) {
    if (oneShotUsed) Serial.println(F("DENIED used; power-cycle for new bench"));
    else (void)run(false);
  } else if (!strcmp(line, "STOP")) {
    stopAll();
    Serial.println(F("STOP DE=LOW TX=DISABLED"));
  } else if (line[0]) Serial.println(F("DENIED unknown_command"));
}
} // namespace
void setup() {
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  deLow();
  pinMode(kTx, INPUT);
  pinMode(kExternalEcho, INPUT_PULLDOWN);
  pinMode(kExternalDeSense, INPUT_PULLDOWN);
  Serial.begin(115200);
  cutoff = timerBegin(0, 80, true);
  slot = timerBegin(2, 80, true);
  if (cutoff) { timerAttachInterrupt(cutoff, cutoffISR, true); timerAlarmDisable(cutoff); }
  if (slot) { timerAttachInterrupt(slot, slotISR, true); timerAlarmDisable(slot); }
  delay(250);
  Serial.println(F("SME105_TX_ISOLATED_V1 NO_AUTO_TX NEVER_CONNECT_TO_ECU"));
}
void loop() {
  while (Serial.available()) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (lineLen) { line[lineLen] = '\0'; respond(); lineLen = 0; line[0] = 0; }
    } else if (c >= ' ' && c <= '~' && lineLen < sizeof(line) - 1) line[lineLen++] = c;
    else { lineLen = 0; line[0] = 0; Serial.println(F("DENIED invalid_input")); }
  }
}
