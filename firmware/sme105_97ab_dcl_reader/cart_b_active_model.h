#pragma once

#include <stdint.h>

#if defined(ARDUINO_ARCH_ESP32)
#define CART_MODEL_IRAM IRAM_ATTR
#else
#define CART_MODEL_IRAM
#endif

// Deterministic *candidate* protocol and transmit witness. No hardware I/O.
// The only four legal words are source-pinned read-code candidate sequences.
namespace cart_candidate {

enum class Variant : uint8_t { FlxA4, Don0E };
struct Word { uint8_t first; uint8_t second; };

constexpr Word CART_MODEL_IRAM word(Variant variant, uint8_t frame) {
  return frame == 0 ? Word{0x01, 0xB0} :
         frame == 1 ? Word{0xFF, 0x5F} :
         frame == 2 ? (variant == Variant::FlxA4 ? Word{0x26, 0xA4} : Word{0x26, 0x0E}) :
         Word{0x00, 0xA0};
}
constexpr uint8_t CART_MODEL_IRAM parity(uint8_t first, uint8_t lowNibble) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^
      lowNibble ^ 10) << 4) | lowNibble);
}
static_assert(parity(0x01, 0) == 0xB0 && parity(0xFF, 15) == 0x5F &&
              parity(0x26, 4) == 0xA4 && parity(0x26, 14) == 0x0E &&
              parity(0x00, 0) == 0xA0, "Reference word parity mismatch");

enum class Stage : uint8_t { SeekId0, Baseline, Request, Response, Failed };
enum class Fault : uint8_t {
  None, BadHeader, BadPhase, BadCadence, RxError, EarlyRx,
  LateTimer, Timeout, UnexpectedTxDone, InvalidEcho, InvalidEchoTime,
  InvalidTxDuration, MissingEcho, UnconfirmedRx
};
enum class Event : uint8_t { None, BaselineComplete, ArmSlot, RequestComplete, Abort };

struct Octet { uint32_t atUs; uint8_t value; };

class FourWordRequest {
 public:
  explicit FourWordRequest(Variant variant) : variant_(variant) {}
  Variant variant() const { return variant_; }
  Stage stage = Stage::SeekId0;
  Fault fault = Fault::None;
  uint8_t phase = 255;
  uint8_t baselineFrames = 0;
  uint8_t requested = 0;
  uint8_t completed = 0;
  uint8_t echoed = 0;
  bool awaitingTimer = false;
  bool activeTx = false;
  bool txDone = false;
  uint32_t targetUs[4] = {};
  uint32_t startUs[4] = {};
  uint32_t doneUs[4] = {};
  uint32_t echoUs[4][2] = {};

  void CART_MODEL_IRAM abort(Fault why) {
    if (stage == Stage::Failed || stage == Stage::Response) return;
    fault = why;
    stage = Stage::Failed;
    awaitingTimer = false;
    activeTx = false;
  }

