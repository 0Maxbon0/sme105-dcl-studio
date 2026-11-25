# GitHub / LinkedIn publication checklist

**Purpose:** make the source understandable and responsibly shareable
without implying finished commercial scanner hardware or uploading
secrets, vehicle-specific private data, or debug release binaries.

## What can be presented accurately

- Independent Ford EEC-IV DCL research, focused on the Escort 1998
  1.6 Zetec-E / SME-105 PCM.
- Working Android/ESP32 source architecture and **reported isolated
  direct-link bench demonstration**.
- Wi-Fi SoftAP connection handling, heartbeat/recovery, bounded
  telemetry replay, durable evidence archives and testability.
- A carefully labeled **R1 PCB engineering design review**.
- Exact host test counts and date, with distinct physical validation
  limitations.

Avoid statements like **"Ford-verified," "production-ready OBD2
scanner," "ECU actuator control tested," "PCB ready to manufacture,"
"all sensors mapped,"** or **"live data never drops"**. These claims
are not supported by source tests or a passing KiCad DRC.

## Pre-push review

1. **Confirm git baseline:** `git status --short --branch`,
   `git log -5 --oneline` and `git diff --check`. The local
   `main` has changes not yet on GitHub: do not overwrite it by
   resetting/rebasing to an older remote commit.
2. **Review additions manually:** `git diff --cached --stat` and
   `git diff --cached`. Use a restrictive `git add` path list,
   never indiscriminate `git add -A` on a working directory
   containing experiments or private evidence.
3. **Keep these out of public commits:** APKs, firmware binaries,
   bootloader/NVS images, keys, Wi-Fi passwords/derived auth,
   Android credentials/backup databases, raw recordings with
   identifying material, private logs, and vendor PDFs copied into
   the PCB workspace.
4. **Review media:** screenshots must omit live secrets,
   personal/vehicle identifiers, and misleading live ECU values.
   Label historical or synthetic UI previews clearly.
5. **Hardware review:** keep R0/R1 KiCad **source** separate from
   transient design snapshots, route logs, KiCad `.kicad_prl`
   files, ZIP exports and provisional BOM procurement assumptions.
   Never present R1 as a fabricated unit.
6. **Licenses and third-party assets:** no repository-wide
   open-source license is currently granted. Do not call it
   "open-source" until the owner selects one and reviews bundled
   code/footprints/fonts/screenshots for applicable licenses.
7. **Cross-links:** verify all README links, actual app/firmware
   versions, CI badges, images and branch names from a clean
   checkout. Host CI and local hardware acceptance are separate.
8. **Push only after explicit publication review.** A public
   GitHub push can reveal content irreversibly through history,
   forks and caches. This documentation update does not authorize
   pushing anything to `origin/main`.

## Suggested GitHub presentation

Pin or share the repository with:

- A one-paragraph problem/solution statement at the top of README.
- Two clear labeled application screenshots (historical where relevant).
- A short architecture diagram and a prominent **experimental** disclaimer.
- Links to [engineering brief](ENGINEERING_BRIEF.md),
  [hardware](HARDWARE_GUIDE.md),
  [code walkthrough](CODE_WALKTHROUGH.md),
  [developer setup](DEVELOPER_SETUP.md), and [verification](../README.md).
- A public project license **only after deliberate ownership review**.

## Release separation

| Category | Publication handling |
| --- | --- |
| Android/firmware source | Review, test and publish as source only |
| Readme, code explanation and photos | Publish after correctness/privacy audit |
| Provisional KiCad R0/R1 source | Publish with review-only labels and footprint-license check |
| Debug APK / compiled `.bin` | Keep local; use a deliberate tagged release/distribution process if ever approved |
| DCL capture archives / private log bundles | Stay private; publish only deliberately redacted fixtures |
| On-vehicle validation claims | Require dated, repeatable physical evidence before being stated |

See [LINKEDIN_SHOWCASE.md](LINKEDIN_SHOWCASE.md) for draft post copy.
