# System architecture

This page describes the **current local source layout**, rather than
guaranteeing that every feature has been physically validated.
See [code walkthrough](CODE_WALKTHROUGH.md) for implementation entry points.

## Layers and boundaries

    +--------------------------------------------------------------+
    | Android application: app/index.html, app/js/, app/styles.css |
    |  UI / operation controller / parser / IndexedDB recordings   |
    +-------------------------------+------------------------------+
                                    |
                        Capacitor native plugin calls
                                    |
    +-------------------------------v------------------------------+
    | Android: WifiBridgePlugin + BridgeConnectionService          |
    | local-only NetworkSpecifier / TCP socket / AUTH / heartbeat  |
    | process-owned socket lifecycle, generation & epoch checks    |
    +-------------------------------+------------------------------+
                                    |
                  WPA2 SoftAP + authenticated TCP lines
                        10.77.13.1 : 8765, no router
                                    |
    +-------------------------------v------------------------------+
    | ESP32 firmware: sme105_usb_bridge.ino                        |
    | fixed commands / receive ISR / safety state machine          |
    | 8,000-event telemetry ring / finite RESUME replay            |
    +-------------------------------+------------------------------+
                                    |
                GPIO16 (RO), GPIO17 (DI), GPIO18 (DE)
                                    |
             MAX487 + voltage translation + bus protection
                                    |
                    Candidate Ford EEC-IV DCL interface
              (not qualified by network/bench tests alone)

The native Android app is built by Capacitor with `webDir: "app"`.
The `app/` directory is the canonical UI, **not** an old website to delete.
The retired Python localhost GUI does not replace it.

## Connect and recover

1. The owner supplies an actual ESP32 SoftAP SSID and a WPA2 password.
   Android stores the secret in Keystore-backed private storage.
2. The plugin asks Android for the **local-only** Wi-Fi network, then opens
   a TCP connection specifically bound to that network.
3. A PBKDF2-derived `AUTH` value establishes an application-level session.
   This uses the **same password** as the AP, not independent second-factor
   authentication. The app requests `HELLO`, `PINS` and `STATUS`.
4. A heartbeat (normally 2 s) and stale-link detection (6 s) detect
   application-level loss. A lost owner socket invalidates queued writes;
   it does not replay an uncertain ECU command.
5. Firmware can retain session telemetry for up to **30 seconds** to support
   explicit, validated `RESUME`. Android compares generation, boot/session
   identities and native epochs before trusting reconnected data.
6. If continuity cannot be demonstrated, the app marks loss or an
   incomplete recording rather than silently stitching fabricated data.

`esp32dev_ble` compiles an **alternative** NimBLE transport; the Wi-Fi
and BLE profiles are not concurrent in one firmware image.

## A diagnostic experiment

    User explicitly chooses a fixed experiment
              |
    controller validates operator/ECU-state prerequisites
              |
    recording created before transmit (metadata + timestamps)
              |
    firmware identity/status and physical safety gate checks
              |
    explicit bench proof + matching ARM/READ where required
              |
    bounded ECU request -> RX telemetry/events -> parser
              |
    raw data stored -> evidence-labeled interpretation -> export

For named active operations, driver enable `DE` must be LOW at idle,
the pad witness and boot-local `TX2_BENCH` must pass, and the matching
operator-armed request is time-bounded. These **software controls do not
verify the vehicle-side wire polarity, ground path or transient protection**.
No general arbitrary ECU-byte transmit API is provided.

## Data ownership

- The **firmware** owns electrical timing, bounded capture, hardware
  shutdown on faults, monotonic telemetry sequence numbers and session
  replay limits.
- The **native Android layer** owns Wi-Fi association, TCP socket and
  credential storage, queue invalidation and reconnect epoch arbitration.
- The **JavaScript controller** owns user authorization, experiment flow,
  parsing and UI presentation; it must never assume that a reconnect
  reauthorizes active requests.
- **IndexedDB** stores durable capture metadata plus ordered raw/CSV
  chunks. Export creates an evidence archive containing raw records,
  event chronology and checksum manifests.
- **Python tooling** supplies independent offline inspection/CLI workflows;
  it is not an alternate Android UI.

## Trust and verification

| Layer | Validates | Does not establish |
| --- | --- | --- |
| Wi-Fi/TCP AUTH | Authorized transport session | Permission to drive ECU |
| `HELLO`/`PINS`/`STATUS` | Expected firmware identity / stated gates | Correct physical wiring |
| Bench `TX2_BENCH` | GPIO and low-DE pad-test behavior | Automotive electrical compatibility |
| RX parser and tests | Repeatable logic on known bytes | Real SME-105 engineering units |
| IndexedDB/export | Stored evidence and reproducible analysis | Completeness beyond finite buffers |
| KiCad ERC/DRC | CAD rule consistency | Assembled/fabricated/vehicle safety |

Research confidence is tracked as **Observed**, **Reference**, **Inferred**,
or **Unknown**. Vehicle-command capability is not inferred from the
existence of a command catalogue entry.

## Related documentation

[Wi-Fi architecture](wifi_bridge_architecture_and_setup.md) ·
[Transport/recovery report](wifi_ble_stability_and_rf_report.md) ·
[Recordings](../app/README.md) ·
[Electrical safety](wiring-safety.md) ·
[Protocol research](protocol-notes.md)
