#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

// Fixed-capacity task-context retention for raw telemetry bytes. Sequence IDs
// skip zero, so zero remains the wire sentinel for "no cursor yet".
class TelemetryRing {
 public:
  static constexpr size_t kRecordCapacity = 8000;
  static constexpr size_t kStaticLimit = 48 * 1024;

  struct Record {
    uint32_t seq;
    uint32_t at;
    uint8_t value;
  };

  struct __attribute__((packed)) Event {
    uint32_t at;
    uint8_t value;
  };

  struct Range {
    uint32_t first;
    uint32_t latest;
    uint32_t requested;
    uint32_t replayFrom;
    uint32_t gap;
    uint32_t from;
    uint32_t to;
    bool future;
  };

  static uint32_t nextSequence(uint32_t seq) {
    ++seq;
    return seq ? seq : 1;
  }

  static uint32_t previousSequence(uint32_t seq) {
    --seq;
    return seq ? seq : UINT32_MAX;
  }

  // Number of valid, nonzero sequence steps from `from` to `to`.
  static uint32_t sequenceDistance(uint32_t from, uint32_t to) {
    if (!from || !to || from == to) return 0;
    return to >= from ? to - from : (UINT32_MAX - from) + to;
  }

  static bool sequenceAfter(uint32_t value, uint32_t reference) {
    if (!value || !reference || value == reference) return false;
    const uint32_t distance = value - reference;
    return distance < 0x80000000UL;
  }

  TelemetryRing() { reset(); }

  void reset() {
    firstIndex_ = 0;
    count_ = 0;
    firstSeq_ = 0;
    latestSeq_ = 0;
    dropped_ = 0;
  }

  uint32_t push(uint32_t at, uint8_t value) {
    const uint32_t seq = nextSequence(latestSeq_);
    if (count_ == kRecordCapacity) {
      firstIndex_ = (firstIndex_ + 1) % kRecordCapacity;
      firstSeq_ = nextSequence(firstSeq_);
      ++dropped_;
    } else {
      if (!count_) firstSeq_ = seq;
      ++count_;
    }

    Event& event = events_[(firstIndex_ + count_ - 1) % kRecordCapacity];
    event.at = at;
    event.value = value;
    latestSeq_ = seq;
    return seq;
  }

  uint32_t firstSeq() const { return count_ ? firstSeq_ : 0; }
  uint32_t latestSeq() const { return latestSeq_; }
  uint32_t dropped() const { return dropped_; }
  size_t size() const { return count_; }

  Range range(uint32_t lastSeen) const {
    Range result = {firstSeq(), latestSeq_, 0, 0, 0, 0, 0, false};
    if (lastSeen &&
        (latestSeq_ == 0 || sequenceAfter(lastSeen, latestSeq_))) {
      result.future = true;
      return result;
    }
    if (!count_) return result;

    const uint32_t requested = nextSequence(lastSeen);
    result.requested = requested;
    if (sequenceAfter(requested, result.latest)) return result;
    if (sequenceAfter(result.first, requested)) {
      result.gap = sequenceDistance(requested, result.first);
      result.from = requested;
      result.to = previousSequence(result.first);
      result.replayFrom = result.first;
    } else {
      result.replayFrom = requested;
    }
    return result;
  }

  bool get(uint32_t seq, Record& output) const {
    if (!count_ || !seq || sequenceAfter(firstSeq_, seq) ||
        sequenceAfter(seq, latestSeq_)) return false;
    const uint32_t offset = sequenceDistance(firstSeq_, seq);
    if (offset >= count_) return false;
    const Event& event = events_[(firstIndex_ + offset) % kRecordCapacity];
    output = {seq, event.at, event.value};
    return true;
  }

 private:
  Event events_[kRecordCapacity] = {};
  size_t firstIndex_ = 0;
  size_t count_ = 0;
  uint32_t firstSeq_ = 0;
  uint32_t latestSeq_ = 0;
  uint32_t dropped_ = 0;
};

static_assert(sizeof(TelemetryRing::Event) == 5,
              "telemetry events must stay packed at five bytes");
static_assert(TelemetryRing::kRecordCapacity >= 4096 &&
                  TelemetryRing::kRecordCapacity <= 8000,
              "telemetry ring capacity must stay between 4096 and 8000 slots");
static_assert(sizeof(TelemetryRing::Event) * TelemetryRing::kRecordCapacity <=
                  TelemetryRing::kStaticLimit,
              "telemetry ring must stay within 48 KiB");
static_assert(sizeof(TelemetryRing) <= TelemetryRing::kStaticLimit,
              "telemetry ring object must stay within 48 KiB");
