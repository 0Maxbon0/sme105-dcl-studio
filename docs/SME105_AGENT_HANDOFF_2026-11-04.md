# SME105 Ford EEC-IV — AI Agent Engineering Handoff
> Updated: 2026-11-04. Primary language with owner: Egyptian Arabic. This is a historical evidence-led handoff, NOT proof of a functional ECU DTC reader. Source: committed docs, raw captures, prior real device commands and current git inspection.

> **2026-11-04 later update (supersedes the historical v7 installed status below):** Firmware **v9** was safely flashed USB application-only on the same ESP32 and confirmed **VALID**, accepted_version=9. A dedicated **WPA2 direct AP** now runs as SME105-DIRECT-2BF8 / **10.77.13.1:8765**; the laptop USB RT5370 at **10.77.13.2** authenticated TCP STATUS successfully while the internal Wi-Fi stayed on **Venom** for internet. Direct AP automatically rejoined after supervised desktop ESP32 reset. **This was a desk test; there has NOT yet been a v9 in-car range test or ECU DTC validation.** Read the full signed hashes, successes, failures, network adapter profile, safe setup/recovery and next-car checklist in **docs/sme105-direct-ap-v9-2026-11-04.md**. Later v9 results replace older lines below that explicitly describe the *previous* v7 hardware state; older event history remains valid.

## 1. Decision and status

**LIMITED GO**: The ESP32 can return to the car for staged, protected **Wi-Fi stability, read-only STATUS, and if separately authorized, passive RX** testing. **NO-GO** for direct diagnostic A4/0E read, ECU actuation, or a promise to extract DTCs.

| Subsystem | Latest verified | Unproven or blocked |
| --- | --- | --- |
| USB/board | ESP32-D0WD-V3 rev3.1, 4 MB, CP2102, MAC 00:4b:12:3b:2b:f8 | In-car 5V/3.3V integrity and reset/brownout during dropout |
| Installed image | USB-flashed v7, running=app0 boot=app0 accepted_version=7 boot_health=VALID rollback=1 | No long in-car field validation on v7 |
| Network | Wi-Fi Venom, last IP 192.168.1.10:8765; authenticated TCP read-only replies, RSSI -58/-59 dBm near laptop | Actual 5–10m/one wall car link/reconnection, DHCP/antenna/power root cause |
| Current fixes | Bounded Wi-Fi retry, full STA reinit, listener retry and mDNS recovery; TCP-primary fan-out | Recovering from a deliberately induced in-car RF outage not yet measured |
| Bridge RX | 95 bytes in one active OBSERVE with TCP END missing; later passive 30 bytes with END/zero UART error | ECU source, DTC, electrical A/B differential, command variant |
| GPIO17 | 4/4 local UART2 pad words and independent RMT first word PASS, DE LOW | Not a MAX487 A/B or ECU acknowledgement |

**Do not confuse last verified v7 with older documents correctly reporting v5**. The laptop poweroff command was issued with exit code 0 after v7 verification, but no physical verification of shutdown. No further car test since v7 flash.

## 2. Repository and key files

Shared workspace: /escort-scanning (native: /media/maxim/MAX/Docs/Maxim Docs/Maximizo/escort scanning). Branch main; latest inspected HEAD before this handoff: 0146701.

- 0146701 docs(escort): record v7 WiFi USB validation and readback limit
- a3820df fix(escort): recover WiFi station, listener and mDNS after loss
- 07ae7a6 fix(escort): keep authenticated CART capture independent of USB output
- 36b35de feat(escort): verify TX2 GPIO17 and enable signed recoverable WiFi OTA

Core: firmware/sme105_usb_bridge/sme105_usb_bridge.ino; build firmware/sme105_usb_bridge/platformio.ini (esp32dev, espressif32@6.12.0, Arduino ESP32 2.0.17); README at firmware/sme105_usb_bridge/README.md.

Hosts: scripts/sme105_usb_bridge.py (authenticated TCP/USB capture); scripts/sme105_wifi_setup.py (USB-only provisioning); scripts/sme105_wifi_ota.py (signed OTA).

Tests: tests/test_sme105_wifi_recovery.py, tests/test_sme105_bridge_fanout.py, tests/test_sme105_tx2_pad_source.py, tests/test_sme105_usb_bridge.py, tests/test_sme105_wifi_setup.py, tests/test_sme105_wifi_ota.py, tests/test_sme105_ota_ledger.py, tests/test_sme105_ota_ack_restart.py.

