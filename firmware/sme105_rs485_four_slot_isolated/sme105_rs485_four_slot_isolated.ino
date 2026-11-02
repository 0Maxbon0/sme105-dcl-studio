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

// Isolated MAX487 -> XY-K485 differential RS485 DESK ONLY. NO CAR/ECU.
// Four deliberately NON-CART synthetic pairs. No ECHO_ID, GO_CART or B.
#if !defined(SME105_VEHICLE_TX) || SME105_VEHICLE_TX != 0
#error "This bench must never be compiled with vehicle transmission enabled"
#endif

namespace {
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr int kTx = 17;
constexpr int kMaxEcho = 16; // MAX487 RO via BSS138 5V->3.3V
constexpr int kOldEcho = 19; // XY-K485 RXD (already measured ~3.23V)
constexpr int kExternalDeSense = 21; // independent 1k jumper from DE GPIO18
constexpr uint32_t kCutoffUs = 2250;
constexpr uint32_t kSlotSpacingUs = 10000;
constexpr uint32_t kSlotLeadUs = 500;
constexpr uint32_t kWordTimeoutUs = 3600;
constexpr int kWords = 4;
DRAM_ATTR uint8_t samples[kWords][2] = {{0x55, 0xAA}, {0x33, 0xCC},
                                          {0x0F, 0xF0}, {0x69, 0x96}};
// Number of non-idle RMT level segments across two 9600 8N1 words.
// Deterministically derived from start, LSB-first data, and stop bits.
constexpr uint8_t kExpectedTxRmtSegments[kWords] = {17, 9, 5, 13};

struct WordWitness {
  uint32_t targetUs = 0;
  volatile uint32_t firedUs = 0;
  volatile uint32_t txDoneUs = 0;
  volatile uint32_t echoAtUs[2] = {};
  volatile uint32_t oldEchoAtUs[2] = {};
  volatile uint8_t received[2] = {};
  volatile uint8_t receivedCount = 0;
  volatile uint8_t oldReceived[2] = {};
  volatile uint8_t oldReceivedCount = 0;
  volatile uint8_t txDoneCount = 0;
  volatile uint8_t error = 0;
  volatile uint8_t cutoff = 0;
  volatile uint8_t unexpectedRx = 0;
  volatile uint8_t expectedRx = 0;
  volatile uint8_t rxPosition = 0;
  volatile uint32_t unexpectedAtUs = 0;
  volatile uint8_t faultUart = 0; // 0=NONE, 1=MAX UART1, 2=XY RMT6
  uint32_t deRmtHighUs = 0;
  uint32_t deRmtItems = 0;
  uint32_t txRmtItems = 0;
  uint32_t txRmtEdges = 0;
  rmt_item32_t txTrace[24] = {};
  uint8_t txTraceCount = 0;
  rmt_item32_t xyTrace[24] = {};
  uint8_t xyTraceCount = 0;
  uint32_t xyRmtEdges = 0;
  uint8_t xyDecodeError = 0;
};

WordWitness witness[kWords];
volatile int activeWord = -1;
volatile bool stopped = false;
volatile bool oneShotUsed = false;
volatile uint32_t irqErrors = 0;
volatile uint32_t irqRxCoalesced = 0;
hw_timer_t* cutoff = nullptr;
hw_timer_t* slot = nullptr;
intr_handle_t uartHandle = nullptr;
intr_handle_t txUartHandle = nullptr;
RingbufHandle_t txRing = nullptr;
RingbufHandle_t deRing = nullptr;
RingbufHandle_t xyRing = nullptr;
bool rmtReady = false;
uint8_t rmtTxChannelsReady = 0;
bool uartReady = false;
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
  UART2.int_ena.tx_done = 0;
  if (activeWord >= 0 && activeWord < kWords && witness[activeWord].error == 0)
    witness[activeWord].error = code; // Preserve FIRST fault; later IRQ cannot mask it.
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
  const int index = activeWord;
  if (stopped || index < 0 || index >= kWords ||
      UART2.status.txfifo_cnt != 0 || !cutoff ||
      rmtTxChannelsReady != kWords ||
      !armGroupTimer(0, kCutoffUs)) {
    abortNow(2);
    return;
  }
  WordWitness& w = witness[index];
  w.firedUs = static_cast<uint32_t>(esp_timer_get_time());
  // Arm the CPU cutoff BEFORE enabling the output driver.
  UART2.int_clr.tx_done = 1;
  UART2.int_ena.tx_done = 1;
  // Four physically distinct, preloaded RMT TX channels 2..5: each can
  // fire only once, so no retrigger/rearm race across four 10ms slots.
  // RMT ends each 2180us HIGH pulse autonomously even if CPU stalls.
  const int gateChannel = 2 + index;
  GPIO.func_out_sel_cfg[18].func_sel = RMT_SIG_OUT2_IDX + index;
  RMT.conf_ch[gateChannel].conf1.mem_rd_rst = 1;
  RMT.conf_ch[gateChannel].conf1.mem_rd_rst = 0;
  RMT.conf_ch[gateChannel].conf1.tx_start = 1;
  // 2 bytes only, no writes on an interrupt or reset without USB command.
  UART2.fifo.rw_byte = samples[index][0];
  UART2.fifo.rw_byte = samples[index][1];
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
      if (!w.error) {
        w.faultUart = 1;
        w.unexpectedRx = byte;
        w.expectedRx = position < 2 ? samples[index][position] : 0;
        w.rxPosition = position;
        w.unexpectedAtUs = static_cast<uint32_t>(esp_timer_get_time());
      }
      abortNow(6);
      continue;
    }
    w.received[position] = byte;
    w.echoAtUs[position] = static_cast<uint32_t>(esp_timer_get_time());
    w.receivedCount = position + 1;
  }
  UART1.int_clr.val = pending;
}
// UART2 transmits only. UART1 independently receives MAX RO on GPIO16,
// the exact ESP32 UART pairing proven in the earlier four-word GPIO bench.
void IRAM_ATTR uartTxISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & (1UL << 14)) {
    deLow();
    TIMERG0.hw_timer[0].config.alarm_en = 0;
    UART2.int_ena.tx_done = 0;
    const int index = activeWord;
    if (index >= 0 && index < kWords && !stopped) {
      witness[index].txDoneUs = static_cast<uint32_t>(esp_timer_get_time());
      ++witness[index].txDoneCount;
    } else abortNow(8);
  }
  UART2.int_clr.val = pending;
}
void stopAll() {
  stopped = true;
  deLow();
  stopAlarms();
  UART1.int_ena.val = 0;
  UART2.int_ena.val = 0;
  UART2.conf0.txfifo_rst = 1;
  UART2.conf0.txfifo_rst = 0;
  activeWord = -1;
}
bool startUart() {
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
      uart_param_config(UART_NUM_2, &cfg) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kMaxEcho,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_set_pin(UART_NUM_2, kTx, UART_PIN_NO_CHANGE,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK)
    return false;
  // UART2 owns DI output 17; UART1 owns MAX RO input 16; XY RO19 is RMT6.
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_OUTPUT);
  UART1.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1;
  UART1.conf0.rxfifo_rst = 0;
  UART1.conf0.txfifo_rst = 1;
  UART1.conf0.txfifo_rst = 0;
  UART2.int_ena.val = 0;
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.rxfifo_rst = 1;
  UART2.conf0.rxfifo_rst = 0;
  UART2.conf0.txfifo_rst = 1;
  UART2.conf0.txfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1;
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM, uartISR,
                     nullptr, &uartHandle) != ESP_OK) return false;
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM, uartTxISR,
                     nullptr, &txUartHandle) != ESP_OK) {
    (void)esp_intr_free(uartHandle);
    uartHandle = nullptr;
    return false;
  }
  uartReady = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  return true;
}
void closeUart() {
  stopAll();
  if (uartHandle) (void)esp_intr_free(uartHandle);
  if (txUartHandle) (void)esp_intr_free(txUartHandle);
  uartHandle = nullptr;
  txUartHandle = nullptr;
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
bool startRmt() {
  txRing = nullptr;
  deRing = nullptr;
  xyRing = nullptr;
  // RMT0 records the MAX RO raw pad, UART1 independently decodes MAX bytes.
  // RMT6 records XY RXD pad for a strict 9600 8N1 software decoder.
  // RMT1 measures GPIO21 DE through the physically separate jumper.
  if (!rmtChannel(RMT_CHANNEL_0, GPIO_NUM_16, &txRing)) return false;
  if (!rmtChannel(RMT_CHANNEL_1, GPIO_NUM_21, &deRing)) return false;
  if (!rmtChannel(RMT_CHANNEL_6, GPIO_NUM_19, &xyRing)) return false;
  // Restore transmit and MAX receive after RMT configured the two RX pads.
  if (uart_set_pin(UART_NUM_2, kTx, UART_PIN_NO_CHANGE,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kMaxEcho,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK)
    return false;
  // GPIO input-matrix route lets RMT0 and UART1 independently sample GPIO16.
  gpio_pad_select_gpio(kMaxEcho);
  gpio_matrix_in(kMaxEcho, U1RXD_IN_IDX, false);
  if (GPIO.func_in_sel_cfg[U1RXD_IN_IDX].func_sel != kMaxEcho ||
      GPIO.func_in_sel_cfg[U1RXD_IN_IDX].sig_in_sel != 1 ||
      GPIO.func_in_sel_cfg[U1RXD_IN_IDX].sig_in_inv != 0) return false;
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U2TXD_OUT_IDX, false, false);
  // GPIO21 is input-only monitor; GPIO19 is old XY receiver-only.
  // Prepare an autonomous DE safety window. No pulse is started here.
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
  pulse.duration0 = 2180; pulse.level0 = 1;
  pulse.duration1 = 80; pulse.level1 = 0;
  for (int i = 0; i < kWords; ++i) {
    const auto channel = static_cast<rmt_channel_t>(RMT_CHANNEL_2 + i);
    gate.channel = channel;
    if (rmt_config(&gate) != ESP_OK ||
        rmt_driver_install(channel, 0, 0) != ESP_OK) return false;
    ++rmtTxChannelsReady;
    if (rmt_fill_tx_items(channel, &pulse, 1, 0) != ESP_OK) return false;
  }
  // GPIO16/GPIO19/GPIO21 remain input-only. GPIO19 has no TX peripheral.
  deLow();
  rmtReady = true;
  return true;
}
void closeRmt() {
  if (rmtTxChannelsReady) {
    deLow();
    for (int i = 0; i < rmtTxChannelsReady; ++i) {
      const auto channel = static_cast<rmt_channel_t>(RMT_CHANNEL_2 + i);
      (void)rmt_tx_stop(channel);
      (void)rmt_driver_uninstall(channel);
    }
    rmtTxChannelsReady = 0;
  }
  if (!rmtReady) return;
  (void)rmt_rx_stop(RMT_CHANNEL_0);
  (void)rmt_rx_stop(RMT_CHANNEL_1);
  (void)rmt_rx_stop(RMT_CHANNEL_6);
  (void)rmt_driver_uninstall(RMT_CHANNEL_0);
  (void)rmt_driver_uninstall(RMT_CHANNEL_1);
  (void)rmt_driver_uninstall(RMT_CHANNEL_6);
  rmtReady = false;
}
void captureRmt(rmt_channel_t ch, RingbufHandle_t ring, int index, bool de) {
  size_t bytes = 0;
  void* packet = nullptr;
  // Never block here: per-word RMT had a 12ms empty-ring wait for EACH of
  // two channels, silently exhausting the next CART-like 10ms test slot.
  // RX was stopped after >3ms idle, so all completed items must be queued
  // already; missing data fails closed below instead of waiting or guessing.
  while ((packet = xRingbufferReceive(ring, &bytes, 0))) {
    const size_t count = bytes / sizeof(rmt_item32_t);
    for (size_t i = 0; i < count; ++i) {
      const auto& item = static_cast<const rmt_item32_t*>(packet)[i];
      if (de) {
        witness[index].deRmtItems++;
        if (item.level0) witness[index].deRmtHighUs += item.duration0;
        if (item.level1) witness[index].deRmtHighUs += item.duration1;
      } else if (ch == RMT_CHANNEL_6) {
        if (witness[index].xyTraceCount < 24)
          witness[index].xyTrace[witness[index].xyTraceCount++] = item;
        if (item.duration0) ++witness[index].xyRmtEdges;
        if (item.duration1) ++witness[index].xyRmtEdges;
      } else {
        witness[index].txRmtItems++;
        if (witness[index].txTraceCount < 24) {
          witness[index].txTrace[witness[index].txTraceCount++] = item;
        }
        if (item.duration0) ++witness[index].txRmtEdges;
        if (item.duration1) ++witness[index].txRmtEdges;
      }
    }
    vRingbufferReturnItem(ring, packet);
    bytes = 0;
  }
  (void)ch;
}
// Read GPIO19's actual RMT level runs at a UART 9600/8N1 bit center.
// Unlike pretending to have UART byte interrupts, this decoder deliberately
// provides NO absolute byte timestamp. RMT only measures relative pulse runs.
bool xyLevelAt(const WordWitness& w, int index, uint32_t sampleUs, uint8_t& level) {
  uint32_t elapsed = 0;
  for (uint8_t i = 0; i < w.xyTraceCount; ++i) {
    const rmt_item32_t& it = w.xyTrace[i];
    if (it.duration0 && sampleUs < elapsed + it.duration0) {
      level = it.level0;
      return true;
    }
    elapsed += it.duration0;
    if (it.duration1 && sampleUs < elapsed + it.duration1) {
      level = it.level1;
      return true;
    }
    elapsed += it.duration1;
  }
  // With these samples the second byte has MSB=1, so the final data HIGH
  // runs straight into the stop HIGH: there is NO further edge. The ESP32
  // RMT RX ring terminates the last HIGH with duration1=0 on idle. Accept
  // only the expected final contiguous HIGH run: last 1-bit(s) of the
  // literal second byte plus its stop bit. For F0 there are four trailing
  // HIGH data bits, so this can be up to five bit times, NOT two.
  uint32_t finalHighBoundUs = 105; // mandatory stop bit
  for (int bit = 7; bit >= 0 &&
       ((samples[index][1] >> bit) & 1U) != 0; --bit) {
    finalHighBoundUs += 105;
  }
  if (w.xyTraceCount && sampleUs >= elapsed &&
      sampleUs < elapsed + finalHighBoundUs &&
      w.xyTrace[w.xyTraceCount - 1].duration1 == 0 &&
      w.xyTrace[w.xyTraceCount - 1].level1 == 1 &&
      digitalRead(kOldEcho) == HIGH) {
    level = 1;
    return true;
  }
  return false;
}
bool decodeXyRmt(WordWitness& w, int index) {
  if (w.xyTraceCount == 0 || w.xyRmtEdges != kExpectedTxRmtSegments[index]) {
    w.xyDecodeError = 1;
    return false;
  }
  uint8_t data[2] = {};
  // Last stop HIGH may be stored as a zero-duration trailing level by the
  // RMT driver when RX capture terminates on idle; still require a final
  // LOW-to-HIGH level transition, but don't invent its measured duration.
  const rmt_item32_t& last = w.xyTrace[w.xyTraceCount - 1];
  if (!(last.level1 == 1 && last.duration1 == 0)) {
    w.xyDecodeError = 2;
    return false;
  }
  for (int k = 0; k < 19; ++k) { // all start/data bits and first stop bit
    const uint32_t centerUs =
        (static_cast<uint32_t>(2 * k + 1) * 500000U + 4800U) / 9600U;
    uint8_t actual = 0;
    if (!xyLevelAt(w, index, centerUs, actual)) {
      w.xyDecodeError = 3;
      return false;
    }
    const int bit = k % 10;
    if (bit == 0 && actual != 0) {
      w.xyDecodeError = 4;
      return false;
    }
    if (bit == 9 && actual != 1) {
      w.xyDecodeError = 5;
      return false;
    }
    if (bit >= 1 && bit <= 8 && actual)
      data[k / 10] |= static_cast<uint8_t>(1U << (bit - 1));
  }
  w.oldReceived[0] = data[0];
  w.oldReceived[1] = data[1];
  if (data[0] != samples[index][0] || data[1] != samples[index][1]) {
    w.xyDecodeError = 6;
    return false;
  }
  w.oldReceivedCount = 2;
  return true;
}
void hexByte(uint8_t x) {
  if (x < 16) Serial.print('0');
  Serial.print(x, HEX);
}
void printReport(bool ok, int completed) {
  Serial.print(F("BENCH_END result="));
  Serial.print(ok ? F("PASS_DUAL_RS485_DESK_ONLY") : F("FAIL_CLOSED"));
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
    Serial.print(F(" xy_count=")); Serial.print(w.oldReceivedCount);
    Serial.print(F(" xy_bytes=")); hexByte(w.oldReceived[0]); hexByte(w.oldReceived[1]);
    Serial.print(F(" xy_source=RMT_GPIO19_no_absolute_timestamp"));
    Serial.print(F(" xy_rmt_edges=")); Serial.print(w.xyRmtEdges);
    Serial.print(F(" xy_decode_err=")); Serial.print(w.xyDecodeError);
    Serial.print(F(" tx_done_count=")); Serial.print(w.txDoneCount);
    Serial.print(F(" cutoff=")); Serial.print(w.cutoff);
    Serial.print(F(" error=")); Serial.print(w.error);
    Serial.print(F(" unexpected_rx=")); hexByte(w.unexpectedRx);
    Serial.print(F(" expected_rx=")); hexByte(w.expectedRx);
    Serial.print(F(" rx_position=")); Serial.print(w.rxPosition);
    Serial.print(F(" unexpected_at_us=")); Serial.print(w.unexpectedAtUs);
    Serial.print(F(" fault_uart=")); Serial.print(
        w.faultUart == 1 ? F("MAX") : w.faultUart == 2 ? F("XY") : F("NONE"));
    Serial.print(F(" de_rmt_high_us=")); Serial.print(w.deRmtHighUs);
    Serial.print(F(" de_rmt_items=")); Serial.print(w.deRmtItems);
    Serial.print(F(" tx_rmt_items=")); Serial.print(w.txRmtItems);
    Serial.print(F(" tx_rmt_edges=")); Serial.println(w.txRmtEdges);
    if (!ok && w.firedUs) {
      for (uint8_t j = 0; j < w.txTraceCount; ++j) {
        const auto& item = w.txTrace[j];
        Serial.print(F("TX_EDGE frame=")); Serial.print(i);
        Serial.print(F(" item=")); Serial.print(j);
        Serial.print(F(" level0=")); Serial.print(item.level0);
        Serial.print(F(" dur0_us=")); Serial.print(item.duration0);
        Serial.print(F(" level1=")); Serial.print(item.level1);
        Serial.print(F(" dur1_us=")); Serial.println(item.duration1);
      }
      for (uint8_t j = 0; j < w.xyTraceCount; ++j) {
        const auto& item = w.xyTrace[j];
        Serial.print(F("XY_EDGE frame=")); Serial.print(i);
        Serial.print(F(" item=")); Serial.print(j);
        Serial.print(F(" level0=")); Serial.print(item.level0);
        Serial.print(F(" dur0_us=")); Serial.print(item.duration0);
        Serial.print(F(" level1=")); Serial.print(item.level1);
        Serial.print(F(" dur1_us=")); Serial.println(item.duration1);
      }
    }
  }
  Serial.println(F("LIMITS MAX_UART1_and_XY_RMT6_differential_desk_only no_XY_absolute_timestamp not_ECU_proof no_bus_contention_test no_automotive_transient_protection"));
}
bool verifyPhysicalJumpers() {
  // No UART TX data during this probe; keep DI idle HIGH, pulse DE for only
  // 35us on an entirely disconnected bench bus, observe via GPIO21.
  // MAX487/XY-k485 receive idle must already be validated by operator.
  deLow();
  pinMode(kTx, OUTPUT);
  digitalWrite(kTx, HIGH);
  delayMicroseconds(35);
  const bool maxIdle = digitalRead(kMaxEcho) == HIGH;
  const bool xyIdle = digitalRead(kOldEcho) == HIGH;
  const bool deLowSeen = digitalRead(kExternalDeSense) == LOW;
  GPIO.out_w1ts = 1UL << 18;
  delayMicroseconds(35);
  const bool deHighSeen = digitalRead(kExternalDeSense) == HIGH;
  deLow();
  delayMicroseconds(15);
  const bool deReleased = digitalRead(kExternalDeSense) == LOW;
  pinMode(kTx, INPUT);
  Serial.print(F("DESK_CHECK max_idle=")); Serial.print(maxIdle ? 1 : 0);
  Serial.print(F(" xy_idle=")); Serial.print(xyIdle ? 1 : 0);
  Serial.print(F(" de_low=")); Serial.print(deLowSeen ? 1 : 0);
  Serial.print(F(" de_high=")); Serial.print(deHighSeen ? 1 : 0);
  Serial.print(F(" de_release=")); Serial.print(deReleased ? 1 : 0);
  Serial.println(F(" uart_bytes=0"));
  return maxIdle && xyIdle && deLowSeen && deHighSeen && deReleased;
}
bool run() {
  oneShotUsed = true;
  stopped = false;
  irqErrors = irqRxCoalesced = 0;
  activeWord = -1;
  std::memset(witness, 0, sizeof(witness));
  deLow();
  if (!verifyPhysicalJumpers()) {
    Serial.println(F("BENCH_ABORT DESK_WIRING_NOT_VERIFIED no_uart_bytes=1 DE=LOW"));
    return false;
  }
  if (!cutoff || !slot || !startUart()) {
    Serial.println(F("BENCH_ABORT UART_OR_TIMER_INIT"));
    closeUart(); return false;
  }
  if (!startRmt()) {
    Serial.println(F("BENCH_ABORT RMT_INIT"));
    closeUart(); closeRmt(); return false;
  }
  if (digitalRead(kMaxEcho) != HIGH || digitalRead(kOldEcho) != HIGH ||
      digitalRead(kExternalDeSense) != LOW) {
    Serial.println(F("BENCH_ABORT RECEIVER_OR_DE_NOT_IDLE"));
    closeUart(); closeRmt(); return false;
  }
  Serial.println(F("BENCH_BEGIN mode=DUAL_RS485_DESK_ONLY no_vehicle=1"));
  const uint32_t epoch = static_cast<uint32_t>(esp_timer_get_time()) + 5000;
  int completed = 0;
  for (int i = 0; i < kWords && !stopped; ++i) {
    WordWitness& w = witness[i];
    w.targetUs = epoch + i * kSlotSpacingUs;
    // Start hardware edge sampling before each timed 2-byte emission.
    if (rmt_rx_start(RMT_CHANNEL_0, true) != ESP_OK ||
        rmt_rx_start(RMT_CHANNEL_1, true) != ESP_OK ||
        rmt_rx_start(RMT_CHANNEL_6, true) != ESP_OK) {
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
    (void)rmt_rx_stop(RMT_CHANNEL_6);
    captureRmt(RMT_CHANNEL_0, txRing, i, false);
    captureRmt(RMT_CHANNEL_1, deRing, i, true);
    captureRmt(RMT_CHANNEL_6, xyRing, i, false);
    if (!stopped && !decodeXyRmt(w, i)) {
      w.faultUart = 2;
      w.error = 15; // XY raw waveform not a complete exact 8N1 sample
      stopped = true;
    }
    if (!stopped && (w.deRmtHighUs < 1950 ||
        w.deRmtHighUs >= kCutoffUs || w.deRmtItems == 0 ||
        w.txRmtEdges != kExpectedTxRmtSegments[i])) {
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
void respond() {
  if (!strcmp(line, "STATUS")) {
    deLow();
    Serial.print(F("STATUS SME105_DUAL_RS485_V1 vehicle_tx=LOCKED DE=LOW used="));
    Serial.println(oneShotUsed ? 1 : 0);
  } else if (!strcmp(line, "RX_ROUTE")) {
    // Hardware-route diagnostic. UART2 RX is deliberately UNUSED; UART1
    // owns MAX RO16, RMT6 owns XY GPIO19 and UART2 is TX only.
    // Never arm a timer, launch RMT TX, queue a byte or assert DE.
    if (oneShotUsed) {
      Serial.println(F("DENIED RX_ROUTE after consumed one-shot"));
    } else {
      const bool configured = startUart() && startRmt();
      if (configured) {
        Serial.print(F("RX_ROUTE uart2_rx_disabled=1 u1_max_pin=")); Serial.print(GPIO.func_in_sel_cfg[U1RXD_IN_IDX].func_sel);
        Serial.print(F(" u1_input_sel=")); Serial.print(GPIO.func_in_sel_cfg[U1RXD_IN_IDX].sig_in_sel);
        Serial.print(F(" u1_inv=")); Serial.print(GPIO.func_in_sel_cfg[U1RXD_IN_IDX].sig_in_inv);
        Serial.print(F(" xy_rmt6_input_pin=19"));
        Serial.print(F(" uart1_status_rx=")); Serial.print(UART1.status.rxd);
        Serial.println(F(" DE=LOW UART_TX=0 ECU_TX=0"));
      } else {
        Serial.println(F("RX_ROUTE FAIL_INIT no_UART_TX=1 DE=LOW"));
      }
      closeUart();
      closeRmt();
      deLow();
    }
  } else if (!strcmp(line, "PINS")) {
    deLow();
    Serial.print(F("PINS max16=")); Serial.print(digitalRead(kMaxEcho));
    Serial.print(F(" xy19=")); Serial.print(digitalRead(kOldEcho));
    Serial.print(F(" de21=")); Serial.print(digitalRead(kExternalDeSense));
    Serial.println(F(" DE=LOW no_tx=1"));
  } else if (!strcmp(line, "BENCH_RS485_ONCE")) {
    if (oneShotUsed) Serial.println(F("DENIED used; power-cycle for new bench"));
    else (void)run();
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
  pinMode(kMaxEcho, INPUT);
  pinMode(kOldEcho, INPUT);
  pinMode(kExternalDeSense, INPUT_PULLDOWN);
  Serial.begin(115200);
  cutoff = timerBegin(0, 80, true);
  slot = timerBegin(2, 80, true);
  if (cutoff) { timerAttachInterrupt(cutoff, cutoffISR, true); timerAlarmDisable(cutoff); }
  if (slot) { timerAttachInterrupt(slot, slotISR, true); timerAlarmDisable(slot); }
  delay(250);
  Serial.println(F("SME105_DUAL_RS485_V1 NO_AUTO_TX NEVER_CONNECT_TO_ECU"));
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
