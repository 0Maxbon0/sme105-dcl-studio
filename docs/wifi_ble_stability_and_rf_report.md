# SME105 Wi-Fi, BLE, stability, and RF evaluation

**Status:** engineering assessment and measurement plan, 10 November 2026  
**Scope:** the direct ESP32↔Android bridge path and transport diagnostics. This is not a vehicle ECU validation or a claim of a completed RF soak.

## Executive assessment

The production connection is a WPA2 ESP32 SoftAP at `10.77.13.1:8765` on channel 6. The phone joins the bridge directly; no router or Internet path is required. This is already a point-to-point installation in the network-topology sense: one AP and one permitted station. Wi-Fi Direct (the separate Wi-Fi Alliance P2P protocol) would add negotiation and software complexity, while Espressif states ESP32 does not support Wi-Fi Direct/P2P in its current chip software. It is not a feasible reliability upgrade on this ESP32 stack.

The available evidence confirms a working direct path, but does not establish long-duration in-car RF reliability. On 9 November the owner reported a successful direct phone connection with no disconnect during their test. Earlier software probes also observed Android dropping the local Wi-Fi because it had no Internet; that is evidence of an Android network-policy/switching path, not proof that the ESP32 stopped beaconing. No calibrated phone-side RSSI, packet capture, AP station-event trace, or extended in-car soak is recorded. See the [direct SoftAP bench record](releases/2026-11-09-direct-softap-bench.md).

The current working-tree firmware diagnostics provide AP state/channel/station count, per-associated-station RSSI, TCP send-error count, connection epochs, and an output-queue watermark, alongside AP-stop and Wi-Fi/listener counters. The queue watermark is useful pressure evidence but is not itself a count of backpressure terminations. The diagnostic script parses the station RSSI and socket-send counter, records the queue watermark separately, and leaves an explicit backpressure-event counter empty unless firmware exports one. In particular, `WIFI_DIAG rssi=0` in AP mode means no STA RSSI measurement; it is not the phone's RSSI.

## Current link profile and evidence

| Property | Current configuration or evidence |
| --- | --- |
| Wi-Fi topology | ESP32 WPA2 SoftAP, one associated client, fixed channel 6, `10.77.13.1/24`; Android connects directly using the local-network request. |
| Bridge service | Authenticated TCP port 8765. TCP `AUTH` is required before bridge commands; the private token is not included in diagnostic output. |
| Internet/router | Neither is needed for the direct path. Android may prefer another network when the SoftAP has no Internet. |
| BLE alternative | Nordic UART Service (NUS) over an authenticated/bonded BLE GATT link; Wi-Fi and BLE are different firmware/link configurations for this bridge. |
| Field confidence | Direct bench connection reported successful; no independent extended RF soak or in-car reception test is claimed. |
| ALL data profile | `ALL` is the continuous 39-channel live-data selection, loaded from a 45-word map. The firmware packs `RXB` records to preserve raw byte/timestamp evidence. |

The base `WIFI_DIAG` fields are `disconnects`, `last_reason`, `got_ip`, `reconnects`, `reinitializations`, `listener_failures`, `listener_restarts`, `listener`, `mdns`, `offline_ms`, `rssi`, `mode`, `ap_clients`, and `ap_stops`. The current working-tree extension also reports AP `channel`, indexed station RSSI (for example `sta0_rssi`), `connection_epochs`, `socket_send_errors`, and `queue_watermark`; `WIFI_AP_STATUS` includes station/channel/RSSI and the same send/queue telemetry. `last_reason` is an ESP-IDF disconnect code, not a proven physical cause. Event counters reset on bridge power-up.

## Failure-mode classification

Treat the following as competing fault domains. A phone UI stall or a stopped ECU byte stream alone does not identify which layer failed. Save simultaneous host logs and bridge diagnostics before rebooting; bridge counters are volatile across power loss.

