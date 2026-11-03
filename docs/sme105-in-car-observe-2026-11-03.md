# SME105 in-car Wi-Fi DCL observation — 2026-11-03

## Scope and consent

The operator reported that the hardware was connected to the vehicle and
authorized testing. One explicitly authorized `OBSERVE` (2400-baud Echo ID,
candidate ACK check, Go CART, then receive-only 9600-baud observation) was
issued through authenticated TCP at `192.168.1.10:8765`. There were **no**
`ARM_A4`, `READ_A4`, `ARM_0E` or `READ_0E` requests, no automatic repeat,
and no in-car firmware flash. Ignition/electrical measurements were not
independently verified by software.

## Observed live results

1. Initial Wi-Fi `STATUS` returned `stage=0`, `DE=LOW`, `fault=0`,
   `tx2_bench_pass=1`, `read_used=0`, `observe_used=0`.
2. The single `OBSERVE` sent eleven Echo-ID bytes at 2400 baud. The RX
   transcript contained eleven echoed bytes and a final `01`, reported by
   firmware as `candidate_11_echo_plus_01 source=UNVERIFIED`.
3. It then sent Go CART, switched to 9600 8N1 receive-only capture and
   recorded 95 bytes. The parser reported `baseline=16 synced=1
   authority=unverified`. Frames followed a repeating `00 00 00 XX`
   shape with roughly 10 ms spacing; origin and ECU authority remain
   **unverified**.
4. The authenticated TCP stream disconnected before `END`. The host
   explicitly marked the 95-byte transcript **incomplete/untrusted**.
   Follow-up `STATUS` showed `stage=0`, `DE=LOW`, `observe_used=1`,
   `read_used=0`, `fault=17` (`TRANSPORT_BACKPRESSURE`), `out_overflow=0`.
5. After read-only status and safe `RESET_IDLE` (which does **not** re-arm
   `OBSERVE`), a short passive `LISTEN_9600` with manually requested `STOP`
   captured 30 more bytes with a matching `END reason=15 ro_bytes=30
   ro_lost=0 uart_errors=0 ... DE=LOW`. No new bus TX occurred during
   the passive test. Its samples showed the same cadence and shape.
6. Final read-only state after `RESET_IDLE`: `stage=0`, `DE=LOW`,
   `fault=0`, `observe_used=1`, `read_used=0`, `tx2_bench_pass=1`.
   Installed signed OTA image remains **v5**, `boot_health=VALID`, rollback
   enabled. No active diagnostic/DTC read was attempted.

### Preserved evidence

All files are under `captures/SME105_97AB/` (timestamped in UTC):

| Capture | Result | Verbatim transcript SHA-256 | Binary RX SHA-256 |
| --- | --- | --- | --- |
| `20261103T202539537314Z-usb-bridge` | Active OBSERVE: 95 RX bytes, TCP interrupted before END | `2bf0b3c7424acf3aac7e76f775e777d87997580fb15212fe96080ab75535ae31` | `bff16967d05e4385b70f12ae1dbc435f9d95918b9840c9bb68b450ea9eb6f6c1` |
| `20261103T202934803038Z-usb-bridge` | Passive listen, manual STOP and matched END: 30 RX bytes | `30ac17e4e0dbab10a598921da4c68f367a819d748dcc36a307621199dcf6989b` | `1666f4af534f8e84f83a90d54602b8c2d34f2e75edbf8ba78654b8be8955853f` |

## Software reliability finding and disposition

The original `BridgeOutput::used()` held the 16 KiB queue behind the
slowest USB/TCP cursor **even during authenticated Wi-Fi sessions**. A
closed/unplugged USB monitor could therefore trigger fault 17 and drop an
otherwise live TCP capture. This was also a known risk for continuous
in-car sampling.

The local source now uses authenticated TCP as the primary evidence receiver,
keeping the slow/absent USB mirror optional with explicit `usb_skipped`
accounting; without authenticated TCP, USB remains mandatory. A slow/stalled
TCP receiver still triggers bounded fail-closed backpressure. This is tested
against the real extracted C++ `BridgeOutput` code (over eight queue-lengths
with USB blocked); 227 full Python tests and the PlatformIO release build
passed. **The fix is local source only; it was not installed on the
vehicle-connected ESP32.** Deploying signed firmware requires a new version
greater than 5 and a separate supervised update decision.

## Interpretation and remaining boundaries

The evidence supports a working authenticated network control plane,
2400-baud candidate handshake, and recurring UART1 signal consistent with
the expected CART frame timing. It does **not** authenticate the signal as
coming from the ECU rather than local echo, wiring/coupling or another source,
nor establish any DTC value. No differential MAX487 A/B waveform or power
integrity was independently measured. Do not claim an ECU read, and do not
send experimental A4/0E candidate commands based on this capture alone.
