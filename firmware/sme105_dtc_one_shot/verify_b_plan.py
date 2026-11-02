#!/usr/bin/env python3
"""Compile and exercise the ISR-safe pure CART B dry-run state machine.

This uses synthetic frames and never opens the serial port or an ECU device.
It proves software gating only; hardware timer latency and vehicle compatibility
still require differential bench instrumentation.
"""

from pathlib import Path
import subprocess
import tempfile

HEADER = Path(__file__).resolve().parent
TEST = r"""
#include "cart_b_plan.h"
#include <cassert>
#include <cstdio>

using namespace cart_b_plan;

Outcome frame(FourWordDryRun& plan, int frameIndex, int phase,
              bool badParity = false) {
    const uint8_t id = frameIndex % 16;
    const uint32_t syncB = 100000 + frameIndex * 10000;
    const uint8_t second = parity(0, id) ^ (badParity ? 0x10 : 0);
    Outcome ret = Outcome::Nothing;
    const ByteEvent events[4] = {
        {syncB - 1042, 0},
        {syncB, 0},
        {syncB + 1042 + static_cast<uint32_t>(phase * 104), 0},
        {syncB + 2084 + static_cast<uint32_t>(phase * 104), second},
    };
    for (auto e : events) ret = plan.onByte(e.value, e.timeUs);
    return ret;
}

void testComplete(int phase) {
    FourWordDryRun plan;
    for (int frameIndex = 0; frameIndex < 32; ++frameIndex) {
        const Outcome outcome = frame(plan, frameIndex, phase);
        if (frameIndex < 15) assert(outcome == Outcome::Nothing);
        if (frameIndex == 15) assert(outcome == Outcome::BaselineReady);
        if (frameIndex >= 16 && frameIndex <= 19) {
            assert(outcome == Outcome::ScheduleSlot);
            assert(plan.baselineFrames == 16);
            assert(plan.scheduled == frameIndex - 15);
            assert(plan.dueUs[frameIndex - 16] ==
                   100000u + static_cast<uint32_t>(frameIndex) * 10000u + 2917u);
            const auto word = wordForFrame(frameIndex - 16);
            assert(parity(word.first, word.second & 15) == word.second);
            assert(plan.onTimer(plan.dueUs[frameIndex - 16] + 30) == Outcome::Nothing);
        }
        if (frameIndex == 31) assert(outcome == Outcome::Finished);
    }
    assert(plan.stage == Stage::Complete);
    assert(plan.reason == Reason::None);
    assert(plan.scheduled == 4 && plan.fired == 4);
    assert(plan.headerPhaseBits == phase);
}

void testNoBaselineNoSchedule() {
    FourWordDryRun plan;
    for (int frameIndex = 0; frameIndex < 15; ++frameIndex)
        assert(frame(plan, frameIndex, 0) == Outcome::Nothing);
    assert(plan.stage == Stage::Baseline && plan.scheduled == 0);
}

void testParityFailure() {
    FourWordDryRun plan;
    for (int i = 0; i < 5; ++i) frame(plan, i, 0);
    assert(frame(plan, 5, 0, true) == Outcome::Rejected);
    assert(plan.stage == Stage::Failed && plan.reason == Reason::InvalidHeader);
    assert(plan.scheduled == 0);
}

void testMissingTimer() {
    FourWordDryRun plan;
    for (int i = 0; i <= 16; ++i) frame(plan, i, 0);
    assert(plan.scheduled == 1 && plan.fired == 0);
    assert(frame(plan, 17, 0) == Outcome::Rejected);
    assert(plan.stage == Stage::Failed && plan.reason == Reason::MissingTimer);
}

void testTimerJitter() {
    FourWordDryRun plan;
    for (int i = 0; i <= 16; ++i) frame(plan, i, 0);
    assert(plan.onTimer(plan.dueUs[0] + 176) == Outcome::Rejected);
    assert(plan.stage == Stage::Failed && plan.reason == Reason::TimerTooLate);
}

void testPhaseChange() {
    FourWordDryRun plan;
    assert(frame(plan, 0, 0) == Outcome::Nothing);
    assert(frame(plan, 1, 4) == Outcome::Rejected);
    assert(plan.stage == Stage::Failed && plan.reason == Reason::InvalidPhase);
}

void testOutOfOrder() {
    FourWordDryRun plan;
    frame(plan, 0, 0);
    assert(frame(plan, 2, 0) == Outcome::Rejected);
    assert(plan.stage == Stage::Failed);
}

int main() {
    testComplete(0);
    testComplete(4);
    testNoBaselineNoSchedule();
    testParityFailure();
    testMissingTimer();
    testTimerJitter();
    testPhaseChange();
    testOutOfOrder();
    puts("8/8 CART B dry-run synthetic state-machine checks PASS");
}
"""


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cart-b-plan-") as folder:
        source = Path(folder) / "test.cpp"
        executable = Path(folder) / "test"
        source.write_text(TEST)
        subprocess.run(
            ["g++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(HEADER),
             str(source), "-o", str(executable)], check=True
        )
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
