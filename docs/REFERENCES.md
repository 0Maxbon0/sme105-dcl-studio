# SME105 DCL Studio — reference and evidence index

**Last reviewed:** 2026-11-09
**Target:** 1998 Ford Escort 1.6 Zetec-E · Ford EEC-IV SME105 · `97AB-12A650-KA`.

This index records sources consulted in project documentation and links to the internal engineering analysis. **A reference made for another EEC-IV ECU is not proof of compatibility with this SME105 calibration.** Track each claim as **Observed**, **Reference**, **Inferred**, or **Unknown**; see [protocol notes](protocol-notes.md). A successful bench Wi-Fi session does not prove the car accepted any DCL request.

## 1. Primary DCL and reverse-engineering projects

| Source | What we use it for | SME105 acceptance |
| --- | --- | --- |
| [babroval/ford-eec-iv-diagnostic](https://github.com/babroval/ford-eec-iv-diagnostic) (also historically linked as `tim8707`) | EEC-IV USB/AVR/RS-485 bridge design and experimental command handling | **Reference only** |
| [DCL communication map](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/DCL_communication_map.pdf) | Candidate words, commands and response structures | **Reference only** |
| [Original AVR implementation](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/EEC-IV_asm) | Timing and UART / bridge buffering precedents | **Reference only** |
| [ParameterServiceImpl.java](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/service/ParameterServiceImpl.java) | Candidate conversion formulas and field offsets | **Reference only; no automatic sensor names or units** |
| [EECIVParameters.csv](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/eec-iv/EECIVParameters.csv) | External PID/parameter labels | **Reference only** |
| [DCL packet/parity discussion, issue #7](https://github.com/babroval/ford-eec-iv-diagnostic/issues/7) | Two-byte words, parity nibble and byte interpretation hypotheses | **Reference only** |
| [flxkrmr/eec-iv-reader-arduino](https://github.com/flxkrmr/eec-iv-reader-arduino) | CART/DCL frame handling and Arduino implementation | **Reference only; upstream describes it as work in progress** |
| [flxkrmr EecIv.cpp](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp), [Cart.cpp](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/Cart.cpp) | Timings, command construction, map and frame concepts | **Reference only** |
| [flxkrmr Wiki: Development](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Development), [Manual](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Manual), [PIDs](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/PIDs), [Testing](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Testing) | External theory, example procedures and tentative parameter names | **Reference only** |
| [doncreat0r/eeciv](https://github.com/doncreat0r/eeciv), [Diag324.c](https://github.com/doncreat0r/eeciv/blob/master/Diag324.c), [tables.h](https://github.com/doncreat0r/eeciv/blob/master/tables.h) | ATMega324P DCL implementation and mode-41/mode-21 map patterns | **Reference only** |

The experimental `26A4`, `260E`, `253E`, `005E`, `004E`, `242E`, `22C6`, `271E`, `42F3`, `2293`/`22D3` and other variants are documented **with separate evidence levels**, not as an indiscriminate supported-commands list. See the [A–R experiment catalogue](sme105-dcl-experiment-plan-2026-11-07.md), [command discovery](SME105-DCL-command-discovery-2026-11-07.md), and [structural DCL analysis](SME105-DCL-protocol-structure-analysis-2026-11-07.md).

## 2. Vehicle-specific and sensor evidence

- [Ford Escort/Zetec-E workshop specifications mirror](https://workshop-manuals.com/ford/escort.orion_1991_08.1990-09.2001/mechanical_repairs/3_powertrain/329_engine_management/329-04_engine_management_zetec-zetec-e_engines/specificationsgeneral): mechanical baseline only; independently cross-check year, market, engine variant and ECU strategy.
- [Reference ECU listing for a different 1998 Escort 1.6 Zetec calibration](https://www.obdtester.com/ford-ecu-update/escort/1.6l_zetec/1998/98AB-12A650-BCC): **different part number**, not evidence that SME105 supports those functions.
- [Sensor reference verification](sensor-reference-verification-2026-11-05.md): source comparison, uncertainties, physical ranges and what still needs vehicle confirmation.
- [Warm/high-idle evidence workflow](high-idle-diagnosis.md) and [VSS/TPS follow-up](vss-tps-field-followup-20261106.md): observational procedures, not a completed diagnosis.
- Community and resale pages cited in dated reports (Ford forums, ECU catalogues and archived resources) are **secondary/unverified context**, not authoritative ECU electrical specifications.

## 3. Electrical and transceiver implementation

- [ST L9637 datasheet](https://www.st.com/resource/en/datasheet/l9637.pdf) — ISO 9141 transceiver electrical reference for *separate K-Line work*, **not** proof that DCL uses the same interface.
- [MIKROE ISO 9141 click board and schematic](https://www.mikroe.com/iso-9141-click), [schematic PDF](https://download.mikroe.com/documents/add-on-boards/click/iso_9141_click/iso-9141-click-schematic-v101.pdf) — example external circuit, not an approved vehicle installation.
- [flxkrmr PCB schematic](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/pcb/EEC-IV-Reader.kicad_sch) and [source PlatformIO profile](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/platformio.ini) — third-party implementation examples.
- [Joy-IT TTL/RS485 adapter manual](https://joy-it.net/files/files/Produkte/COM-TTL-RS485/COM-TTL-RS485_Manual_2024-04-19.pdf) — board-specific reference; verify actual chip, levels and pinout of *our* adapter.
- Internal [MAX487 bench quickstart](max487-quickstart.md), [wiring safety](wiring-safety.md), [two receiver desk plan](two-receiver-rs485-desk-plan.md), [K-Line/Pin7 engineering](pin7-kline-engineering-20261105.md) — independently maintained safety conditions.

Never infer vehicle-side electrical acceptance solely from GPIO pad witnesses, USB status, local LEDs or a generic RS-485 drawing.

## 4. ESP32, Android and storage APIs (official technical references)

- [Espressif ESP-IDF Wi-Fi](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_wifi.html) and [Arduino-ESP32 Wi-Fi AP API](https://github.com/espressif/arduino-esp32/blob/master/docs/en/api/wifi.rst) — SoftAP, stations, Wi-Fi configuration and status.
- [Android `WifiNetworkSpecifier`](https://developer.android.com/reference/android/net/wifi/WifiNetworkSpecifier) and [AOSP local-only Wi-Fi concurrency](https://source.android.com/docs/core/connect/wifi-sta-sta-concurrency) — direct no-Internet network request and routing behavior.
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore) — local cryptographic key protection.
- [Android `ConnectivityManager.NetworkCallback`](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback) — network availability and loss signals.
- [MDN storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — IndexedDB browser/WebView durability caveats.
- [Capacitor official docs](https://capacitorjs.com/docs) — native application packaging; in this project `app/` is **the APK's canonical source**, not an obsolete hosted web release.

The v29 direct SoftAP uses one user-visible WPA2 secret and an internally derived TCP `AUTH`. This is not independent two-factor authentication. Read the [one-password Wi-Fi setup](wifi_bridge_architecture_and_setup.md) for the exact protocol, saved NVS profile, rollback and limits.

## 5. Local project evidence and operational records

| Document | Purpose |
| --- | --- |
| [Firmware bridge README](../firmware/sme105_usb_bridge/README.md) | Source-pinned ECU operations, GPIO roles, USB commands and hardware invariants; check dated historical sections |
| [Current release status](../README.md#current-release--9-november-2026) | Android v1.8.17, ESP32 v29, bench acceptance boundary |
| [November Wi-Fi engineering report](../sme105_wifi_first_release_report.md) | Initial v1.8.16 Wi-Fi engineering checks (historical) |
| [Unified release report](../sme105_unified_engineering_release_report.md) | Earlier v28 and command catalogue engineering milestones |
| [Protocol notes](protocol-notes.md) | External references, parity/baud hypotheses, observed vs inferred standards |
| [DCL experiment plan](sme105-dcl-experiment-plan-2026-11-07.md) | Source words, planned tests and per-operation acceptance |
| [Historical raw captures](../captures/) | Untouched observations; names/digests/timestamps are the evidence, not summaries |
| [App recording format](../app/README.md#durable-experiment-recordings) | IndexedDB metadata, chunks and checksummed ZIP export |

**Integrity rules:** Do not delete/replace raw captures, leak secrets into Git, or rewrite old reports as though earlier observations were current. New findings belong in new dated sections citing their real test setup and hashes. A future ECU acceptance report must establish pinout/polarity and independently capture protocol responses on the target vehicle.
