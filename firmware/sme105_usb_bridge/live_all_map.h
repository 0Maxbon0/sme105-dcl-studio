#pragma once
#include <stdint.h>

// Mode 41H IW2..IW4 in frames 1..15; mode 21H responds in the same slots.
// Frame length remains 6 (22.5 ms/frame, 360 ms/block at 9600 baud).
// All 39 requested channels occur in every block. Six spare slots repeat
// RPM, throttle, target idle, battery and idle command. No group rotation.
DRAM_ATTR const uint8_t kAllLivePids[16][3] = {
  {0,    0,    0},
  {0x01, 0x24, 0x02},
  {0x0F, 0x25, 0x07},
  {0x10, 0x2B, 0x12},
  {0x05, 0x2A, 0x13},
  {0x06, 0x15, 0x17},
  {0x09, 0x1A, 0x26},
  {0x11, 0x1B, 0x30},
  {0x03, 0x2F, 0x32},
  {0x04, 0x2E, 0x35},
  {0x0C, 0x0B, 0x36},
  {0x0D, 0x0E, 0x37},
  {0x08, 0x2D, 0x38},
  {0x18, 0x01, 0x11},
  {0x27, 0x09, 0x15},
  {0x28, 0x2A, 0x01},
};
constexpr uint8_t kAllLiveColumns = 3, kAllLiveMapWords = 45;

inline uint8_t IRAM_ATTR allLivePid(uint8_t frame, uint8_t column) {
  return frame < 16 && column < kAllLiveColumns ? kAllLivePids[frame][column] : 0;
}
