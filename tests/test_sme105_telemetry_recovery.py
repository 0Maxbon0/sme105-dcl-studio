"""Host-side tests for the firmware's retained-live recovery contract."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"


def _function(source: str, signature: str) -> str:
    """Return one C++ function, including nested blocks, from the sketch."""
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated function: {signature}")


class TelemetryRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.code = SOURCE.read_text(encoding="utf-8")

    def test_cpp_actual_resume_and_ping_protocol_with_bounded_ring(self) -> None:
        if not shutil.which("g++"):
            self.skipTest("g++ unavailable")

        code = self.code
        functions = "\n".join(
            _function(code, signature)
            for signature in (
                "bool parseUnsignedDecimal(",
                "bool validPingNonce(",
                "bool handlePingLine(",
                "bool parseResumeArgs(",
                "void printHex32(",
                "void denyResume(",
                "void processRecoveryLine(",
                "void serviceTelemetryReplay(",
            )
        )
        cpp = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include "telemetry_ring.h"
#define F(value) value

class WiFiClient {};
class Print {
 public:
  std::string text;
  void print(const char* value) { text += value; }
  void print(char* value) { text += value; }
  void print(char value) { text += value; }
  template <class T> void print(T value) { text += std::to_string(value); }
  void println() { text += '\n'; }
  template <class T> void println(T value) { print(value); text += '\n'; }
  size_t freeBytes() const { return 4096; }
  bool tcpSendFailed() const { return false; }
  void drainTCP(WiFiClient&) {}
  void write(const uint8_t* data, size_t size) {
    text.append(reinterpret_cast<const char*>(data), size);
  }
};

enum Stage { IDLE, CART_READ, FINISHING, FAULTED };
enum Fault { HOST_STOP };
enum RecoveryState {
  RECOVERY_IDLE, RECOVERY_DETACHED, RECOVERY_PENDING_RESUME,
  RECOVERY_REPLAYING, RECOVERY_LIVE
};
Print out;
TelemetryRing telemetryRing;
uint32_t bootId = 0x1234ABCD, sessionId = 0x89ABCDEF;
uint32_t telemetryReplaySeq = 0;
uint32_t sessionDetachedAtMs = 0;
bool sessionRetained = true, telemetryReplayActive = false;
RecoveryState recoveryState = RECOVERY_PENDING_RESUME;
bool tcpAuthenticated = false, remoteIsBle = false;
WiFiClient wifiClient;
Stage stage = CART_READ;
uint8_t variant = 2;
uint8_t armedVariant = 255;
bool busSessionActive() { return stage != IDLE && stage != FINISHING && stage != FAULTED; }
const char* variantName(uint8_t) { return "LIVE"; }
void printStatus() {}
void stopEverything(Fault) {
  stage = FINISHING;
  sessionRetained = false;
  recoveryState = RECOVERY_IDLE;
}
''' + functions + r'''

int main() {
  assert(validPingNonce("z9AZ"));
  assert(validPingNonce("0123456789abcdef"));
  assert(!validPingNonce("0123456789abcdefg"));
  assert(!validPingNonce("bad-characters"));
  assert(!validPingNonce(""));

  const uint8_t byte = 0x42;
  telemetryRing.push(10, byte);
  telemetryRing.push(20, byte);
  char ping[] = "PING abc123";
  assert(handlePingLine(ping));
  assert(out.text == "PONG abc123 boot=1234ABCD session=89ABCDEF seq=2\n");
  out.text.clear();
  char badPing[] = "PING bad!";
  assert(handlePingLine(badPing));
  assert(out.text == "DENIED ping_format\n");
  out.text.clear();
  char notPing[] = "PINGX";
  assert(!handlePingLine(notPing));

  uint32_t parsedBoot = 0, parsedSession = 0, parsedSeq = 0;
  char parsed[] = "RESUME 1234abcd 89ABCDEF 4294967295";
  assert(parseResumeArgs(parsed, parsedBoot, parsedSession, parsedSeq));
  assert(parsedBoot == bootId && parsedSession == sessionId && parsedSeq == UINT32_MAX);
  char malformed[] = "RESUME 123456789 89ABCDEF 1";
  assert(!parseResumeArgs(malformed, parsedBoot, parsedSession, parsedSeq));
  char overflow[] = "RESUME 1234ABCD 89ABCDEF 4294967296";
  assert(!parseResumeArgs(overflow, parsedBoot, parsedSession, parsedSeq));

  char wrongBoot[] = "RESUME 00000000 89ABCDEF 0";
  processRecoveryLine(wrongBoot);
  assert(out.text == "RESUME DENIED reason=session_expired boot=1234ABCD boot_id=1234ABCD session=89ABCDEF session_id=89ABCDEF\n");
  out.text.clear();
  char wrongSession[] = "RESUME 1234ABCD 00000001 0";
  processRecoveryLine(wrongSession);
  assert(out.text == "RESUME DENIED reason=session_expired boot=1234ABCD boot_id=1234ABCD session=89ABCDEF session_id=89ABCDEF\n");

  out.text.clear();
  char validResume[] = "RESUME 1234ABCD 89ABCDEF 1";
  processRecoveryLine(validResume);
  assert(out.text == "RESUME OK boot=1234ABCD boot_id=1234ABCD session=89ABCDEF session_id=89ABCDEF first_seq=1 latest_seq=2 gap=0 from=0 to=0 variant=LIVE stage=1\n");
  assert(!sessionRetained && telemetryReplayActive && telemetryReplaySeq == 2);
  assert(recoveryState == RECOVERY_REPLAYING);

  telemetryRing.reset();
  for (uint32_t i = 0; i < 8109; ++i) telemetryRing.push(i, byte);
  assert(telemetryRing.size() == TelemetryRing::kRecordCapacity);
  assert(telemetryRing.dropped() == 109);
  assert(telemetryRing.firstSeq() == 110 && telemetryRing.latestSeq() == 8109);
  TelemetryRing::Record record;
  assert(!telemetryRing.get(109, record));
  assert(telemetryRing.get(110, record) && record.seq == 110 &&
         record.at == 109 && record.value == byte);
  const TelemetryRing::Range range = telemetryRing.range(100);
  assert(range.gap == 9 && range.from == 101 && range.to == 109 &&
         range.replayFrom == 110);
  const TelemetryRing::Range future = telemetryRing.range(8110);
  assert(future.future);
  assert(TelemetryRing::nextSequence(UINT32_MAX) == 1);
  assert(TelemetryRing::previousSequence(1) == UINT32_MAX);
  assert(TelemetryRing::sequenceDistance(UINT32_MAX, 1) == 1);
  assert(TelemetryRing::sequenceAfter(1, UINT32_MAX));

  sessionRetained = true;
  telemetryReplayActive = false;
  telemetryReplaySeq = 0;
  recoveryState = RECOVERY_PENDING_RESUME;
  out.text.clear();
  char futureResume[] = "RESUME 1234ABCD 89ABCDEF 8110";
  processRecoveryLine(futureResume);
  assert(out.text == "RESUME DENIED reason=future_cursor boot=1234ABCD boot_id=1234ABCD session=89ABCDEF session_id=89ABCDEF\n");
  assert(sessionRetained && recoveryState == RECOVERY_PENDING_RESUME);

  out.text.clear();
  char resumeAcrossGap[] = "RESUME 1234ABCD 89ABCDEF 100";
  processRecoveryLine(resumeAcrossGap);
  assert(out.text == "RESUME OK boot=1234ABCD boot_id=1234ABCD session=89ABCDEF session_id=89ABCDEF first_seq=110 latest_seq=8109 gap=9 from=101 to=109 variant=LIVE stage=1\nEVENT telemetry_gap lost=9 from=101 to=109\n");
  assert(telemetryReplayActive && telemetryReplaySeq == 110);
  assert(recoveryState == RECOVERY_REPLAYING);

  telemetryReplaySeq = 101; // eviction overtakes the replay cursor
  telemetryReplayActive = true;
  out.text.clear();
  serviceTelemetryReplay();
  assert(out.text.find("EVENT telemetry_gap lost=9 from=101 to=109\n") == 0);
  assert(out.text.find("RX t_us=109 byte=42 seq=110\n") != std::string::npos);

  recoveryState = RECOVERY_PENDING_RESUME;
  out.text.clear();
  char deniedCommand[] = "HELLO";
  processRecoveryLine(deniedCommand);
  assert(out.text == "DENIED recovering\n");
  return 0;
}
'''
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "recovery.cc"
            binary = root / "recovery"
            source.write_text(cpp, encoding="utf-8")
            subprocess.run(
                ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                 "-I", str(SOURCE.parent), str(source), "-o", str(binary)],
                check=True, capture_output=True, timeout=20,
            )
            subprocess.run([str(binary)], check=True, timeout=10)

    def test_retention_timeout_is_thirty_seconds_and_stops_capture(self) -> None:
        match = re.search(r"constexpr uint32_t kSessionRetentionMs = (\d+);", self.code)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), 30_000)

        loop = _function(self.code, "void loop()")
        self.assertRegex(
            loop,
            r"sessionRetained\s*&&\s*static_cast<uint32_t>\(\s*millis\(\)\s*-\s*"
            r"sessionDetachedAtMs\s*\)\s*>=\s*kSessionRetentionMs",
        )
        self.assertRegex(
            loop,
            r"sessionRetained\s*=\s*false;\s*stopEverything\(CAPTURE_TIMEOUT\);",
        )

        if not shutil.which("g++"):
            return
        timeout_guard = re.search(
            r"if\s*\((?P<condition>sessionRetained\s*&&\s*static_cast<uint32_t>\(\s*"
            r"millis\(\)\s*-\s*sessionDetachedAtMs\s*\)\s*>=\s*kSessionRetentionMs)"
            r"\s*\)\s*\{(?P<body>\s*sessionRetained\s*=\s*false;\s*"
            r"stopEverything\(CAPTURE_TIMEOUT\);\s*)\}",
            loop,
        )
        self.assertIsNotNone(timeout_guard)
        cpp = f"""
