#include <Arduino.h>
#include "driver/uart.h"

// Listen-only DCL sniffer.
// USB (UART0/CP2102): 115200 ASCII. DCL: UART2 RX GPIO16, 9600 8N1, TX unattached.
// GPIO17 is input. This sketch never writes UART2.
// USB identity lines are printed before UART2 is started so a USB-only capture
// can prove firmware identity without GPIO16/K485.

namespace {

constexpr uart_port_t kDclUart = UART_NUM_2;
constexpr int kRxPin = 16;
constexpr int kUnusedTxPin = 17;
constexpr uint32_t kUsbBaud = 115200;
constexpr int kDclBaud = 9600;
constexpr uint32_t kBreakReportMs = 1000;

QueueHandle_t uartQueue = nullptr;
uint32_t lastBreakMs = 0;
bool dclRxOn = false;

void emitHex(const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (i != 0) {
      Serial.write(' ');
    }
    if (data[i] < 0x10) {
      Serial.write('0');
    }
    Serial.print(data[i], HEX);
  }
  Serial.write('\n');
}

void startUsbIdentity() {
  pinMode(kUnusedTxPin, INPUT);
  pinMode(kRxPin, INPUT);
  Serial.begin(kUsbBaud);
  delay(150);
  Serial.println(F("# SME105_SNIFFER id=gpio16-9600-8n1 usb=115200 tx=off"));
  for (uint8_t i = 0; i < 15; ++i) {
    Serial.println(F("# USB_IDENTITY"));
    delay(200);
  }
}

void startDclRx() {
  uart_config_t cfg = {};
  cfg.baud_rate = kDclBaud;
  cfg.data_bits = UART_DATA_8_BITS;
  cfg.parity = UART_PARITY_DISABLE;
  cfg.stop_bits = UART_STOP_BITS_1;
  cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  cfg.source_clk = UART_SCLK_APB;
  uart_driver_install(kDclUart, 2048, 0, 16, &uartQueue, 0);
  uart_param_config(kDclUart, &cfg);
  uart_set_pin(
      kDclUart,
      UART_PIN_NO_CHANGE,
      kRxPin,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE);
  dclRxOn = true;
  Serial.println(F("# DCL_RX_ON gpio16"));
}

}  // namespace

void setup() {
  startUsbIdentity();
  startDclRx();
}

void loop() {
  if (!dclRxOn || uartQueue == nullptr) {
    return;
  }

  uart_event_t event;
  if (!xQueueReceive(uartQueue, &event, pdMS_TO_TICKS(50))) {
    return;
  }

  switch (event.type) {
    case UART_DATA: {
      uint8_t buffer[128];
      const int got = uart_read_bytes(kDclUart, buffer, event.size, 0);
      if (got > 0) {
        emitHex(buffer, static_cast<size_t>(got));
      }
      break;
    }
    case UART_BREAK:
    case UART_FRAME_ERR: {
      uart_flush_input(kDclUart);
      const uint32_t now = millis();
      if (now - lastBreakMs >= kBreakReportMs) {
        Serial.println(
            event.type == UART_BREAK ? F("# UART_BREAK") : F("# UART_FRAME_ERR"));
        lastBreakMs = now;
      }
      break;
    }
    case UART_FIFO_OVF:
    case UART_BUFFER_FULL:
      uart_flush_input(kDclUart);
      xQueueReset(uartQueue);
      Serial.println(F("# UART_OVERFLOW"));
      break;
    default:
      break;
  }
}
