#pragma once
#include <stdint.h>
#ifndef KLINE_HW_ENABLED
#define KLINE_HW_ENABLED 0
#endif
#ifndef KLINE_TX_ENABLED
#define KLINE_TX_ENABLED 0
#endif
#if KLINE_HW_ENABLED || KLINE_TX_ENABLED
#error "K-Line hardware and TX are unqualified. This build must remain hardware-disabled."
#endif
// GPIO19 is a candidate only. UART0=USB, UART1=RO16, UART2=DI17/pad;
// RMT is committed to DCL safety. No fourth UART and no pin configuration.
// Resource-safe delivery: portable passive RX model, NO electrical backend.
struct KlineRx {
  static constexpr uint8_t candidateRx = 19;
  static constexpr uint8_t capacity = 64;
  struct Event { uint64_t monotonic; uint32_t wire; uint8_t value; bool edge; };
  Event ring[capacity] = {};
  uint32_t session = 0, received = 0, overflow = 0, errors = 0, last = 0;
  uint64_t clock = 0;
  uint8_t read = 0, write = 0, used = 0;
  bool active = false, hasClock = false;
  void beginSimulation() {
    ++session; received = overflow = errors = 0; clock = 0;
    read = write = used = 0; hasClock = false; active = true;
  }
  bool receiveSimulation(uint32_t at, uint8_t value, bool edge = false) {
    if (!active) return false;
    const uint32_t delta = at - last;
    if ((hasClock && delta > 0x7fffffffU) || (edge && value > 1)) { ++errors; return false; }
    clock = hasClock ? clock + delta : at; hasClock = true; last = at; ++received;
    if (used == capacity) { ++overflow; active = false; return false; }
    ring[write] = {clock, at, value, edge}; write = (write + 1) % capacity; ++used; return true;
  }
  bool take(Event &event) {
    if (!used) return false;
    event = ring[read]; read = (read + 1) % capacity; --used; return true;
  }
  void stop() { active = false; }
};