Detailed source docs: docs/sme105-in-car-observe-2026-11-03.md; docs/sme105-wifi-recovery-v7-2026-11-03.md; docs/sme105-cart-isr-crash-2026-11-02.md; docs/sme105-timed-dtc-development-2026-11-02.md; docs/sme105-field-console.md; docs/next-vehicle-diagnostic-readiness-2026-11-02.md (the last was untracked at inspection; never assume it was pushed).

**Dirty tree warning:** numerous unrelated modified and untracked firmware, Web, scripts, docs and tests already existed. Preserve them all. Never use git add -A, git clean, or git reset --hard. Current task owns only this handoff file. There was **no push** of v7 commits during previous work; check remote independently.

## 3. Hardware and safety

- ECU Ford EEC-IV SME105, historical ECU identifier 97AB-12A650-KA; vehicle/source match not independently authenticated.
- GPIO16 <- MAX487 RO via BSS138 -> UART1 RX.
- GPIO17 -> MAX487 DI using UART2 TX, also sampled locally via UART2 PAD input and independent RMT witness.
- GPIO18 -> MAX487 DE; external 10k pulldown, /RE connected to ground. Verify DE LOW when idle.
- UART USB 115200 8N1; Wi-Fi 2.4 GHz STA ONLY, TCP 8765, mDNS sme105-bridge.local, _sme105._tcp.local. No AP and no auto ECU TX.
- Earlier A/B resistance ~188 ohm, protection SM712 and local MAX487 self-echo do NOT certify automotive load, transients or safe ECU pinout. Do not change SMD termination by guesswork.
- Exact command candidates differ by public scanner source: flxkrmr uses third word 26 A4 (4-slot proposal), doncreat0r uses 26 0E (14-slot proposal). Neither is verified for this ECU. Do not issue either READ candidate in car.
- Per-boot OBSERVE and diagnostic consumed latches can reset on power-cycle, but **owner authorization never resets automatically**. No clear codes/KOEO/KOER actuators/arbitrary TX.

## 4. Chronological attempts — success, failure and uncertainty

### 2026-11-02: early car evidence and desk bench

- captures/ECHO_ID_ONCE/20261102T144928924270Z.txt: reference Echo Module ID at 2400 8N2, eleven local echo bytes followed by candidate 01 ACK; origin not independently authenticated.
- captures/CART_ONCE/20261102T150417765534Z.txt: after Go CART, 3984 bytes, exactly 996 four-byte ID groups, 62 complete cycles ID0..15 plus four groups. **ID-only**, no validated DTC/PID. Last terminal line truncated, so UART-error evidence incomplete. SHA256 857c83e98fa6197c089ba0599c449b90513f06dbc9ce5601b97d9d862a7b213c.
- Operator observed MAX487 RX LED extinguish when ignition was off. Suggests ignition-linked signal, not proof each byte originated at ECU.
- With car disconnected: internal UART 2400 Echo 11/11 and 9600 CART 64/64 PASS; MAX487+BSS138 external self-echo at 2400 11/11 and 9600 64/64 PASS. This proves local electronics only. An earlier readiness milestone reported 74 tests PASS, hard-denied Web direct serial send API (HTTP 423) and unsafe quick actions disabled.
- **Confirmed crash:** captures/TIMED_CART/20261102T181943265142Z-cart-isr.txt, SHA256 7d52258ea15b0476f45939d19552b91dc443912d7822fe261bef96c15087eec8: after Go CART old firmware panicked StoreProhibited, EXCVADDR 0x00000008, core1, no CART_EVT or DTC. Crash printed twice; not necessarily two distinct approved attempts. Symbolicated PC in uart_isr_register after HardwareSerial::end() had destroyed UART2 driver. Older firmware V2 fixed native ISR lifecycle with esp_intr_alloc and esp_intr_free, plus DE-LOW RX ISR self-test. Do not reflash this obsolete V2 or misinterpret crash as ECU rejection. See docs/sme105-cart-isr-crash-2026-11-02.md.
- Timed DTC analysis preserved synthetic alternative decoding (116 vs 161 is **not** an Escort fault). Real 4-word TX and differential timing not proven.

