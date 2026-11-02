#pragma once

#include <stdint.h>

// Bounded STOP token recognizer for 115200 baud host control while CART is
// active. Both Unix LF and serial-monitor CR/CRLF must stop the session.
// No heap, host USB timing assumptions, or hardware calls.
class StopLineMatcher {
 public:
  bool consume(char ch) {
    if (matched_ == 4) {
      const bool stop = ch == '\n' || ch == '\r';
      matched_ = ch == 'S' ? 1 : 0;
      return stop;
    }
    static const char expected[4] = {'S', 'T', 'O', 'P'};
    if (ch == expected[matched_]) ++matched_;
    else matched_ = ch == 'S' ? 1 : 0;
    return false;
  }

 private:
  uint8_t matched_ = 0;
};