| Failure mode | Distinguishing evidence | Interpretation / next measurement |
| --- | --- | --- |
| **1. 802.11 association loss** | AP remains `ACTIVE`; station count drops; Android ConnectivityManager disconnect/reassociation timestamp; compare the per-station RSSI trace when available. | RF association ended while the AP may still be healthy. Firmware exposes station count and station RSSI, but not a timestamped association-event history; polling can miss short transitions. Do not infer RF cause from `disconnects` alone. |
| **2. ESP32 AP stop/restart** | `WIFI_AP_STATUS state=INACTIVE`, `WIFI_DIAG ap_stops` increments, AP IP disappears/reappears, or boot ID/reset reason changes. | Device AP lifecycle/power/reset path, not merely a client roaming event. Preserve USB boot/reset logs and supply measurements. |
| **3. Android network switching / loss** | Android network callback or Wi-Fi Settings shows the phone leaving the local-only SSID; AP may remain active and station count fall. TCP may close after the switch. | Android can deprioritize a Wi-Fi network without Internet or bind sockets to another network. The earlier automated probe observed this class of drop; it is not proof of an ESP32 AP stop. Log Android network selection and the bridge AP state at the same time. |
| **4. TCP FIN/RST** | Host socket EOF or reset; packet capture shows FIN or RST and its direction; AP association can remain up. | TCP session ended. The current bridge diagnostic counters do not identify FIN/RST direction; capture both endpoints or log native socket close/error callbacks. |
| **5. TCP half-open socket** | No FIN/RST and AP may remain associated, but repeated application `STATUS` heartbeat requests receive no reply before deadline. | Radio association does not prove a healthy TCP/application path. The diagnostic and benchmark tools use bounded read-only STATUS heartbeats and start a new connection epoch after recovery. |
| **6. Application listener / WebView loss** | Native socket remains connected/authenticated while UI callback/listener stops, duplicates, or becomes stale; compare native plugin status with WebView lifecycle and JS event logs. | App observation lifecycle defect, not necessarily a radio loss. Check listener registration/cleanup, WebView pause/resume, and connection generation alongside native status. |
| **7. Native reader/writer failure** | Native socket is still reported open but the receive loop, notification listener, or write queue errors/stalls; correlate native exceptions, byte counts, and last successful STATUS RTT. | Failure inside the Android transport/plugin path. Separate inbound reader errors from outbound write errors; do not diagnose from a frozen dashboard alone. |
| **8. Firmware output backpressure** | In an active session, missing terminal `END`, `FAULT reason=17` / `TRANSPORT_BACKPRESSURE`, queue overflow, a rising output-queue watermark, or a bridge-initiated TCP drop. | Firmware output queue/consumer rate problem. This is not an RF diagnosis. Source history documents a prior slow USB mirror exhausting the bounded queue; later code makes authenticated TCP the primary recipient and treats USB as best-effort. Current diagnostics expose queue watermark and TCP send errors, but not a dedicated count of backpressure terminations; preserve the exact stream and USB/firmware evidence. |
| **9. BLE GATT / notification failure** | GATT disconnect callback, notification subscription loss, MTU/service-discovery error, notification gaps while GATT still says connected, or a write/fragment reassembly failure. | Distinguish supervision disconnect from application notification loss. BLE can be connected while the NUS notification stream is unusable; compare negotiated MTU, CCCD/subscription state, received chunk count, and line reassembly. |
| **10. ECU `RX_SILENCE` / ECU-side or receive-path failure** | Firmware emits `FAULT reason=19 cause=RX_SILENCE` after five seconds without UART1 receive bytes; Wi-Fi/BLE may remain connected and heartbeat replies may continue. | ECU/bus/transceiver/UART receive path stopped yielding bytes. `RX_SILENCE` is **not Wi-Fi loss**: the watchdog measures UART1 receive inactivity and fail-closes the bridge transmitter. A live TCP or BLE link can coexist with this fault. Independently examine the ECU response and electrical receive path; do not reboot Wi-Fi as the assumed fix. |

### What is and is not established

- Established: direct SoftAP connectivity has worked on the bench, and the bridge can return authenticated read-only commands. The owner reported no disconnect during the 9 November manual test.
- Observed separately: an automated Android probe sometimes left the local-only SSID because it did not provide Internet. This shows an Android network-selection failure mode exists, not that it caused every earlier stall.
- Known firmware behavior: low output-queue space/overflow while a bus session is active causes fail-closed `TRANSPORT_BACKPRESSURE`; that termination can look like a dropped TCP connection at the host.
- Not established: in-car RSSI margin, channel utilization, AP association-loss rate over a long run, phone-specific reconnect time, or that any `RX_SILENCE` event was caused by Wi-Fi.

