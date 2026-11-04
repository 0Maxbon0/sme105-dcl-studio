# Ford SME-105 — first CART candidate: offline inspection (2026-11-02)

## Raw evidence

- Preserved operator transcript: `captures/CART_ONCE/20261102T150417765534Z.txt`.
- Transcript SHA-256 (rechecked 2026-11-02):
  `857c83e98fa6197c089ba0599c449b90513f06dbc9ce5601b97d9d862a7b213c`.
- Generated offline products, leaving original intact:
  - `captures/CART_ONCE/20261102T150417765534Z.analysis.json`
  - `captures/CART_ONCE/20261102T150417765534Z.frames.csv`
- Inspector: `scripts/analyze_cart_once.py` (read-only, never opens USB/DCL).
- Single vehicle session with engine OFF / ignition ON, as reported by operator.
- Driver enable was limited to one Echo ID and one Go CART; capture reports
  `CART_MONITOR 9600 8N1 duration_ms=10000 TX_DISABLED`.

## Observed, not guessed

- Echo ID sent: `11` bytes, watchdog `OK`.
- Hello receive: the same 11 bytes plus `01`; candidate ACK only.
- Go CART sent: `11` bytes, watchdog `OK`.
- Recorded CART: **3984** UART RX bytes in ten seconds, **249** 16-byte
  log batches. All 3984 match a single repeating 64-byte cycle exactly.
- Cycle: 16 consecutive four-byte groups, frame IDs 0..15:

  `00 00 00 A0 | 00 00 00 B1 | 00 00 00 82 | 00 00 00 93 |`
  `00 00 00 E4 | 00 00 00 F5 | 00 00 00 C6 | 00 00 00 D7 |`
  `00 00 00 28 | 00 00 00 39 | 00 00 00 0A | 00 00 00 1B |`
  `00 00 00 6C | 00 00 00 7D | 00 00 00 4E | 00 00 00 5F`

- Every 4-byte group matches reference candidate `00 00` sync then
  parity-coded ID word `00 XY`, where `XY=((ID xor A)<<4)|ID`.
- **62 complete** 64-byte cycles plus 16 further bytes (4 frames).
- All 996 four-byte groups match expected sync+ID structure, with
  **zero** differing bytes. Displayed batch cadence is ~40 ms per 16 bytes,
  equivalent to ~160 ms for a complete 16-ID cycle. Host logs are batched,
  so timestamps cannot be used as per-byte edge timings.
- Precisely **249** USB log batches of 16 decoded bytes; first batch
  `t_ms=74`, last `t_ms=9992`. The 248 displayed inter-batch intervals
  are **246 × 40ms** and **2 × 39ms**, mean **39.992ms**; implied frame
  spacing for these four-frame batches is **~9.998ms**, an estimate from
  batched MCU logs rather than sampled bus edges.
- Per-ID counts: IDs `0`–`3` appear 63 times each, `4`–`15`
  appear 62 times each. The terminal stream ends partway through the
  next complete 16-ID cycle, as expected for a finite timed capture.
- All four bytes of every group are accounted for by **sync** (`00 00`)
  and a reference parity/ID word (`00 XY`). There are **no additional
  PID-value bytes** in any of the 996 groups. The all-zero status/low-data
  region is *not* proof that any sensor is actually reporting a zero value.
- The operator transcript's final line ends with
  `CART_DONE bytes=3984 uart_errors`. The **actual UART error count is
  UNKNOWN**: the host previously stopped reading on seeing the substring
  `CART_DONE ` before the firmware had finished printing that line. This
  has been fixed for subsequent sessions; do not impute `0` errors here.

## Interpretation and boundaries

- This is strong protocol evidence for a Ford EEC-IV-compatible CART
  frame-ID stream after the reference 2400 8N2 Echo-ID/Go-CART handshake
  and UART transition to 9600 8N1.
- Reference: https://github.com/doncreat0r/eeciv/blob/master/Diag324.c
  (especially `cmdEchoID`, `cmdGoCART`, `modeWaitID`,
  `modeInCART` and the zero sync/vertical parity handling).
- The decoded 4-byte groups contain only a sync and a parity-coded frame
  ID, **not a demonstrated live PID/sensor reading or DTC**.
- An exact repeating 16-ID cycle is substantially stronger evidence than
  random UART noise, especially following the conditional handshake; however
  **an entire missing 64-byte cycle is not detectable** from ID order
  alone. This file does not contain per-byte timestamps or electrical
  measurements and cannot certify that the MCU captured every physical bit.
- Signal origin has not been independently verified by electrical capture,
  differential timing, or a safe control comparison. Reference compatibility
  does not prove that a particular byte is from the SME-105 ECU. The operator
  also observed the physical MAX487 RX LED extinguish promptly after
  ignition OFF; that strengthens an ignition-linked signal interpretation
  but is not a calibrated differential measurement.
- The earlier `Echo ID` receive observation includes 11 local-echo bytes
  and an additional `01` matching the reference ACK, but the 12th byte's
  provenance was not isolated on the physical line. The firmware's strict
  gate is an experimental condition, **not ECU-authentication**.
- The source `tables.h` in the same reference repository distinguishes
  a PID-map upload (code `E`), read PID values (`G`), and unrelated
  state-changing requests including clear codes (`C`). Those identifiers
  belong to the *reference scanner's timed command-slot protocol*; they are
  **not a verified list of safe stand-alone UART frames for SME-105**.
  Its comment labels its default PID map as an FDS/WDS reference. We must
  not infer a working RPM or temperature scale from those identifiers.
- Do **not** blindly replay the hello, send guessed diagnostic commands,
  remove the SMD `121` resistor, or infer an ECU fault.
- Further progress requires evaluating genuine command/slot behavior and a
  qualified protected interface before attempting diagnostic transactions
  or assigning physical meanings to sensor values.

## Engineering status and next safe work

**Observed:** reference-compatible EEC-IV CART sync/ID stream at 9600/8N1
after a bounded Echo ID and Go CART sequence.

**Not observed:** independently authenticated ECU reply, valid PID-data
payloads, RPM, battery voltage, water temperature, DTCs, UART error count,
qualified bus electrical loads, or validated diagnostics commands.

**Next packet (offline/bench):** model the reference scanner's frame sync
and timed command-slot state machine; develop strict synthetic UART tests
for missing frames, framing errors, timing glitches, bus half-duplex
turnaround and power-loss conditions; independently review the protected
electrical interface. No need to revisit the car or send any additional
requests until the request framing and safety case are complete.

## Offline reproduction

```bash
./.venv/bin/python scripts/analyze_cart_once.py \
  captures/CART_ONCE/20261102T150417765534Z.txt

# Structured machine-readable output
./.venv/bin/python scripts/analyze_cart_once.py \
  captures/CART_ONCE/20261102T150417765534Z.txt --json
```

Script tests and existing suite: **48/48 PASS** on 2026-11-02.

Reference source code:
`https://github.com/doncreat0r/eeciv/blob/master/Diag324.c`,
`https://github.com/doncreat0r/eeciv/blob/master/tables.h`.