### 2026-11-03: local GPIO17 and OTA v5

- An older V5 local source trace read 6D CC / 29 E9 / 6C 3C / 98 47 instead of intended 01 B0 / FF 5F / 26 A4 / 00 A0. Therefore physical PAD witness and independent RMT receive were added.
- Later TX2_BENCH hardware in safe local mode passed 4/4 expected words and RMT first-word 01B0 match=1, with DE LOW and ecu_tx=0. This is **PAD only**; no evidence of correct MAX487 differential or ECU reaction.
- Signed Wi-Fi OTA for v4 and v5 had succeeded without an open USB Serial Monitor. Last authenticated version before subsequent work: accepted_version=5 running=app0 boot=app0 boot_health=VALID confirm_required=0 rollback=1.

### 2026-11-03: in-car v5 session

1. On vehicle: authenticated TCP STATUS from 192.168.1.10:8765 with stage0, DE LOW, auto_tx0, read_used0, observe_used0 and fault0. Capture 20261103T201945743134Z-usb-bridge.txt.
2. Initial RO-only LISTEN_9600: no useful data or terminal END before host deadline; following STOP returned END reason16 CAPTURE_TIMEOUT, ro_bytes0. Capture 20261103T201957425082Z-usb-bridge.txt. **Failure / incomplete**, no ECU transmit.
3. Previously permitted RESET_IDLE then isolated TX2_BENCH 4/4 PAD+RMT PASS, DE LOW. Capture 20261103T202228623749Z-usb-bridge.txt.
4. **Exactly one owner-approved active OBSERVE**: 2400 ECHO_ID 11 bytes, 11 echo bytes + candidate 0x01 ACK source UNVERIFIED, GO_CART 11 bytes, then UART1 9600 raw; 95 bytes with repeating 16-ID headers and ~10ms cadence. No END because authenticated TCP disconnected. Follow-up fault17 TRANSPORT_BACKPRESSURE, observe_used1, read_used0. Captures 20261103T202539537314Z-usb-bridge.{txt,bin} and 20261103T202623567285Z-usb-bridge.txt. **Incomplete/untrusted; no verified DTC**.
5. With previous permission reset to idle, repeated **passive only** LISTEN and manually STOP: 30 bytes, END reason15 HOST_STOP, ro_bytes30, ro_lost0, uart_errors0, DE LOW. Capture 20261103T202934803038Z-usb-bridge.{txt,bin}. The raw data count matches but **ECU origin remains unproven**.
6. Final v5 OTA status VALID. No READ_A4, READ_0E, clearing codes or actuator actions were executed.

**Root cause of field fault17:** BridgeOutput previously held the bounded 16 KiB evidence queue behind the slowest USB/TCP consumer. The optional USB monitor was closed; USB cursor lag caused queue exhaustion even when authenticated TCP drained, invoking fail-closed TCP disconnection. This is **not evidence of RF radio disconnect**. Commit 07ae7a6 switched authenticated TCP to primary, USB to optional counted mirror usb_skipped while TCP backpressure still fails closed. Extracted original C++ queue tests + 227 Python tests, Ruff and PlatformIO passed. v6 was built/signed with this fix, but not uploaded.

**Standalone v6 NEVER installed:** frozen binary ~/.config/sme105/firmware-v6-car-fanout-20261103.bin and .json, size 831152, SHA256 9c5a53ff052c0e91943c3dae9e228e795f089c6cbf1292c0b2d72c605713ca73. OTA preflight blocked by disappearance from Wi-Fi; no OTA_BEGIN2 or bytes ever sent for v6.

### 2026-11-03: Wi-Fi vanishes in car; discovery fails

