# Code walkthrough — how Escort SME-105 Diagnostic Lab works

This is a **source-oriented map**, not an assertion that all candidate
ECU commands or sensor units were vehicle-verified.

## Repository map

| Directory | Purpose / entry point |
| --- | --- |
| `app/index.html`, `app/styles.css` | Main field-app UI/layout |
| `app/js/app.js` | Application composition: menus, event handlers, transport selection, capture/export orchestration |
| `app/js/controller.js` | Explicit experiment and session state machine; operator confirmations, bounded operations, STOP/recovery |
| `app/js/protocol.js` | Firmware messages, fixed command catalogue, identity checks, parsing and evidence labels |
| `app/js/wifi.js` | Browser-side wrapper of native Android Wi-Fi transport; profile, generation/epoch and resume reconciliation |
| `app/js/ble.js` | Separate BLE transport wrapper, GATT notification reassembly |
| `app/js/recording.js` | IndexedDB durable writes and hash-verified experiment exports |
| `app/js/session.js` | Session events/outcomes and end-of-run verdicts |
| `app/js/pids.js`, `app/js/live-dashboard.js` | Candidate PID definitions, transformations and live presentation, with verification caveats |
| `android/app/src/main/java/com/maximizotech/sme105dclstudio/WifiBridgePlugin.java` | Android `NetworkSpecifier`, credential handling, TCP authorization, heartbeats and reconnect ownership |
| `android/app/src/main/java/com/maximizotech/sme105dclstudio/BridgeConnectionService.java` | Native app/foreground link coordination |
| `android/app/src/main/java/com/maximizotech/sme105dclstudio/ExportStoragePlugin.java` | Android export storage interoperability |
| `firmware/sme105_usb_bridge/sme105_usb_bridge.ino` | Production-candidate firmware source, named operations, GPIO safety, UART/ISR, TCP service |
| `firmware/sme105_usb_bridge/telemetry_ring.h` | Static raw-event history and sequence replay |
| `firmware/sme105_usb_bridge/ble_transport.cpp` | Alternative NimBLE bridge build |
| `src/ford_dcl/` | Offline Python tools, capture inspection and protocol research |
| `app/tests/`, `tests/`, `android/app/src/test/` | JS, Python and native JVM regressions |
| `scripts/` | Bench/RF/provisioning utilities; some require physical authorization |

`firmware/` contains numerous **historical experimental sketches**;
the maintained Wi-Fi/optional-BLE build is
`firmware/sme105_usb_bridge/platformio.ini`. Do not assume an older
sketch is the installed firmware.

## Example: connect without transmitting to the ECU

1. `app.js` creates or selects the `WifiTransport` instance.
2. `wifi.js` calls the Capacitor Wi-Fi plugin; old listeners are
   detached and a new generation and native epoch are recorded.
3. `WifiBridgePlugin.java` obtains the approved local-only Android
   network, binds the socket to the ESP32 and derives `AUTH` from
   the owner-entered AP secret. Secrets are kept out of app source.
4. Firmware checks `AUTH`, then answers read-only identity/status
   inquiries: `HELLO`, `PINS`, `STATUS`.
5. `controller.js` checks these responses before exposing a bridge
   as ready. This sequence alone cannot request a vehicle operation.

## Example: run and archive a bounded experiment

1. The UI asks the controller to start a **catalogued** operation.
2. The controller checks classification, required ECU state,
   operator confirmation, firmware compatibility and current session.
3. `recording.js` opens a durable capture record **before** dispatch.
4. Fixed firmware operation logic checks IDLE state, explicit arming,
   GPIO/DE/pad evidence and session timeout; the transmitter is
   not automatically armed at connection.
5. Firmware emits raw RX/diagnostic events, sequence metadata,
   fault conditions and end markers.
6. `protocol.js` parses exact line formats;
   `session.js` and `controller.js` update operation state;
   `pids.js` may show **candidate** derived readings without
   upgrading their evidence level.
7. The recording store appends ordered raw text/events/blob chunks.
   `exportExperimentArchive()` generates a ZIP containing metadata,
   `raw.txt`, `events.jsonl`, reconstructed RO bytes,
   timestamps and `SHA256SUMS`.

On shutdown or connection loss the app preserves partial data,
invalidates uncertain writes and can mark a recording **INCOMPLETE**.
It must not invent a successful experiment or trust samples from a
stale native socket generation.

## Example: reconnect and resume live data

- The native layer monitors an application heartbeat (2 s interval;
  6 s staleness threshold) and retains process-owned connection
  state across some WebView recreations.
- Each newly attached JS listener is associated with the expected
  generation/native socket epoch; late callbacks from old ownership
  are rejected.
- ESP32 may preserve raw telemetry for a maximum 30 s grace.
  `RESUME` checks boot/session identity and sample sequence;
  replay and duplicate suppression are bounded by the ring capacity.
- Loss beyond retention is exposed as a gap or incomplete run.
  **Neither 30 seconds nor a successful TCP reconnect guarantees
  30 seconds of lossless ECU data.**

## Safety boundaries in the code

The firmware uses GPIO16 for RO, GPIO17 for DI and pad witnessing,
GPIO18 for controlled DE with hardware pull-down. Active profiles
require a matching safe state and explicit authorization. `STOP`,
timeouts, fault detection and backpressure shut down the drive path.
An authenticated phone is not sufficient to bypass the safety state
machine. [Hardware safety](HARDWARE_GUIDE.md) still applies.

## Working on a new parser or interpretation

Prefer an **offline, read-only** change:

1. Start with redacted/synthetic raw bytes and an explicit evidence
   category (Observed/Reference/Inferred/Unknown).
2. Add a deterministic parser fixture under `app/tests/` or `tests/`.
3. Keep source raw files immutable; calculate derived values without
   modifying the original capture and timestamp order.
4. Label any ECU-specific address, scaling or timing as **Inferred**
   until independently measured. Never silently enable new ECU TX.
5. Run host tests, review the diff and cite the evidence in the PR.

For development commands see [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md).
For the actual DCL research state see
[protocol notes](protocol-notes.md) and [references](REFERENCES.md).