#include <cassert>
#include <cstdint>
constexpr uint32_t kSessionRetentionMs = {int(match.group(1))};
uint32_t nowMs = 0, sessionDetachedAtMs = 0;
bool sessionRetained = false;
enum Fault {{ CAPTURE_TIMEOUT }};
uint32_t stops = 0;
Fault lastReason = CAPTURE_TIMEOUT;
uint32_t millis() {{ return nowMs; }}
void stopEverything(Fault reason) {{ ++stops; lastReason = reason; }}
void checkRetention() {{
  if ({timeout_guard.group('condition')}) {{
    {timeout_guard.group('body')}
  }}
}}
int main() {{
  sessionRetained = true; sessionDetachedAtMs = 0; nowMs = 29999;
  checkRetention(); assert(stops == 0 && sessionRetained);
  nowMs = 30000; checkRetention();
  assert(stops == 1 && !sessionRetained && lastReason == CAPTURE_TIMEOUT);
  sessionRetained = true; sessionDetachedAtMs = 0xfffffff0u;
  nowMs = sessionDetachedAtMs + 29999u; checkRetention();
  assert(stops == 1 && sessionRetained);
  nowMs = sessionDetachedAtMs + 30000u; checkRetention();
  assert(stops == 2 && !sessionRetained && lastReason == CAPTURE_TIMEOUT);
}}
"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "timeout.cc"
            binary = root / "timeout"
            source.write_text(cpp, encoding="utf-8")
            subprocess.run(
                ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                 str(source), "-o", str(binary)],
                check=True, capture_output=True, timeout=20,
            )
            subprocess.run([str(binary)], check=True, timeout=10)

    def test_all_rxb_batches_include_the_first_byte_sequence(self) -> None:
        flush = _function(self.code, "void flushRaw(")
        self.assertIn('"RXB t_us=%lu seq_start=%lu data="', flush)
        self.assertRegex(flush, r"if\s*\(!i\)\s*seqStart\s*=\s*seq")
        self.assertIn("retainTelemetryEvent(", flush)

    def test_recovery_barrier_buffers_live_output_until_replay_finishes(self) -> None:
        self.assertRegex(
            self.code,
            r"enum RecoveryState\s*:\s*uint8_t\s*\{\s*RECOVERY_IDLE,\s*"
            r"RECOVERY_DETACHED,\s*RECOVERY_PENDING_RESUME,\s*RECOVERY_REPLAYING,\s*"
            r"RECOVERY_LIVE",
        )
        flush = _function(self.code, "void flushRaw(")
        for state in (
            "RECOVERY_DETACHED",
            "RECOVERY_PENDING_RESUME",
            "RECOVERY_REPLAYING",
        ):
            self.assertIn(state, flush)
        self.assertIn("bufferOnly || telemetryReplayActive", flush)
        recovery = _function(self.code, "void processRecoveryLine(")
        self.assertIn('!strcmp(line, "PING")', recovery)
        self.assertIn('!strcmp(line, "STATUS")', recovery)
        self.assertIn('!strcmp(line, "STOP")', recovery)
        self.assertIn('!strncmp(line, "RESUME", 6)', recovery)
        self.assertIn('out.println(F("DENIED recovering"))', recovery)
        replay = _function(self.code, "void serviceTelemetryReplay(")
        self.assertIn("recoveryState = RECOVERY_LIVE", replay)
        self.assertIn("TelemetryRing::sequenceDistance(telemetryReplaySeq, first)", replay)
        self.assertIn("TelemetryRing::previousSequence(first)", replay)

    def test_future_resume_cursor_is_denied_and_ap_disconnect_is_scoped(self) -> None:
        recovery = _function(self.code, "void processRecoveryLine(")
        self.assertIn("if (range.future)", recovery)
        self.assertIn('denyResume("future_cursor")', recovery)
        auth = _function(self.code, "void processTcpLine(")
        self.assertIn("recoveryState = RECOVERY_PENDING_RESUME", auth)
        self.assertIn("if (recoveryState == RECOVERY_PENDING_RESUME)", auth)
        disconnect = _function(self.code, "void pollApStaDisconnectEvents(")
        self.assertIn("memcmp(event.mac, tcpPeerMac", disconnect)
        self.assertIn("apStationMacForClient(wifiClient, tcpPeerMac)", self.code)
        ap_loop = _function(self.code, "void pollWiFi(")
        self.assertRegex(ap_loop, r"if\s*\(busSessionActive\(\)\)\s*return;\s*"
                                 r"if\s*\(directApRetryDue")

    def test_transport_loss_retains_only_active_live_polling_and_keeps_mode_21(self) -> None:
        drop = _function(self.code, "void dropTcpClient(bool transportLost)")
        retained = re.search(
            r"if\s*\(isLiveVariant\(variant\)\s*&&\s*stage\s*==\s*CART_READ\s*&&\s*"
            r"dpsBlocks\s*>=\s*1(?:\s*&&\s*allMapSafe)?\)\s*\{(?P<body>.*?)\}\s*else if\s*"
            r"\(busSessionActive\(\)\)\s*\{(?P<stop>.*?)\}",
            drop,
            re.DOTALL,
        )
        self.assertIsNotNone(retained)
        self.assertIn("if (transportLost && tcpAuthenticated)", drop)
        self.assertIn("allMapSafe", drop)
        self.assertIn("dpsBlocks >= 2", drop)
        self.assertIn("pidWordsVerified >= kAllLiveMapWords", drop)
        self.assertIn("sessionRetained = true;", retained.group("body"))
        self.assertIn("sessionDetachedAtMs = millis();", retained.group("body"))
        self.assertIn("stopEverything(HOST_STOP);", retained.group("stop"))

        dps = _function(self.code, "CmdWord IRAM_ATTR dpsWord(uint8_t index)")
        command_word = _function(self.code, "constexpr CmdWord IRAM_ATTR word(uint8_t variant, uint8_t slot)")
        self.assertIn("isLiveVariant(variant) && index == 2 && dpsBlocks == 0", dps)
        self.assertIn("return CmdWord{0x41, 0x96};", dps)
        self.assertIn("isLiveVariant(variant) ? CmdWord{0x21,0xF6}", command_word)
        # The retained transport branch requires an already completed first
        # block, so recovery continues with 21H polling and never reloads 41H.
        self.assertIn("dpsBlocks >= 1", retained.group(0))

        loop = _function(self.code, "void loop()")
        self.assertIn("pollActive();", loop)
        poll = _function(self.code, "void pollActive()")
        self.assertNotIn("tcpAuthenticated", poll)
        self.assertNotIn("sessionRetained", poll)


if __name__ == "__main__":
    unittest.main()