  Event CART_MODEL_IRAM onByte(uint8_t value, uint32_t atUs) {
    if (stage == Stage::Failed || stage == Stage::Response) return Event::None;
    const Octet event = {atUs, value};
    if (stage == Stage::SeekId0) {
      if (used_ < 4) header_[used_++] = event;
      else {
        for (uint8_t i = 0; i < 3; ++i) header_[i] = header_[i + 1];
        header_[3] = event;
      }
      uint8_t candidate = 255;
      if (used_ == 4 && validHeader(header_, 0, candidate)) {
        phase = candidate;
        lastSyncUs_ = header_[1].atUs;
        baselineFrames = 1;
        stage = Stage::Baseline;
        used_ = 0;
      }
      return Event::None;
    }

    if (stage == Stage::Request && requested > completed) {
      // Only exact local echo bytes, at physically expected byte-completion
      // times, can advance the request. A timer fire by itself is insufficient.
      if (awaitingTimer || !activeTx) {
        abort(Fault::EarlyRx);
        return Event::Abort;
      }
      const Word expected = word(variant_, completed);
      const uint8_t expectedByte = echoed == 0 ? expected.first : expected.second;
      const uint32_t expectedAt = startUs[completed] + (echoed == 0 ? 1042 : 2083);
      if (value != expectedByte) { abort(Fault::InvalidEcho); return Event::Abort; }
      if (!near(atUs, expectedAt, 175)) {
        abort(Fault::InvalidEchoTime);
        return Event::Abort;
      }
      echoUs[completed][echoed++] = atUs;
      if (echoed == 2) {
        if (txDone) return confirmWord();
        // TX_DONE may arrive in the same UART interrupt as byte 2.
      }
      return Event::None;
    }

    if (used_ >= 4) { abort(Fault::BadHeader); return Event::Abort; }
    header_[used_++] = event;
    if (used_ != 4) return Event::None;
    used_ = 0;
    const uint8_t id = stage == Stage::Baseline ? baselineFrames : requested;
    uint8_t nextPhase = 255;
    if (!validHeader(header_, id, nextPhase)) {
      abort(Fault::BadHeader);
      return Event::Abort;
    }
    if (nextPhase != phase) { abort(Fault::BadPhase); return Event::Abort; }
    const uint32_t syncUs = header_[1].atUs;
    // Baseline must be exactly 10ms ID-only. After local command words,
    // candidate 10ms or 12.5ms next-frame intervals are accepted.
    const uint32_t delta = syncUs - lastSyncUs_;
    const bool idOnlyGap = near(delta, 10000, 175);
    const bool commandGap = stage == Stage::Request && near(delta, 12500, 175);
    if (!idOnlyGap && !commandGap) {
      abort(Fault::BadCadence);
      return Event::Abort;
    }
    lastSyncUs_ = syncUs;
    if (stage == Stage::Baseline) {
      if (++baselineFrames == 16) {
        stage = Stage::Request;
        return Event::BaselineComplete;
      }
      return Event::None;
    }
    // Every request header is in the *next* continuous cycle, IDs 0..3.
    if (requested != completed || requested >= 4) {
      abort(Fault::MissingEcho);
      return Event::Abort;
    }
    targetUs[requested] = syncUs + 2917;  // reference 4+24 bits after sync2
    awaitingTimer = true;
    ++requested;
    return Event::ArmSlot;
  }

  bool CART_MODEL_IRAM onTimer(uint32_t firedUs) {
    if (stage != Stage::Request || !awaitingTimer ||
        requested != completed + 1 || activeTx) {
      abort(Fault::LateTimer);
      return false;
    }
    if (!near(firedUs, targetUs[completed], 175)) {
      abort(Fault::LateTimer);
      return false;
    }
    startUs[completed] = firedUs;
    awaitingTimer = false;
    activeTx = true;
    return true;
  }

  Event CART_MODEL_IRAM onTxDone(uint32_t atUs) {
    if (stage != Stage::Request || !activeTx || txDone || requested != completed + 1) {
      abort(Fault::UnexpectedTxDone);
      return Event::Abort;
    }
    // Two bytes at 9600 8N1 nominally require 2083 us. A hardware cutoff
    // at 2250 us will drop DE independent of the UART interrupt.
    const uint32_t duration = atUs - startUs[completed];
    if (duration < 1900 || duration >= 2250) {
      abort(Fault::InvalidTxDuration);
      return Event::Abort;
    }
    txDone = true;
    doneUs[completed] = atUs;
    if (echoed == 2) return confirmWord();
    return Event::None;
  }

 private:
  Variant variant_;
  Octet header_[4] = {};
  uint8_t used_ = 0;
  uint32_t lastSyncUs_ = 0;

  static bool CART_MODEL_IRAM near(uint32_t actual, uint32_t target, int32_t window) {
    const int32_t diff = static_cast<int32_t>(actual - target);
    return diff >= -window && diff <= window;
  }
  static bool CART_MODEL_IRAM validHeader(const Octet* x, uint8_t id, uint8_t& gapBits) {
    if (x[0].value || x[1].value || x[3].value != parity(x[2].value, id)) return false;
    if (!near(x[1].atUs, x[0].atUs + 1042, 175) ||
        !near(x[3].atUs, x[2].atUs + 1042, 175)) return false;
    if (near(x[2].atUs, x[1].atUs + 1042, 175)) gapBits = 0;
    else if (near(x[2].atUs, x[1].atUs + 1458, 175)) gapBits = 4;
    else return false;
    return true;
  }
  Event CART_MODEL_IRAM confirmWord() {
    if (!txDone || echoed != 2 || !activeTx) {
      abort(Fault::UnconfirmedRx);
      return Event::Abort;
    }
    ++completed;
    echoed = 0;
    txDone = false;
    activeTx = false;
    if (completed == 4) {
      stage = Stage::Response;
      return Event::RequestComplete;
    }
    return Event::None;
  }
};
}  // namespace cart_candidate
