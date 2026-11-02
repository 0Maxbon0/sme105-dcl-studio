#pragma once

#include <stdint.h>

#if defined(ARDUINO_ARCH_ESP32)
#define CART_B_ISR_ATTR IRAM_ATTR
#else
#define CART_B_ISR_ATTR
#endif

// Pure timing/protocol model. There is deliberately no UART or GPIO access.
// One ID-only baseline (0..15) must finish before scheduling slot-1 dry-run
// opportunities for exactly four words in the NEXT cycle, frame IDs 0..3.
// The ESP32 caller separately arms a hardware timer for each opportunity.
namespace cart_b_plan {

struct Word {
  uint8_t first;
  uint8_t second;
};

// Four-word flxkrmr reference candidate. doncreat0r instead uses 26 0E.
// Having all four words in this inert model does not authorize ECU TX.
constexpr Word wordForFrame(uint8_t frame) {
  return frame == 0 ? Word{0x01, 0xB0} :
         frame == 1 ? Word{0xFF, 0x5F} :
         frame == 2 ? Word{0x26, 0xA4} : Word{0x00, 0xA0};
}

constexpr uint8_t parity(uint8_t first, uint8_t lowNibble) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^
      lowNibble ^ 10) << 4) | lowNibble);
}

static_assert(parity(0x01, 0) == 0xB0 &&
              parity(0xFF, 15) == 0x5F &&
              parity(0x26, 4) == 0xA4 &&
              parity(0x00, 0) == 0xA0,
              "Reference four-word parity must remain exact");

struct ByteEvent {
  uint32_t timeUs;
  uint8_t value;
};

enum class Stage : uint8_t { SeekId0, Baseline, CommandCycle, Complete, Failed };
enum class Reason : uint8_t {
  None, InvalidHeader, InvalidCadence, InvalidPhase, MissingTimer,
  TimerTooLate, TimerUnscheduled, RxCompromised
};
enum class Outcome : uint8_t {
  Nothing, BaselineReady, ScheduleSlot, Finished, Rejected
};

class FourWordDryRun {
 public:
  Stage stage = Stage::SeekId0;
  Reason reason = Reason::None;
  uint8_t headerPhaseBits = 255;
  uint8_t baselineFrames = 0;
  uint8_t commandFrames = 0;
  uint8_t scheduled = 0;
  uint8_t fired = 0;
  bool awaitingTimer = false;
  uint32_t dueUs[4] = {};
  uint32_t firedUs[4] = {};

  void CART_B_ISR_ATTR abort(Reason why) {
    if (stage != Stage::Complete) {
      reason = why;
      stage = Stage::Failed;
      awaitingTimer = false;
    }
  }

  Outcome CART_B_ISR_ATTR onTimer(uint32_t whenUs) {
    if (stage != Stage::CommandCycle || !awaitingTimer ||
        fired >= scheduled || fired >= 4) {
      abort(Reason::TimerUnscheduled);
      return Outcome::Rejected;
    }
    // The nominal slot edge is a *candidate*. Interrupt latency has yet to
    // be correlated with a differential logic analyzer trace.
    if (!near(whenUs, dueUs[fired], 175)) {
      abort(Reason::TimerTooLate);
      return Outcome::Rejected;
    }
    firedUs[fired] = whenUs;
    ++fired;
    awaitingTimer = false;
    if (commandFrames == 16 && fired == 4) {
      stage = Stage::Complete;
      return Outcome::Finished;
    }
    return Outcome::Nothing;
  }

  Outcome CART_B_ISR_ATTR onByte(uint8_t octet, uint32_t timestampUs) {
    if (stage == Stage::Failed || stage == Stage::Complete) return Outcome::Nothing;
    const ByteEvent next = {timestampUs, octet};
    if (stage == Stage::SeekId0) {
      if (used_ < 4) window_[used_++] = next;
      else {
        for (uint8_t i = 0; i < 3; ++i) window_[i] = window_[i + 1];
        window_[3] = next;
      }
      uint8_t phase = 255;
      if (used_ == 4 && inspect(window_, 0, phase) && phase != 255) {
        headerPhaseBits = phase;
        previousSyncUs_ = window_[1].timeUs;
        baselineFrames = 1;
        stage = Stage::Baseline;
        used_ = 0;
      }
      return Outcome::Nothing;
    }
    if (used_ >= 4) { abort(Reason::InvalidHeader); return Outcome::Rejected; }
    window_[used_++] = next;
    if (used_ != 4) return Outcome::Nothing;
    used_ = 0;

    const uint8_t expected = stage == Stage::Baseline ? baselineFrames : commandFrames;
    uint8_t phase = 255;
    if (!inspect(window_, expected, phase)) {
      abort(Reason::InvalidHeader);
      return Outcome::Rejected;
    }
    if (phase != headerPhaseBits) {
      abort(Reason::InvalidPhase);
      return Outcome::Rejected;
    }
    if (!near(window_[1].timeUs, previousSyncUs_ + 10000, 175)) {
      abort(Reason::InvalidCadence);
      return Outcome::Rejected;
    }
    previousSyncUs_ = window_[1].timeUs;
    if (stage == Stage::Baseline) {
      ++baselineFrames;
      if (baselineFrames == 16) {
        stage = Stage::CommandCycle;
        return Outcome::BaselineReady;
      }
      return Outcome::Nothing;
    }
    if (expected < 4 && (awaitingTimer || scheduled != expected || fired != expected)) {
      abort(Reason::MissingTimer);
      return Outcome::Rejected;
    }
    ++commandFrames;
    if (expected < 4) {
      // One CART slot is 24 bits, with the first slot following the second
      // sync byte by (4 sync rearm + 24 timer) bits at 9600 baud.
      // Rounded to 2917us; guard the actual timer ISR firing separately.
      dueUs[expected] = window_[1].timeUs + 2917;
      ++scheduled;
      awaitingTimer = true;
      return Outcome::ScheduleSlot;
    }
    if (commandFrames == 16) {
      if (awaitingTimer || fired != 4) {
        abort(Reason::MissingTimer);
        return Outcome::Rejected;
      }
      stage = Stage::Complete;
      return Outcome::Finished;
    }
    return Outcome::Nothing;
  }

 private:
  ByteEvent window_[4] = {};
  uint8_t used_ = 0;
  uint32_t previousSyncUs_ = 0;

  static bool CART_B_ISR_ATTR near(uint32_t actual, uint32_t expected, int32_t tolerance) {
    const int32_t diff = static_cast<int32_t>(actual - expected);
    return diff >= -tolerance && diff <= tolerance;
  }

  static bool CART_B_ISR_ATTR inspect(const ByteEvent* bytes, uint8_t expectedId, uint8_t& phase) {
    if (bytes[0].value != 0 || bytes[1].value != 0 ||
        bytes[3].value != parity(bytes[2].value, expectedId)) return false;
    if (!near(bytes[1].timeUs, bytes[0].timeUs + 1042, 175) ||
        !near(bytes[3].timeUs, bytes[2].timeUs + 1042, 175)) return false;
    if (near(bytes[2].timeUs, bytes[1].timeUs + 1042, 175)) phase = 0;
    else if (near(bytes[2].timeUs, bytes[1].timeUs + 1458, 175)) phase = 4;
    else return false;
    return true;
  }
};
}  // namespace cart_b_plan
