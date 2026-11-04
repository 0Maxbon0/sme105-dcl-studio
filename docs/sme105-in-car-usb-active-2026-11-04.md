# SME105 in-car USB-only controlled diagnostic attempt — 2026-11-04

## Owner directive and actual execution

The owner explicitly requested an immediate in-car USB test with ignition on,
reusing the existing knowledge, and an attempt to detect faults. This is a
vehicle-connected test, **not** a bench or Wi-Fi test. The ESP32 remained on
firmware v9; no flash, router work, clearing codes or actuators were used.

1. The preceding **passive-only** `LISTEN_9600` captured zero bytes. That
   result does not test ECU handshake, because this command transmits nothing.
2. A **local-only** `TX2_BENCH` passed all four source words:
   `01B0`, `FF5F`, `26A4`, `00A0`. Independent RMT decoding of
   `01B0` passed. External driver enable stayed `DE=LOW`;
   `ecu_tx=0`. Fresh STATUS confirmed `tx2_bench_pass=1`,
   `stage=0`, `fault=0`. This **does not** prove MAX487 A/B signalling
   or that the ECU sees a correct request.
3. **One** authorized, previously exercised active `OBSERVE` sequence:
   Echo ID (11 bytes at 2400), candidate 11-byte echo + `01` ACK
   (origin unverified), Go CART (11 bytes at 2400), then UART1 RO reception
   at 9600. No experimental `READ_A4` or `READ_0E` B command was sent.
4. Complete USB terminal record:
   `END reason=16 ro_bytes=3984 ro_lost=0 uart_errors=0 pad_verified=0
   words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW`.
   The timeout reason is the firmware's normal 10-second bounded capture,
   not a UART error or an ECU diagnostic code. The host acknowledged STOP
   with `EVENT stop=idle DE=LOW` and exited successfully.

## Evidence integrity

Evidence lives under `captures/SME105_97AB/`; timestamps are UTC:

| Capture | Evidence | SHA-256 |
| --- | --- | --- |
| `20261104T135342868112Z-usb-bridge.txt` | DE-low local pad/RMT preflight | `127a295971d99861e643e58003e0ffe49917409cfbc78a9f104450497fc0191f` |
| `20261104T135427026967Z-usb-bridge.txt` | Complete active USB transcript and END | `06e9946d3eb90c1ca2303fa13f27540e179225922cea7c7880a58b72a32b2cf5` |
| `20261104T135427026967Z-usb-bridge.bin` | Exactly 3,984 UART1 RX bytes | `ed478fcf36923927d16ce2f68fcfe2b62c4d071445a481cfc8d26ce5bf634c12` |

Offline independent raw-byte audit:

- 996 exact quartets = 62 complete cycles of IDs 0–15 plus IDs 0–3.
- Every quartet is `00 00 00 <parity-coded ID>` from
  `scripts/analyze_cart_once.py:REFERENCE_CYCLE`.
- The 3,984-byte binary exactly equals the raw bytes reconstructed from
  `captures/CART_ONCE/20261102T150417765534Z.txt`, byte for byte.
- 3,984 timestamped UART samples; successive quartet start times have
  approximately 10 ms intervals (9.993–10.005 ms).
- **No additional word or payload** beyond CART sync/ID was present; no
  diagnostic trouble code (DTC), sensor value or ECU provenance was verified.

## Decision and next safe gate

The in-car USB path, 2400-baud bounded handshake and 9600-baud RX path
produced a reproducible continuous **ID-only** stream. That is useful progress
but **not a valid DTC read**. The candidate B diagnostic request still has
conflicting source definitions (`26 A4` vs `26 0E` and timing/slot counts),
and physical MAX487 A/B differential waveform, driver-enable safety, exact
ECU pinout/source and response interpretation remain unverified. Sending
either B variant merely to make a TX LED blink would be an uncontrolled
experiment; neither was sent. Do not clear ECU codes or issue KOEO/KOER
actuator tests. Next engineering gate is source/protocol reconciliation
and independent A/B scope/logic-analyzer proof with current limiting,
before one separately bounded B read. Historic `97AB` ECU identity and
UART-only payload have not been authenticated as ECU source.