- Owner reported LED still lit, rebooted himself and requested discovery only. Ten TCP attempts at .10 failed, laptop SSID Venom IP 192.168.1.18/24 and gateway .1 available; .10 ARP FAILED/INCOMPLETE.
- DNS/mDNS sme105-bridge.local and _sme105._tcp.local, entire LAN 192.168.1.1–254 TCP/8765 scan, ICMP and ARP MAC checks found no bridge. Other .1 .2 .7 .9 returned ICMP; .3 appeared in ARP. These devices were **not** identified as ESP32.
- First asynchronous Python scan script was malformed (ValueError: coroutine expected); corrected and final full scan succeeded with zero matching bridge. A failed script is not radio evidence.
- Router DHCP/WLAN association table was not accessed. Thus power/brownout, antenna/shielding, 2.4GHz interference, router/client isolation, AP disassociation, DHCP, server failure or other network remain candidates.
- Owner then **removed ESP32 from car and connected it to the laptop over USB**: bridge showed at its OLD 192.168.1.10:8765 with exact old MAC, and TCP connect-only probe succeeded 5/5. Initial mDNS query still had no response. Moving/powering the board changed conditions; it does **not** prove what failed in the car.

### 2026-11-03: Wi-Fi recovery v7 repair and deployment

Owner specifically requested auto reconnect, review related bugs, integrate into firmware, USB flash then laptop poweroff. The board was separated from car during development/flash.

Verified software findings and repairs in a3820df:
1. Arduino autoReconnect only retries certain disconnect reasons. Explicit bounded STA reconnect every 10s and reinitialization from **existing NVS settings** after 60s continuous offline, without NVS erase, and no disruptive Wi-Fi operation during active vehicle timing.
2. WiFiServer::begin returns void; previous firmware assigned wifiServerStarted=true without checking if bind/listen succeeded. New code checks WiFiServer listening state, cleans up failed socket and retries every 3s.
3. IP renewal / GOT_IP invalidates old TCP/auth session and restarts listener/mDNS; failed mDNS registration retried every 10s, not silently abandoned.
4. Modem sleep disabled for low-latency always-on Wi-Fi (higher power requirement; supply must be tested).
5. New secret-free read-only WIFI_DIAG: disconnects, last_reason (numeric IDF reason), got_ip, reconnects, reinitializations, listener_failures, listener_restarts, listener, mdns, offline_ms and rssi. Counters reset on reboot.
6. Signed OTA ledger protections, no cross-client authorization and DE/vehicle restrictions preserved. Physically USB-installed v7 version baseline adopted only on existing VALID app without pending signed ledger.

**Checks:** full Python suite **230 tests PASS**, Ruff PASS, PlatformIO esp32dev SUCCESS. New tests include extracted recovery-policy C++ interval/wraparound/active vehicle protection.

**v7 image:** ~/.config/sme105/firmware-v7-wifi-recovery-20261103.bin plus signed .json, size **833712**, SHA256 **48d85990460f4d416508f0bfc85b06f212385e11d121be7c2056656ed980a384**, offline signature verified against pinned public trust anchor. Permissions 0600. Old v6 frozen files not touched.

**Physical USB:** CP2102 /dev/ttyUSB0 and by-id symlink, esptool verified ESP32-D0WD-V3 MAC 00:4b:12:3b:2b:f8, 4MB flash. Before flash, board returned v5 app0 VALID. Backups mode 0600 outside Git under ~/.config/sme105/usb-pre-v7-20261103/ : nvs.bin 0x9000/0x5000, otadata.bin 0xe000/0x2000, app0-pre-v7.bin 0x10000/0x140000.

Wrote **only application firmware.bin** to active app0 offset 0x10000, no bootloader/partitions/NVS/otadata erase. Esptool reported **Wrote 833712 bytes; Hash of data verified**, then reset. On-board:
- STATUS stage0 DE LOW auto_tx0 gate4=1 read_used0 observe_used0 usb_skipped0 fault0.
- OTA_STATUS running=app0 boot=app0 accepted_version=7 boot_health=VALID confirm_required=0 rollback=1.
- WIFI_STATUS CONNECTED ip=192.168.1.10 port=8765.
- WIFI_DIAG listener=1 mdns=1 got_ip=1 rssi=-59 dBm.
An **independent full flash readback** was attempted but **stalled near 31%**; intentionally interrupted, **no write**, so second-pass byte-for-byte match is **NOT proven**. Write-time hash validation and real boot did pass.
A subsequent USB reset and authenticated TCP session returned STATUS/OTA_STATUS/WIFI_STATUS/WIFI_DIAG successfully, v7 VALID, DE LOW, RSSI -58 dBm, listener=1, mdns=1. This proves boot/service; **not controlled RF dropout recovery**. One early USB HELLO/STATUS read had garbled/duplicated output/timeouts; later clean resets/read-only replies succeeded. Do not mistake stale USB serial output for ECU evidence.

