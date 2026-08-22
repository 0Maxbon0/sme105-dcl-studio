# Implementation status

See `ROADMAP.md` for the full phase plan, remaining gates, and next physical
work. This file records verification state only.

## Implemented and verified

- ASCII USB capture with raw-byte preservation, rotation, reconnect handling,
  metadata, timestamps, and create-only session directories.
- Fixed-record binary capture with SLIP recovery, CRC16 validation, MCU
  timestamps, UART status events, and direction fields.
- Candidate 12-bit word/parity validation, pair-offset scoring, gap/direction
  framing hypotheses, and 32-byte response scoring.
- Reference/unverified SME-105 live-data profile, DTC catalog, safe symbolic
  command state machine, operator markers, correlation helpers, and
  evidence-based high-idle branch classifier.
- Receive-only ASCII and binary ESP32 sketches plus a default-receive active
  master shell with no enabled wire transactions.
- Localhost-only cross-platform Diagnostic Studio with token-protected REST and
  WebSocket services, guided safety/setup questions, complete capture settings,
  serial discovery, live logs, session analysis, DTC lookup, high-idle evidence
  records, embedded documentation, and locked firmware controls.
- Native Ubuntu PyInstaller bundle plus Windows-native build and launch scripts.
- Host tests, Python compile checks, focused Ruff checks, editable package
  installation, CLI/API smoke tests, and successful `esp32dev` board
  compilation.
- CP2102 detection at `/dev/ttyUSB0`, successful passive-binary firmware upload,
  and guarded handling of the expected USB-only/unconnected RX break condition.

## Not vehicle-verified

- The K485 is not connected to the ECU; the current physical state is ESP32 USB
  only.
- The group database includes the user in `dialout`, but any Cursor process
  started before logout/login must be fully restarted to inherit that group.
- No SME-105 bytes, parity rate, baud/stop-bit observation, frame, PID, DTC,
  warm-idle session, or airflow-isolation result has been captured.
- Exact DCL request bytes remain unverified and disabled. The active firmware
  cannot transmit a DCL request as shipped.
- No diagnosis has been made. The example evidence file intentionally produces
  `insufficient_evidence`.

## Required external evidence

1. Fully restart Cursor/terminal so the process inherits `dialout`.
2. When vehicle access is available, connect the common reference and K485 in
   receive-only mode using the guided wiring checklist.
3. Run a bounded KOEO passive capture and preserve the raw session.
4. Validate electrical polarity and UART candidates before active work.
5. Replace the XY-K485 with an explicit-DE/RE protected 3.3 V transceiver
   before commissioning any active master.
6. Obtain or independently verify complete safe DCL request transactions.
7. Run three synchronized warm-idle sessions and the reversible physical
   IAC-airflow isolation procedure before accepting a diagnosis branch.
