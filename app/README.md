# SME105 EEC-IV Diagnostics

Offline, installable web app for a 1998 European Ford Escort 1.6 Zetec (Ford EEC-IV, DCL/CART). The phone talks Bluetooth Low Energy to the `SME105-DCL` ESP32 bridge. The bridge is the only thing that transmits on the car.

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

The bridge characteristics require an encrypted link. The first time the app reads or writes them, Android shows the system PIN dialog. Enter the PIN there. This unit’s default PIN is **225367**. The app cannot see or store that PIN. If another controller already owns the bridge, the link answers `DENIED remote_busy`.

Device name filter: `SME105` (the bridge advertises `SME105-DCL`). Service: Nordic UART `6e400001-b5a3-f393-e0a9-e50e24dcca9e`.

## Using it

1. **Connect.** The app checks `HELLO`, `PINS`, and `STATUS` against this bridge. DE must be LOW, `auto_tx=0`, `gate4=1`, stage 0 (idle) before any vehicle command.
2. **Codes.** “Read stored codes” sends `ARM_0E` then `READ_0E`. “Run KOEO self-test” is about 60 seconds with the ignition ON, engine OFF, gear in P/N, feet off the pedals. Codes are not cleared.
3. **Live.** Set 1 is engine and temperatures. Set 2 is flags, idle, and bitmaps. A capture runs about 90 seconds. “Record CSV” downloads the time series.
4. **Tools.** Go offline silences the ECU link until the next ignition cycle. Self-test is local to the bridge (no car transmission) and runs automatically once per boot before a vehicle read if it has not passed. Stop is in the header during an operation. Reboot drops the link.
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

Park the car. Stored codes and KOEO: ignition ON, engine OFF. Live data: the engine may run, but the vehicle stays parked. Going offline means the ECU will not answer until the ignition is cycled. This is not a workshop manual, and this version cannot clear codes.