Commit a3820df code/tests; 0146701 detailed deployment documentation. No push. systemctl poweroff returned exit code 0 after final report; no independent physical shutdown observation.

## 5. Evidence inventory, exact SHA256 and interpretation

These hashes were **recomputed from real repository files on 2026-11-04**. Preserve captures unchanged. Times in filenames are UTC. Full path for entries with prefix SME105 is captures/SME105_97AB/<filename>.

| Test | File | SHA256 | Interpretation |
| --- | --- | --- | --- |
| First in-car STATUS | 20261103T201945743134Z-usb-bridge.txt | 1f4fdda346daf11ff6dd8d0c4821d33bcc78d43e1c0b3e331d057545d296d93a | Identity/idle/DE LOW, no ECU decode |
| Passive LISTEN timed out | 20261103T201957425082Z-usb-bridge.txt | 0592e8428f837dcaf76f32ed81818cbe2e2da63f1eab5e71cd3cd68d499a3fe9 | 0 RO, END only later after STOP |
| Local TX2 4/4 | 20261103T202228623749Z-usb-bridge.txt | 91b3b3a5bf438fb1ef81ce1d0a5312313e8adb7f1d20aeb25cc6c89902137af0 | Only local GPIO17 PAD/RMT |
| In-car OBSERVE incomplete text | 20261103T202539537314Z-usb-bridge.txt | 2bf0b3c7424acf3aac7e76f775e777d87997580fb15212fe96080ab75535ae31 | 95B with missing END |
| In-car OBSERVE 95B raw | 20261103T202539537314Z-usb-bridge.bin | bff16967d05e4385b70f12ae1dbc435f9d95918b9840c9bb68b450ea9eb6f6c1 | Bytes only, no ECU provenance |
| Passive RO 30B text | 20261103T202934803038Z-usb-bridge.txt | 30ac17e4e0dbab10a598921da4c68f367a819d748dcc36a307621199dcf6989b | END reason15 ro_bytes30 no errors |
| Passive RO 30B raw | 20261103T202934803038Z-usb-bridge.bin | 1666f4af534f8e84f83a90d54602b8c2d34f2e75edbf8ba78654b8be8955853f | Bytes only, no ECU provenance |
| Older full ID-only capture | captures/CART_ONCE/20261102T150417765534Z.txt | 857c83e98fa6197c089ba0599c449b90513f06dbc9ce5601b97d9d862a7b213c | 3984B, no DTC, truncated tail |
| Old firmware crash | captures/TIMED_CART/20261102T181943265142Z-cart-isr.txt | 7d52258ea15b0476f45939d19552b91dc443912d7822fe261bef96c15087eec8 | StoreProhibited, not ECU refusal |

Other relevant traces in captures/SME105_97AB/ include 20261103T202623567285Z-usb-bridge.txt (follow-up fault17), 20261103T203852559004Z-usb-bridge.{txt,bin} (empty, device unreachable), 20261103T210557555456Z-usb-bridge.txt (later STATUS timeout), 20261103T163230191091Z-raw-a4.{txt,bin} (earlier PAD-negative), and 20261103T184824470614Z-tx2-pad-bench-usb.txt / 20261103T191103502112Z-tx2-rmt-usb.txt (older physical bench). Review the originals, not only descriptions.

Reason enum in current bridge: 15=HOST_STOP (intentional), 16=CAPTURE_TIMEOUT, 17=TRANSPORT_BACKPRESSURE. Fault17 in the 95B session resulted from v5 fan-out buffer accounting; it is **not proof of a dropped Wi-Fi association**.

## 6. OTA trust, versions, partitions and private artifacts

