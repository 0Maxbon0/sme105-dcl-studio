"""Host-only synthetic model verification; no USB port, ECU or ESP32 upload."""

import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CPP = r'''
#include "cart_b_active_model.h"
#include "stop_line_matcher.h"
#include <cassert>
#include <cstdio>
#include <initializer_list>
using namespace cart_candidate;

Event frame(FourWordRequest& m, unsigned absoluteId, unsigned phase,
            bool badParity = false, unsigned step = 10000) {
  unsigned sync = 100000u + absoluteId * step;
  unsigned id = absoluteId % 16;
  const Octet events[4] = {
    {sync-1042u, 0}, {sync, 0},
    {sync+1042u+phase*104u, 0},
    {sync+2084u+phase*104u, static_cast<uint8_t>(parity(0,id) ^ (badParity ? 0x10 : 0))}
  };
  Event result = Event::None;
  for (const auto e : events) result = m.onByte(e.value, e.atUs);
  return result;
}

void baseline(FourWordRequest& m, unsigned phase = 0) {
  for (unsigned i=0; i<16; ++i) {
    const auto got = frame(m,i,phase);
    assert(got == (i == 15 ? Event::BaselineComplete : Event::None));
  }
  assert(m.stage == Stage::Request && m.completed == 0);
}

Event echo(FourWordRequest& m, unsigned i, unsigned delay = 20, bool bad = false) {
  const auto w = word(m.variant(), i);
  const uint32_t start = m.startUs[i];
  assert(m.onByte(w.first, start + 1042 + delay) == Event::None);
  return m.onByte(static_cast<uint8_t>(w.second ^ (bad ? 0x10 : 0)),
                  start + 2083 + delay);
}

void happy(Variant variant, unsigned phase) {
  FourWordRequest m(variant);
  baseline(m,phase);
  for (unsigned i=0; i<4; ++i) {
    assert(frame(m,i+16,phase) == Event::ArmSlot);
    assert(m.targetUs[i] == 100000u + (i+16u)*10000u + 2917u);
    assert(m.onTimer(m.targetUs[i] + 12));
    assert(echo(m,i) == Event::None);
    const auto result = m.onTxDone(m.startUs[i] + 2140);
    assert(result == (i == 3 ? Event::RequestComplete : Event::None));
    assert(m.completed == i+1);
  }
  assert(m.stage == Stage::Response && m.completed == 4);
  assert(m.onByte(0xCC,500000) == Event::None); // response capture is separate
}

void badBaseline() {
  FourWordRequest m(Variant::FlxA4);
  assert(frame(m,0,0) == Event::None);
  assert(frame(m,1,0,true) == Event::Abort);
  assert(m.stage == Stage::Failed && m.requested == 0);
}
void missingEcho() {
  FourWordRequest m(Variant::FlxA4);
  baseline(m);
  assert(frame(m,16,0) == Event::ArmSlot);
  assert(m.onTimer(m.targetUs[0]));
  assert(m.onByte(0, m.startUs[0] + 1042) == Event::Abort);
  assert(m.completed == 0 && m.stage == Stage::Failed);
}
void wrongEcho() {
  FourWordRequest m(Variant::Don0E);
  baseline(m);
  assert(frame(m,16,0) == Event::ArmSlot);
  assert(m.onTimer(m.targetUs[0]));
  assert(echo(m,0,0,true) == Event::Abort);
  assert(m.fault == Fault::InvalidEcho);
}
void timerLate() {
  FourWordRequest m(Variant::FlxA4);
  baseline(m);
  assert(frame(m,16,0) == Event::ArmSlot);
  assert(!m.onTimer(m.targetUs[0] + 176));
  assert(m.fault == Fault::LateTimer && m.completed == 0);
}
void cutoffDuration() {
  FourWordRequest m(Variant::FlxA4);
  baseline(m);
  frame(m,16,0);
  assert(m.onTimer(m.targetUs[0]));
  echo(m,0);
  assert(m.onTxDone(m.startUs[0] + 2250) == Event::Abort);
  assert(m.fault == Fault::InvalidTxDuration);
}
void premature() {
  FourWordRequest m(Variant::FlxA4);
  baseline(m);
  frame(m,16,0);
  assert(m.onByte(0x01,m.targetUs[0]) == Event::Abort);
  assert(m.fault == Fault::EarlyRx);
}
void extraDone() {
  FourWordRequest m(Variant::FlxA4);
  baseline(m);
  assert(m.onTxDone(200000) == Event::Abort);
  assert(m.fault == Fault::UnexpectedTxDone);
}
void sourcePins() {
  assert(word(Variant::FlxA4,0).first == 0x01 && word(Variant::FlxA4,0).second == 0xB0);
  assert(word(Variant::FlxA4,1).first == 0xFF && word(Variant::FlxA4,1).second == 0x5F);
  assert(word(Variant::FlxA4,2).first == 0x26 && word(Variant::FlxA4,2).second == 0xA4);
  assert(word(Variant::Don0E,2).first == 0x26 && word(Variant::Don0E,2).second == 0x0E);
  assert(word(Variant::FlxA4,3).first == 0 && word(Variant::FlxA4,3).second == 0xA0);
}
void stopTokens() {
  for (const char* token : {"STOP\n", "STOP\r", "STOP\r\n", "garbage STOP\n"}) {
    StopLineMatcher matcher;
    unsigned hits = 0;
    for (const char* p = token; *p; ++p) if (matcher.consume(*p)) ++hits;
    assert(hits == 1);
  }
  StopLineMatcher matcher;
  for (const char* p = "STO\nSTOPXSTOP\n"; *p; ++p) {
    if (matcher.consume(*p)) {
      assert(p[0] == '\n');
      return;
    }
  }
  assert(false && "complete STOP must be recognized");
}
int main() {
  happy(Variant::FlxA4,0);
  happy(Variant::FlxA4,4);
  happy(Variant::Don0E,0);
  badBaseline(); missingEcho(); wrongEcho(); timerLate(); cutoffDuration();
  premature(); extraDone(); sourcePins(); stopTokens();
  std::puts("12/12 synthetic CART B candidate state-machine/STOP checks PASS");
}
'''


def main():
    with tempfile.TemporaryDirectory(prefix="cart-active-model-") as tmp:
        src = Path(tmp) / "test.cpp"
        exe = Path(tmp) / "test"
        src.write_text(CPP)
        subprocess.run(["g++", "-std=c++11", "-O2", "-Wall", "-Wextra", "-Werror",
                        "-I", str(ROOT), str(src), "-o", str(exe)], check=True)
        subprocess.run([str(exe)], check=True)


if __name__ == "__main__":
    main()
