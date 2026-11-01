# Implementation status

See `ROADMAP.md` for the phase plan and `STATUS_REPORT.md` for the 2026-08-22
situation narrative. This file records verification state only.

## Implemented and verified (host / bench)

- ASCII USB capture with raw-byte preservation, rotation, reconnect handling,
  metadata, timestamps, and create-only session directories.
- Fixed-record binary capture with SLIP recovery, CRC16 validation, MCU
  timestamps, UART status events, and direction fields.
- Candidate 12-bit word/parity validation, pair-offset scoring, gap/direction
  framing hypotheses, and 32-byte response scoring.
- Reference/unverified SME-105 live-data profile, DTC catalog, safe symbolic
  command state machine, operator markers, correlation helpers, and
  evidence-based high-idle branch classifier.
- Receive-only ASCII, binary, and `sniffer` (9600 8N1, GPIO16, no UART TX pin)
  sketches plus a default-receive active master shell with no enabled wire
  transactions. Desk `bench_test` drives A+/B− and is not for the vehicle.
- Localhost-only cross-platform Diagnostic Studio: token-protected REST and
  WebSocket services, guided setup, capture until Stop, serial discovery, live
  logs, session analysis, DTC lookup, high-idle records, firmware controls,
  Desk Bench Test page, and locked active-master upload.
- Windows launcher (`Launch Studio.bat`), venv bootstrap, PlatformIO in `.venv`.
- Host tests passing on the Windows 3.14 venv; `esp32dev` compilation of
  sniffer, bench_test, and the original three sketches.
- CP2102 **Observed** on Linux `/dev/ttyUSB0` and Windows **COM7**,
  VID:PID `10C4:EA60`, serial `0001`.
- Desk XY-K485 differential loopback **Observed PASS**. On this clone, module
  **RXD** is the TTL receiver output into GPIO16.

## Not vehicle-verified

- No preserved SME-105 KOEO/KOER capture exists yet.
- OBD pins 3 and 11 remain **Reference** polarity candidates, not Observed
  DCL+ / DCL− on this ECU.
- 9600 8N1 is the operator-selected sniffer setting. Public EEC-IV notes use
  8N2 (**Reference**). Neither is proven on SME-105.
- Exact DCL request bytes remain unverified and disabled.
- No diagnosis has been made. The example evidence file intentionally produces
  `insufficient_evidence`.

## Required external evidence

1. Flash listen-only firmware (`sniffer` or 8N2 passive sketch). Remove
   `bench_test` from the ESP32. Pull module DI/TXD idle-high.
2. Connect receive-only with ignition off: ground first, then A/B; never pin 16.
3. Start host capture, then KOEO. Preserve the raw session even if silent.
4. If BREAK persists, power down before polarity/ground checks. New session
   after any wiring change.
5. Validate UART candidates (8N1 vs 8N2, 9600 vs 19200) with separately labelled
   captures before active work.
6. Replace the XY-K485 with an explicit-DE/RE protected 3.3 V transceiver
   before commissioning any active master.
7. Obtain or independently verify complete safe DCL request transactions.
8. Run three synchronized warm-idle sessions and the reversible physical
   IAC-airflow isolation procedure before accepting a diagnosis branch.