- **Last real installed result:** v7 VALID on app0, with prior v5 VALID. The v6 standalone package was **never uploaded**. Its TCP fan-out fix is included in the v7 source/binary.
- P-256 firmware publisher public SPKI SHA256: 4f3bb05f5a94fe931bce67f91057ab17e3d5ea4734dc066a722f47c27e682e79. Pinned verification public key is compiled into firmware, not a secret.
- **Private:** ~/.config/sme105/ota-signing-key.pem, ~/.config/sme105/bridge-token, NVS/flash backup contents, saved Wi-Fi password. Never print, attach, store in logs, commit or quote any private data. Base64 provisioning is NOT encryption.
- Signed v7: image ~/.config/sme105/firmware-v7-wifi-recovery-20261103.bin and signed .json; SHA256 48d85990460f4d416508f0bfc85b06f212385e11d121be7c2056656ed980a384; 833712 bytes; mode 0600.
- Signed v6 frozen: image ~/.config/sme105/firmware-v6-car-fanout-20261103.bin and signed .json; SHA256 9c5a53ff052c0e91943c3dae9e228e795f089c6cbf1292c0b2d72c605713ca73; 831152 bytes; **not installed**.
- OTA partition table for original 4 MB hardware: NVS at 0x9000/0x5000; otadata 0xe000/0x2000; app0 0x10000/0x140000; app1 0x150000/0x140000. Do **not** blindly use these addresses on another ESP32 without inspecting its real partition table.
- USB maintenance of v7 wrote ONLY the application at actual known active app0, after taking private backups; this **does not equal** a signed network OTA handshake or secure boot proof. Never issue ordinary multi-image PlatformIO USB upload, erase-flash or an unrequested partition rewrite against this now-provisioned board.
- Future OTA must use new, strictly higher signed version (>7 if accepted_version still 7); first verify ECU **physically isolated**, no vehicle session, exact board and identity, app valid, stage idle, DE LOW, fault 0 and strong stable LAN. Authenticated OTA_BEGIN2 with signature, 8192-byte window ACKs, final OTA_OK, PENDING_VERIFY followed by exact OTA_CONFIRM, then VALID. Missing final ACK must not trigger resend/replay. See scripts/sme105_wifi_ota.py for detailed recovery contract.
- An unfinished independent USB flash readback near 31% **must remain labeled not completed**. Do not undo working v7 or overwrite frozen images just to hide the gap.

## 7. Next car visit: authorized read-only diagnostic plan

**First aim: find why the bridge left Wi-Fi in the car and whether v7 now auto-recovers. Avoid ECU TX entirely.**

### Phase A — physical preflight

1. Ask operator to confirm **current**, not historical, state of ECU connections, ignition, vehicle battery and power source. Visual LEDs are not proof of firmware running; USB power near laptop differed from in-car power.
2. Check 5V/3.3V supply under expected electrical/temperature/vibration conditions, ground continuity, safe polarity, GPIO18 pulldown, A/B protection and correct interface isolation. Do not assume a 5–10m distance and one wall guarantee 2.4GHz reachability. Investigate metal shielding, channel interference, AP power and antenna orientation.
3. Establish router 2.4GHz SSID and local laptop network, DHCP clients and association table. Never guess that 192.168.1.10 is still the IP. Match hardware MAC and device identity/authentication if reachable. Do not change router isolation/security without explicit permission.

### Phase B — Wi-Fi status first

With current owner permission to issue *read-only* device commands:
1. Authenticate to the verified IP on TCP/8765. Query **STATUS**: exact firmware identity, stage0, DE LOW, auto_tx0, fault0, armed NONE. Query **OTA_STATUS**: accepted_version7 VALID (or report actual current value). Query **WIFI_STATUS**, **WIFI_DIAG**.
2. Save before/after values: disconnects, last_reason numeric, got_ip, reconnects, reinitializations, listener_failures, listener_restarts, listener, mdns, offline_ms, rssi. Counters reset on MCU boot — zero after reboot does NOT mean no previous failure.
3. If Wi-Fi loses connection, **do not immediately reboot it**. Observe supply/LED and router association/DHCP, TCP port and ARP/mDNS; allow 10s retry and 60s STA reinitialization intervals and preserve timestamps. Once it returns, query WIFI_DIAG to distinguish AP/auth/beacon failure from service/DHCP failure. If not, look at safe serial boot/brownout logs where feasible before considering a power reset.
4. No uncontrolled AP shutdown or deliberate router interference unless operator separately approves a safe experiment. Avoid background agents automatically retrying connection with vehicle-impacting commands.
5. Classify a candidate as **NETWORK GO** only after stable in-car running plus genuine observed loss/recovery, restored authenticated TCP after DHCP and no unexpected reset or power anomaly. Running near laptop is insufficient.

### Phase C — optional passive RO capture

