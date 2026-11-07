# SME105 EEC-IV Diagnostics

Offline, installable web app for a 1998 European Ford Escort 1.6 Zetec (Ford EEC-IV, DCL/CART). The phone talks Bluetooth Low Energy to the `SME105-DCL` ESP32 bridge. The bridge is the only thing that transmits on the car.

## Coordinated release — 2026-11-07

This app release is **v1.8.12** (Android versionCode **14**), coordinated with
ESP32 bridge firmware **v25** (`esp32dev_ble`). See the
[release report](../artifacts/releases/2026-11-07-v25-release-report.md) for
binary hashes, recorded verification results, and deployment pre-checks.

The full command catalogue is in the
[A–R experiment plan](../docs/sme105-dcl-experiment-plan-2026-11-07.md).
Historical target-session evidence covers `26A4`, `260E`, `253E`, and the
`4196` / `21F6` live sequence. Prepared new raw-read candidates are `0381`,
published literal `005E`, and `242E`. DMR values (`22C6`), combined values
(`271E`), MEM, CLR, and OFF remain separate experimental variants. In
particular, `005E` stays distinct from parity-derived `004E`; the latter is
neither an automatic fallback nor the same thing as a received frame-ID E.

## Android app

The native Android app works offline after installation and uses authenticated BLE through the ESP32 bridge. It needs no phone Wi-Fi or network permission. Android WebView storage is private to this installed app; Chrome PWA recordings do not migrate automatically. Export the old PWA data before removing it.

Build the debuggable APK from the repository root with Node.js, JDK 21, and Android SDK platform 36:

```bash
npm ci
npm test
npm run android:debug
```

The artifact is `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. The app connects only after you tap **Connect**; live capture and diagnostic reads require separate explicit actions. No background vehicle reads are started automatically. The browser PWA remains available from `app/index.html`.

## Continuous all-data monitoring

**All live data** uses `ARM_ALL` / `READ_ALL` on bridge firmware v23 or newer.
It loads one mode-41 map with three words in each of frames 1–15, then repeats
mode 21 without changing groups. The 45 slots contain all 39 requested channels
and six repeated key readings. Frame length remains 6: the designed update
interval is 360 ms per block, not simultaneous measurements. Actual timing and
supported equipment still require verification on this SME-105 ECU. The three
individual sets remain available, with an expandable explanation under each
selection. The earlier rotating survey survives internally for compatibility;
it is not used by the All live data button.

The map follows LHBH1 chapter 13, pp.13-13/14: configurable slots, mode 41 then
mode 21. [Reference code](https://github.com/doncreat0r/eeciv/blob/master/tables.h)
uses multiple PID slots per frame; [another implementation](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp)
also loads a multi-slot map. These references do not establish vehicle-specific
sensor support, electrical safety or sustained operation of this bridge.

All live modes have a **three-hour** firmware limit, with an extra minute in
the app to receive a final END. The decoder unwraps the wire's 32-bit
microsecond clock (about 71.6 minutes per wrap). The ESP32 keeps fixed-size RAM
queues and streams data; it does not accumulate a trip or write readings to its
flash. Its existing pad, DE watchdog, transport and overflow checks remain;
five seconds without ECU data ends live capture as incomplete, without retry.
Turning off the key stops ECU communication; it does not provide a clean final
capture verdict, and does not replace the link/overflow checks during a trip.

The app stores per-operation metadata in IndexedDB `captures` and ordered raw
and CSV Blob chunks in `chunks`, flushing about once per second. The UI retains
at most 512 readings per channel and a recent log window in RAM; full-trip
counts and min/max remain cumulative. CSV/log export reads the full saved
recording, not just recent history. Saved recordings can be exported after
reopening the app. The app never automatically deletes them.
At least 1 GB of estimated free browser quota is required before live capture;
this is headroom, not a promise of three hours. Browser quota, actual free space,
link throughput, battery, Android background suspension and browser eviction
still apply. A failed write or a queued backlog over 4 MB stops capture and
retains pending chunks for export in that tab. A process/power loss may lose the
latest uncommitted chunk. Export recordings before clearing browser data.
See [browser storage documentation](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### Durable experiment recordings

For command experiments, the capture record is created before command dispatch
and includes the experiment/session ID, variant, persistence status, unit
system, start/end times, sample count, duration, verdict, and outcome. Raw
bridge lines remain in order. Startup recovery marks an unended operation
`INCOMPLETE` without fabricating an `END`; storage failure preserves queued
chunks for export in the still-open tab and stops capture.

The `exportExperimentArchive(id)` helper builds and verifies a ZIP containing:

| Member | Contents |
|---|---|
| `metadata.json` | Saved experiment metadata and verdict. |
| `raw.txt` | Original stored bridge lines. |
| `events.jsonl` | JSON Lines for selected `EVENT`, `FAULT`, `DENIED`, `END`, `STATUS`, `PINS`, `BOOT`, and `HELLO` lines. |
| `ro.bin` | Raw RO bytes reconstructed from `RX` / `RXB` records. |
| `ro-timestamps.csv` | `index,t_us,byte_hex` timestamps for each RO byte. |
| `tx-pad.jsonl` | Local transmit-pad witness rows. |
| `SHA256SUMS` | SHA-256 for all preceding members; each member is re-read and verified before success. |

The helper also returns the ZIP's SHA-256. Keep the archive unchanged and save
that hash with the experiment. Android WebView IndexedDB is private to the
installed app; existing Chrome PWA recordings do not migrate automatically.
Export PWA evidence before removing site data or the old app installation.

Three hours of simulated ECU frames, including two clock wraps and more than
1.3 million samples, pass decoder/bounded-memory checks. IndexedDB transaction
tests use the pinned, lockfile-managed fake-indexeddb development dependency;
run all checks with `npm test`.

These are software checks, not a real three-hour car or radio test. Local
browser preview was blocked because permission was declined; UI interaction
and sustained phone storage remain unverified. Keep the app open and connected;
this prototype has not been qualified for a road trip.

Target browser: Chrome on Android (checked against a Samsung Galaxy A52s). Web Bluetooth is not available in iOS Safari.

## Install

The app is static files. It does not use a build step, npm, or a CDN. After the first load the service worker keeps it available with no network.

### Hosted (HTTPS)

Put the contents of this `app/` directory on any static HTTPS host (GitHub Pages works). Open the site in Chrome on the phone. Use the browser menu and choose **Install app** (or **Add to Home screen**). Launch the installed icon after that; it opens standalone.

If the repository itself is the site root, the app lives at `/app/` and the relative manifest still installs from that path.

### Phone testing over the LAN

Web Bluetooth only runs in a secure context (HTTPS or localhost). A phone cannot treat your computer’s `http://192.168.x.x` as localhost, so Chrome must be told that origin is safe for the test:

1. On the computer, from this directory:

   ```bash
   python3 -m http.server 8000
   ```

2. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add the origin you will open, for example `http://192.168.1.20:8000`. Relaunch Chrome.
3. Open that exact origin, then **Install app**.

Remove the flag when you are done. Prefer real HTTPS for anything you keep using.

## Pairing

The bridge characteristics require an encrypted link. If Android asks for a pairing code, enter the bridge owner-provided code in the operating-system dialog. The app cannot see or store that code. If another controller already owns the bridge, the link answers `DENIED remote_busy`.

Device name filter: `SME105` (the bridge advertises `SME105-DCL`). Service: Nordic UART `6e400001-b5a3-f393-e0a9-e50e24dcca9e`.

## Using it

1. **Connect.** The app checks `HELLO`, `PINS`, and `STATUS` against this bridge. DE must be LOW, `auto_tx=0`, `gate4=1`, stage 0 (idle) before any vehicle command. Firmware v25 requires a successful `TX2_BENCH` on every boot before an active read; a matching `ARM_*` remains required for each operation.
2. **Codes.** “Read stored codes” sends `ARM_0E` then `READ_0E`. “Run KOEO self-test” is about 60 seconds with the ignition ON, engine OFF, gear in P/N, feet off the pedals. Codes are not cleared.
3. **Live.** Set 1 is engine and temperatures. Set 2 is flags, idle, and bitmaps. A capture runs about 90 seconds. “Record CSV” downloads the time series.
4. **Tools.** Go offline silences the ECU link until the next ignition cycle. `TX2_BENCH` is local to the bridge (no ECU request), keeps DE LOW, and runs at most once per boot; the app runs it before the first active operation when `STATUS` has no pass latch. It must pass before active reads and is not retried automatically. It proves the GPIO pad path only, not the differential vehicle bus. Stop is in the header during an operation. Reboot drops the link and resets the pass latch.
5. **Log.** Raw lines from this connection, plus valid / incomplete / failed and the END reason. Reason 16 (`CAPTURE_TIMEOUT`) is the normal end of a timed capture.

The app sends `ARM` only after you confirm, then `READ` as soon as the arm event arrives (the arm window is 15 seconds). It never repeats a vehicle command by itself. If the Bluetooth link drops, the running operation is marked failed; the bridge stops the vehicle session on its own.

A result is **valid** only when the capture has an `END`, `ro_lost=0`, `uart_errors=0`, the RX line count equals `ro_bytes`, every `TX_PAD` word matches, and no `FAULT`, `DENIED`, `EVENT rx_lost`, or `EVENT uart_errors` line occurred. Anything else is shown greyed as untrusted.

## Demo mode

About → “Use demo captures” replays a recorded transcript in a desktop browser:

- Stored codes (`READ_0E`)
- KOEO self-test
- Live data, key on, engine off (that file also contains a go-offline)

No Bluetooth and no car. Live set 2 is not in those recordings.

## Tests

From the repository root (Node 18+):

```bash
node --test app/tests/
```

Decoders are plain modules. They do not touch `window` or Bluetooth at import time. The checks replay `captures/SME105_97AB/` and compare stored codes, the KOEO result, and both live captures with `scripts/decode_live_pids.py`.

## Fault text

Descriptions are the European EEC-IV list from `EECIVFaults.csv` by babroval, MIT license:

https://github.com/babroval/ford-eec-iv-diagnostic

The five notes on codes 113, 122, 157, 214, and 452 were added for this car. Unknown codes read “Unknown code — not in database”.

## Safety

Park the car. Stored codes and KOEO: ignition ON, engine OFF. Live data: the engine may run, but the vehicle stays parked. Going offline means the ECU will not answer until the ignition is cycled. `CLR` clears DTCs and changes ECU diagnostic state; treat it as a separately approved state-changing operation. This is not a workshop manual.