## Wi-Fi, Wi-Fi Direct, BLE, and ESP-NOW

### SoftAP versus Wi-Fi Direct

The current SoftAP is direct phone-to-bridge Wi-Fi: the ESP32 is the access point and the phone is its station. “Direct” here means there is no router or Internet hop. It does not mean the Wi-Fi Direct/P2P protocol. For one phone, one bridge, and one TCP control stream, the existing SoftAP already supplies the required point-to-point path.

Wi-Fi Direct uses P2P discovery and group negotiation, including determining which peer acts as group owner, before creating the group. Espressif’s ESP FAQ states its chips currently do not support Wi-Fi Direct/Wi-Fi P2P. Thus this is not an ESP-IDF/Arduino configuration switch for the installed ESP32. Pursuing it would require a different platform or custom unsupported stack, add connection negotiation, and offer no demonstrated range or reliability gain over the working WPA2 SoftAP. [Espressif ESP FAQ: Wi-Fi Direct/P2P](https://github.com/espressif/esp-faq/blob/master/docs/en/software-framework/wifi.rst)

ESP-NOW is also not a drop-in Android transport. Espressif defines it as a connectionless protocol carrying application data in vendor-specific Wi-Fi action frames, with ESP-specific peer/security setup. A smartphone application normally uses Android's Wi-Fi IP/TCP APIs or Bluetooth GATT; it does not expose a general ESP-NOW peer transport. Adopting ESP-NOW would require a custom phone-side radio/driver path and a replacement for the existing authenticated TCP stream, framing, reconnect, and app integration. It would add work without current evidence of a reliability problem in SoftAP. [ESP-IDF ESP-NOW overview](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/network/esp_now.html)

### Wi-Fi versus BLE

| Property | Direct SoftAP + TCP | BLE GATT/NUS |
| --- | --- | --- |
| Payload path | TCP byte stream with line framing and authenticated bridge session. | GATT writes and notifications; notification fragments must be reassembled into lines. |
| MTU / framing | Larger stream buffers; no BLE ATT MTU limit. | The installed BLE bridge requests MTU 247, giving up to 244 bytes of ATT value before other framing. A smaller negotiated MTU means more fragments. |
| Throughput | 802.11/TCP provides substantial capacity for continuous raw output. Espressif publishes up-to figures for ESP32 Wi-Fi, but those are not a measurement of this board, phone, or app. | Smaller packets and BLE connection/notification scheduling reduce throughput. The existing ESP32 implementation paces notifications and buffers bounded queues. |
| Link supervision | Association/TCP alone can fail silently to an application unless the client uses an application heartbeat and recovery state machine. | Link supervision and bonded GATT state make disconnect detection simpler; a subscribed notification path can still stall independently of the link. |
| ALL stream suitability | Preferred for continuous ALL (39 unique channels): preserve the full packed stream and maintain a target of at least **10× measured peak payload-rate headroom**. That margin is an engineering acceptance target, not a completed measurement in the current evidence set. | Functional fallback, but it has less throughput margin and more MTU/fragmentation/notification failure modes to validate for sustained ALL output. |
| Current comparative evidence | Direct SoftAP bench success; no long soak metrics. | Android acceptance records a bonded BLE link and MTU 247, and forced-disconnect recovery; sustained vehicle streaming has not been established by that evidence. |

The BLE firmware source sets an MTU target of 247; Android acceptance evidence recorded MTU 247 on the Galaxy A52s. ATT uses three bytes of per-PDU overhead, so 244 bytes is the value payload at that MTU. [ESP-IDF BLE connection and MTU documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-guides/ble/ble-connection.html)

The ECU UART is configured for 9600 baud, 8N1. Each payload byte uses ten wire bits (one start, eight data, one stop), so its theoretical maximum is **960 raw payload bytes per second** (`9600 / 10`), before any protocol or scheduling overhead. The benchmark reports received application bytes per second separately from decoded `RX`/`RXB` telemetry bytes per second; the latter is the appropriate measured raw-payload rate to compare with the UART ceiling. Wi-Fi/TCP capacity does not increase the UART source rate.

Wi-Fi is the preferred continuous ALL transport because it provides more payload capacity and avoids relying on high-rate GATT notifications. Require measured sustained throughput to exceed the peak ALL output rate by 10× under representative conditions; do not substitute a datasheet peak rate or a STATUS-only benchmark for that proof. Both transports still need end-to-end heartbeats, bounded queues, fail-closed behavior, sequence/gap measurement, and explicit reconnection handling.

## 2.4 GHz channels and vehicle RF

For a 20 MHz channel plan, channels 1, 6, and 11 are the commonly used non-overlapping set in regions where all three are permitted. They are not three interference-free “lanes”: co-channel airtime, adjacent-channel energy, regulatory channel availability, and nearby transmitters still matter. Current bridge firmware is fixed to channel 6; compare an RF scan at the vehicle location before proposing a firmware/channel change. [Apple Wi-Fi deployment guidance](https://support.apple.com/en-asia/guide/deployment/dep2af1caf35/1/web/1.0)

In a car, plausible sources include Bluetooth accessories and head units, wireless CarPlay/Android Auto radios, passenger hotspots, and nearby roadside/home APs. Their bands vary by phone, head unit, region, and configuration: wireless Android Auto requires 5 GHz Wi-Fi support, while wireless CarPlay uses Bluetooth and a Wi-Fi access point. They should not all be treated as confirmed 2.4 GHz interferers. Bluetooth and any 2.4 GHz hotspot can overlap directly with the bridge's 2.4 GHz channel; 5 GHz traffic does not co-channel with channel 6, though a combined system may still use Bluetooth for setup/control. [Google Android Auto requirements](https://support.google.com/androidauto/answer/6348019?hl=en) · [Apple wireless CarPlay system requirements](https://developer.apple.com/videos/play/wwdc2017/717/?time=1790)

Recommended RF practice:

1. Use the least congested permitted channel among 1/6/11 when a supported configuration allows it; current fixed channel 6 means channel changes require a separate firmware decision.
2. Keep the antenna away from the metal dashboard/enclosure, ESP32 USB/UART wiring, DC/DC converters, and large ground planes. Preserve the module antenna keep-out and orient the board so the antenna has a clear path toward the phone. Espressif recommends placing an on-module PCB antenna at the host-board edge and keeping its clearance area free of metal/copper/components. [ESP32 hardware design guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/pcb-layout-design.html)
3. Prefer the existing onboard PCB antenna when it is unobstructed and its RSSI margin is adequate. Use an IPEX/U.FL external antenna only when the actual ESP32 module has a connector and antenna-selection path; choose a 2.4 GHz, 50 Ω antenna within the module's certified gain/EIRP limits and position it outside the metal enclosure. Do not solder an antenna onto a module that lacks the matching connector/selection circuit. [ESP32-WROOM external antenna module limits](https://documentation.espressif.com/esp32-wroom-32d_esp32-wroom-32u_datasheet_en.html)
4. Do not raise transmit power by default. ESP-IDF exposes a maximum TX-power control, but the configured value is quantized and constrained by module/PHY/regulatory limits. Higher ESP32 downlink power does not improve the phone-to-ESP32 uplink. Verify both directions and legal EIRP before changing power. [ESP-IDF Wi-Fi TX power API](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/network/esp_wifi.html)

## Diagnostic and benchmark tools

### Secret-free Wi-Fi health log

`scripts/rf_wifi_diagnostics.py` defaults to direct SoftAP authentication: it prompts for the WPA2 password, derives the AUTH token from that password and SSID `SME105-DIRECT-2BF8`, then polls only `WIFI_AP_STATUS`, `WIFI_DIAG`, and read-only `STATUS`. Supply `--ssid` for a different SoftAP name or `--password` to provide the password non-interactively. For station mode, use `--sta --token-file PATH` to read the existing private token file. The script writes JSONL with UTC and monotonic timestamps, a monotonically increasing connection epoch, channel/station count/RSSI, station-count transitions, available diagnostic counters, TCP send errors, output-queue watermark, and explicitly labeled STATUS RTT. It intentionally does not print raw protocol lines, SSID, PSK, token, or ECU bytes.

```bash
python3 scripts/rf_wifi_diagnostics.py --duration 1800 \
  --output captures/rf-health.jsonl

python3 scripts/rf_wifi_diagnostics.py --sta --token-file ~/.config/sme105/bridge-token \
  --host 192.168.1.50 --duration 1800 --output captures/rf-health-sta.jsonl
```

On firmware without the current diagnostic extension, `associated_station_rssi_dbm` and `socket_error_counters` may be null/empty. A dedicated `backpressure_counters` value remains empty unless firmware exports such a counter; the separate `output_queue_watermark` is a non-cumulative indicator. `WIFI_DIAG rssi` is retained as a bridge-side field but is not relabeled as phone RSSI in AP mode.

### Comparable Wi-Fi/BLE link benchmark

`scripts/wifi_ble_benchmark.py` repeats only read-only `STATUS` heartbeats, labels their p50/p95/p99 latency as STATUS RTT, measures received application bytes/s, connection loss frequency, and elapsed time from detected link loss to the next authenticated connection. Wi-Fi defaults to direct SoftAP auth and prompts for its WPA2 password; `--ssid` and `--password` override the defaults. Use `--sta --token-file PATH` for station-mode Wi-Fi auth. The report includes the 960-byte/s theoretical 9600-baud 8N1 UART raw-payload ceiling and the measured decoded telemetry rate as a percentage of that ceiling. It analyzes `RX`/`RXB` records if the authenticated session emits them: sequence loss is reported only when an `RX seq=` sequence exists; long sample gaps use the configured threshold. With no telemetry in an idle run, telemetry loss/gap metrics are `null` rather than falsely zero. No command starts or resumes an ECU read.

Run matching profiles on the appropriate Wi-Fi and BLE bridge configurations, at the same phone/device placement and with the same no-vehicle or already-authorized test conditions. Disconnect the other controller before a run; the bridge accepts only one remote controller. Do not compare runs with a different firmware, MTU, heartbeat interval, output workload, power state, or RF placement as if the difference were transport-only.

```bash
python3 scripts/wifi_ble_benchmark.py --transport wifi --duration 300 \
  --interval 1 --result captures/wifi.json --events captures/wifi-events.jsonl

python3 scripts/wifi_ble_benchmark.py --transport ble --duration 300 \
  --interval 1 --address AA:BB:CC:DD:EE:FF \
  --result captures/ble.json --events captures/ble-events.jsonl

python3 scripts/wifi_ble_benchmark.py --compare captures/wifi.json captures/ble.json
```

The read-only STATUS workload measures command/reply responsiveness and idle application throughput. It does **not** by itself qualify sustained ALL throughput or radio range. A defensible ALL acceptance run needs an explicitly authorized active read, matched across transports, complete raw capture, and a known telemetry sequence/timestamp baseline; these scripts deliberately do not initiate that vehicle operation.

## Telemetry Recovery, Timing & Memory Specification

### Telemetry Ring Buffer Memory Layout

The firmware's telemetry ring buffer is implemented in `firmware/sme105_usb_bridge/telemetry_ring.h` with zero dynamic heap allocation:
- **Event Packing:** Each `TelemetryRing::Event` is explicitly packed to 5 bytes:
  - `uint32_t at` (4 bytes): ESP32 microsecond timestamp.
  - `uint8_t value` (1 byte): Raw received UART telemetry byte.
  - Sequence numbers are NOT stored per event; monotonic sequence IDs are derived arithmetically from `firstSeq_` and slot offset modulo 8,000.
- **Total Static Memory Footprint:** Exactly `8,000 × 5 = 40,000 bytes` (~39.06 KiB).
- **Object Footprint:** `sizeof(TelemetryRing)` is 40,020 bytes on 32-bit Xtensa ESP32 (40,000 bytes event array + 20 bytes metadata: `firstIndex_`, `count_`, `firstSeq_`, `latestSeq_`, `dropped_`), satisfying `static_assert(sizeof(TelemetryRing) <= 48 * 1024)`. (Previous documentation referencing 96 KB assumed an unpacked 12-byte representation; the actual compiled code uses 40 KB).

### Verified Firmware & Network Configuration

- **Firmware Version:** `fw=29` (`kUsbInstalledBuildVersion = 29` in `firmware/sme105_usb_bridge/sme105_usb_bridge.ino`).
- **Direct SoftAP IP:** `10.77.13.1` (netmask `255.255.255.0`, broadcast `10.77.13.255`).
- **Dedicated USB Wi-Fi Adapter Host Subnet:** `10.77.13.2/24` (no gateway, no DNS; isolated from Docker 192.168.x bridges).
- **TCP Control Port:** `8765` (requires authenticated handshake).
- **Default SoftAP SSID:** `SME105-DIRECT-2BF8` (WPA2-PSK).

### Distinction Between Timeouts and Retention Windows

1. **TCP Heartbeat (Active Link Supervision):**
   - The Android client transmits `PING <seq>` every 2.0 seconds.
   - The firmware immediately echoes `PONG <seq>`.
   - If no inbound traffic or valid PONG reply is received for 6.0 seconds, the connection is classified as half-open and the socket is forcibly closed.
2. **Session Retention Grace Period (30 Seconds):**
   - Upon transport drop, an active Live Data session enters `RECOVERY_DETACHED`.
   - The ECU continues polling uninterrupted for up to 30.0 seconds.
   - If an authenticated client reconnects and issues `RESUME <boot> <session> <last_seq>` within 30 seconds, the session is resumed. If 30 seconds elapse without resumption, the session is terminated (`stopEverything(CAPTURE_TIMEOUT)`).
3. **Effective Ring Retention Window (Throughput Dependent):**
   - The 8,000-slot buffer holds 8,000 raw bytes.
   - At theoretical 9600-baud 8N1 raw UART throughput (maximum 960 bytes/s), the ring wraps in:
     $$\frac{8000 \text{ bytes}}{960 \text{ bytes/s}} \approx 8.33 \text{ seconds}$$
   - At typical Live Data polling rates (200–400 bytes/s), the ring retains 20.0 to 40.0 seconds of history.
   - The 8.33s value represents buffer retention capacity at the theoretical maximum 960 bytes/s UART ceiling (continuous ALL mode); actual retention time before eviction depends on the operative telemetry transmission rate. A dropout produces an inclusive `EVENT telemetry_gap` only if the requested sequence has already been evicted from the ring; otherwise, replay is completely seamless and gapless.

### Terminal Delivery Guarantees

In `firmware/sme105_usb_bridge/sme105_usb_bridge.ino:reportEnd()`:
- `last_term_queued=1` (and `lastTerminalOutcome.queued`) confirms that the terminal text block (`END reason=...` or `FAULT reason=...`) was successfully admitted into the firmware's internal `BridgeOutput` buffer.
- `last_term_queued=1` does **NOT** guarantee that the terminal packet was successfully transmitted over the physical 802.11 radio, acknowledged at TCP layer, or parsed by the Android application.
- If `BridgeOutput` is congested, the bridge stays in `FINISHING` state without clearing the session or driving DE LOW, retrying admission on subsequent loop cycles to prevent silent terminal truncation.

### Synthetic Bench Protocol Safety Notice

Synthetic bench testing (e.g. via USB or test harnesses) without an ECU or validated ECU simulator tests bridge command handling, TCP heartbeats, and reconnect states. Real Live Data telemetry records (`RX`/`RXB`) cannot be obtained without an actual vehicle ECU or an adequate, validated ECU simulator. Hardware safety gates (`gate4=1`, `DE=LOW`, `auto_tx=0`, `tx2_bench_pass=1`) are strictly enforced.

## References and local evidence

- [Direct SoftAP bench delivery, 9 November 2026](releases/2026-11-09-direct-softap-bench.md)
- [Wi-Fi bridge architecture and setup](wifi_bridge_architecture_and_setup.md)
- [Wi-Fi recovery evidence and `WIFI_DIAG` fields](sme105-wifi-recovery-v7-2026-11-03.md)
- [RX_SILENCE investigation](live-rx-silence-investigation-2026-11-05.md)
- [Android acceptance matrix: BLE MTU, lifecycle, and disconnect recovery](ANDROID_REBUILD_ACCEPTANCE_MATRIX.md)
- [ESP-IDF Wi-Fi Direct/P2P support statement](https://github.com/espressif/esp-faq/blob/master/docs/en/software-framework/wifi.rst)
- [ESP-IDF ESP-NOW protocol](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/network/esp_now.html)