A finite LISTEN_9600 then STOP can observe existing 9600 UART1 signals without sending a handshake to ECU, **but it is still an active session-start command on the bridge** and requires owner approval and safe electrical checks. Require full END with matching raw RX count, ro_lost=0, uart_errors=0, DE LOW and immutable transcript SHA256. Any missing END or UART error means incomplete. Even a complete frame pattern is only a **candidate CART signal**, not proof of ECU origin or DTC.

**Do NOT** send OBSERVE, HELLO at host CLI, TX2_BENCH, ARM_A4, READ_A4, ARM_0E, READ_0E, RESET_IDLE, clear codes, KOEO/KOER tests, or OTA as part of the default first car test. Previous active OBSERVE attempt was consumed on v5; reboot and v7 install do **not** imply fresh consent.

### Phase D — future full ECU/DTC readiness gate

Only with new explicit authorization after source validation: independent electrical A/B waveform, pinout and supply protection, correct synchronized UART slot timing and safe DE turnaround, ECU-specific identification and B 26A4 vs 260E ambiguity resolution, verified request-response with status/data words and raw trace. No project evidence yet proves actual diagnostic codes. No arbitrary memory writes, erase/clear codes or actuator tests.

## 8. Commands for a future agent (not an execution request)

Offline repository-only verification:

    cd '/media/maxim/MAX/Docs/Maxim Docs/Maximizo/escort scanning'
    git status --short
    git log -6 --oneline
    PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests -q
    ./.venv/bin/python -m ruff check scripts/sme105_usb_bridge.py scripts/sme105_wifi_setup.py scripts/sme105_wifi_ota.py tests/test_sme105_bridge_fanout.py tests/test_sme105_wifi_recovery.py
    ./.venv/bin/python -m platformio run -d firmware/sme105_usb_bridge

**Only after authorization for authenticated READ-ONLY status and confirmed live IP:**

    PYTHONPATH=src ./.venv/bin/python scripts/sme105_usb_bridge.py --host <VERIFIED_IP> --command STATUS

CRITICAL: The host CLI option --command HELLO actually issues the **active OBSERVE** sequence after a confirmation. It is NOT an identity-only network check. The on-wire HELLO command in the firmware is harmless, but the host mapping is different. Likewise, USB-only WIFI_TOKEN outputs the secret and must not be included in routine diagnostics.

## 9. Open investigations for new agent

1. Real in-car RF-loss versus unstable power; get contemporaneous WIFI_DIAG reason and router association, power traces, ESP reset reason. A lit LED cannot rule out reboot loops.
2. Reconnection after loss: retry 10s, STA reinitialization 60s, listener bind/retry and mDNS restart. New v7 code passed offline tests but **not** a controlled coverage-loss field test.
3. Host mDNS reachability: firmware reported mdns=1 near laptop, while a previous external multicast probe got no matching reply. Do not claim mDNS proved externally.
4. USB serial garbled startup vs actual firmware messages; independent postflash readback stalled 31% while write-hash and authenticated live boot proved v7.
5. Differential MAX487 A/B physical provenance and automotive transient/pinout safety, not simply local pad waveform.
6. Competing third diagnostic word candidates and 4/14-slot difference. No active reads until verified and permitted.
7. Remote status: commits were local and no push in this session; inspect git remotes/stale docs before publishing. Leave unrelated dirty workspace untouched.

## 10. Rules for the next AI Agent and report template

First read **this file**, firmware/sme105_usb_bridge/README.md, both November 3 reports, historical 2026-11-02 readiness/crash/timed-DTC reports, current .ino/scripts/tests and raw capture files. Check git status, branch and current HEAD; never infer a later upload or new in-car connection from history.

For each new test record: date/time, operator approval, physical position, supply/ignition state, ECU connection/isolation, firmware/partition/boot health, STATUS flags/DE, Wi-Fi IP/MAC/RSSI/disconnect reason/retry counters, ordered commands, exact captured raw bytes/END/error counters, SHA256, outcome PASS/FAIL/INCOMPLETE/UNVERIFIED and safe next action. Do not print secrets.

Maintain three explicit categories: **confirmed on device**, **confirmed only by code/tests**, **still unknown**. Preserve conflicting evidence and failure cases rather than rewriting history. If new evidence disagrees with this handoff, correct it with dated links and raw sources, not assumptions.
