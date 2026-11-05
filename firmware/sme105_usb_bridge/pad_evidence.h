#pragma once
#include <stdint.h>
// Caller owns txLock. No allocation, GPIO, clocks or mutable command lookup.
// Keep the first block and the first later failure; repeated successes are
// represented by counters, never by relabelling old samples as new words.
struct PadEvidence {
  struct Record {
    uint32_t epoch, sequence, block, start, done;
    uint8_t slot, expected0, expected1, observed0, observed1;
    bool completed, match;
    uint32_t boot;
  };
  uint32_t boot = 0;
  uint32_t epoch = 0, sequence = 0, started = 0, verified = 0;
  Record first[4] = {}, failed = {}, active = {};
  bool hasFailure = false;
  __attribute__((always_inline)) inline void begin() {
    ++epoch; sequence = started = verified = 0;
    for (auto &record : first) record = {};
    failed = {}; active = {}; hasFailure = false;
  }
  __attribute__((always_inline)) inline void start(uint32_t block, uint8_t slot, uint8_t a, uint8_t b, uint32_t at) {
    active = {epoch, ++sequence, block, at, 0, slot, a, b, 0, 0, false, false, boot};
    ++started;
    if (block == 0 && slot < 4) first[slot] = active;
  }
  __attribute__((always_inline)) inline void complete(uint8_t a, uint8_t b, uint32_t at, bool electricalValid) {
    if (!active.sequence || active.completed || active.epoch != epoch) return;
    active.observed0 = a; active.observed1 = b; active.done = at;
    active.completed = true;
    active.match = electricalValid && a == active.expected0 && b == active.expected1;
    if (active.match) ++verified;
    if (active.block == 0 && active.slot < 4) first[active.slot] = active;
    if (!active.match && !hasFailure) { failed = active; hasFailure = true; }
  }
  __attribute__((always_inline)) inline void abort() {
    if (active.sequence && !active.completed && !hasFailure) {
      failed = active; hasFailure = true;
    }
  }
};
