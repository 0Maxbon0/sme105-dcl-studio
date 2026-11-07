# SME-105 coordinated release report — 2026-11-07

## Release metadata

| Component | Release |
|---|---|
| Firmware | v25, PlatformIO environment `esp32dev_ble` |
| Android app | v1.8.12, versionCode 14 |
| Target | 1998 Ford Escort 1.6 Zetec-E, EEC-IV SME-105 (`97AB-12A650-KA`) |

## Release binaries and SHA-256

The local artifacts were hashed and match the recorded release sums:

| Artifact | SHA-256 |
|---|---|
| `android/app/build/outputs/apk/debug/app-debug.apk` | `70a92c1a1936a1f920a33c0f48bcef4cfbc5e43c436be23727b5740f9de846c6` |
| `firmware/sme105_usb_bridge/.pio/build/esp32dev_ble/firmware.bin` | `54e8a74d19cdd5eba80319c1ece5da2c86ae24c59ce8f96b5a65a376718eea57` |

Verify before install or flash:

```bash
sha256sum android/app/build/outputs/apk/debug/app-debug.apk \
  firmware/sme105_usb_bridge/.pio/build/esp32dev_ble/firmware.bin
```

## Software verification record

| Check | Recorded result |
|---|---:|
| `npm test` | 133 passed, 3 skipped |
| Python unittest discovery (`python -m unittest discover -s tests`) | 280 passed, 10 skipped |

These are software verification results. They do not establish vehicle-side
electrical compatibility, ECU command support, or successful deployment.

## Command matrix and experiment evidence

The complete A–R matrix, parity analysis, alternate variants, evidence levels,
four-word envelope, and experiment sequence are in the [2026-11-07 experiment
plan](../../docs/sme105-dcl-experiment-plan-2026-11-07.md). The central
distinction is that historical profile traffic (`26A4`, `260E`, `253E`,
`4196` / `21F6`) is not the same evidence as target ECU acceptance; prepared
single-shot reads are `0381`, published PID-map literal `005E`, and DMR-map
candidate `242E`. DMR values, combined reads, MEM, CLR, and OFF remain
experimental and require separate sessions and their documented controls.

## Durable recording format

The app persists per-operation metadata in IndexedDB `captures` and ordered
raw/CSV Blob chunks in `chunks`. `exportExperimentArchive(id)` produces a ZIP
with `metadata.json`, `raw.txt`, `events.jsonl`, `ro.bin`,
`ro-timestamps.csv`, `tx-pad.jsonl`, and `SHA256SUMS`. The exporter verifies
each member checksum before returning success and also returns the ZIP's own
SHA-256. Interrupted operations remain marked incomplete; the archive keeps
the original raw transcript alongside derived views. See the experiment plan
for member definitions and storage behavior.

## Hardware readiness and deployment pre-checks

Firmware v25 sets `kActiveMasterQualified = true`, so active profiles are
compiled in but must pass the runtime gate. Before any active read:

1. Confirm the firmware binary hash and build target; preserve the current
   device configuration and app recordings before installation.
2. Use the documented protected 3.3 V interface with controllable DE and
   `/RE`, a boot-safe DE pull-down, stable DI bias, and independently reviewed
   wiring. Keep OBD pin 16 isolated from project power.
3. On each firmware boot, with the vehicle bus disconnected, issue
   `TX2_BENCH` once. Require two reference frames, all four expected GPIO17 pad
   words (`01B0 FF5F 26A4 00A0`), independent RMT decode of `01B0`, DE LOW,
   exact `PASS_LOCAL_PAD`, and a fresh `STATUS` showing
   `tx2_bench_used=1 tx2_bench_pass=1`.
4. Treat missing, malformed, failed, or contradictory bench evidence as a
   failed gate. The attempt is consumed and active commands stay blocked until
   a fresh boot and successful bench. Do not retry automatically.
5. Before connecting to the vehicle, separately qualify the differential
   transceiver path and pin assignment with suitable electrical measurement.
   `TX2_BENCH` proves only the local pad path; it does not qualify A/B,
   transceiver turnaround, ECU response, or command semantics.
6. Check `HELLO`, `PINS`, and a fresh `STATUS`, confirm DE LOW and no latched
   fault, then perform one explicitly armed profile at a time. Do not chain
   candidate opcodes or use an automatic fallback.
7. Install the Android update in place (`adb install -r`) without wiping app
   data. Export existing PWA recordings separately; Chrome PWA storage does
   not migrate automatically into Android WebView storage.

No hardware deployment or vehicle command is claimed by this report. The
release binary hashes and supplied software-test results are recorded, while
vehicle-side electrical and command qualification remain separate gates.

## Related documentation

- [Experiment plan and command matrix](../../docs/sme105-dcl-experiment-plan-2026-11-07.md)
- [Firmware bridge operation and qualification gate](../../firmware/sme105_usb_bridge/README.md)
- [Android app README](../../app/README.md)
