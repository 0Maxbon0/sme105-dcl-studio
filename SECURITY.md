# Security policy

## Status

SME105 DCL Studio is **experimental**. The Android application and ESP32 v29 bridge are intended for owner-controlled, isolated bench engineering. This is not a production-safe vehicle diagnostic or an approved actuator-control system.

## Reporting vulnerabilities

Please **do not disclose potential vulnerabilities in public issues**. Use the repository's [GitHub Security Advisory private reporting](https://github.com/0Maxbon0/sme105-dcl-studio/security/advisories/new) if enabled, or contact the repository owner through a private channel. Include affected Android and firmware versions, reproduction steps that do not operate a vehicle, impact and recommended mitigations. Never paste PSKs, tokens, private NVS dumps, phone data or raw customer/vehicle records.

## Security invariants

- ESP32 SoftAP requires WPA2; the normal Android workflow uses a **single owner-entered Wi-Fi passphrase** and a derived session `AUTH`, not an unauthenticated TCP API.
- This is **one shared secret** across WPA2 and derived `AUTH`, **not two independent factors**. Keep the passphrase private, avoid weak/reused passphrases, and rotate it using a verified physical-USB procedure if compromised.
- Android private credentials are stored with Keystore-backed encryption; do not save passwords or authentication values to JavaScript `localStorage`, screenshots, Git, CI logs, release notes or application analytics.
- Vehicle commands remain protected by separate named-command allowlists and per-boot `TX2_BENCH` plus explicit arming and bounded execution. Network login alone does not qualify electrical safety.
- The USB-only rekey path must verify the correct physical device, safe idle stage and a valid NVS rollback plan. Never erase all NVS or bypass OTA signing to recover a password.
- Security updates must not destroy historical RAW evidence or existing Android IndexedDB data. The Android upgrade path is `adb install -r`, **never** `pm clear`/uninstall for routine updates.

## Scope and non-goals

A real ECU, vehicle actuators and unexpected engine behavior are **out of scope for security testing** unless the owner has separately approved a safe vehicle-specific test plan. Perform network/authorization negative tests on an isolated bench and avoid DTC clearing or output activation.
