# Android 1.8.7 dashboard and offline review

Validated on 2026-11-06 from branch `fix/live-rx-silence-evidence-20261105`.
Preflight HEAD was `e6e822f`; the working tree was clean. The approved 1.8.6
throttle appearance, integer percentage, separate raw card, Engine RPM label,
39 PID channels, raw conversions and existing lifecycle behavior are preserved.

## Changes

- The derived throttle display now uses the same persisted layouts, pin controls,
  pointer drag and keyboard ordering as other cards. Legacy layouts migrate once;
  explicit removal and empty layouts remain empty. LIVE3 has no throttle card
  because it does not request ITP. The derived display never becomes an ECU PID.
- Central UI formatting shows VS/VSBAR with exactly one decimal. Counts, RPM,
  ticks and throttle percentages remain integers. Other measurements use at most
  one decimal, except battery voltage, lambda and adaptive correction, where
  hundredths retain useful diagnostic resolution. Calculations, chart points,
  timestamps, CSV display precision, raw bytes and conversion formulas are unchanged.
- Playback clocks, selection metadata, sample freshness, chart axes and chart
  sample readouts use tenths of a second. Seeking and full-session indexing retain
  original precision and the bounded existing index/cache.
- Pending ignition confirmation is a global non-modal alert above navigation,
  outside every screen container. Later leaves a global Review reminder; resume
  and restart re-read durable state. An explicit decision updates the selected
  review metadata, recording list, append-only journal and warning history. Raw
  INCOMPLETE verdicts and captured FAULT/END events remain unchanged. No native
  notification permission or background notification implementation was added.
- BITMAP details show the original 12-bit word and all bits 0–11, including unknown
  assignments. Published low-byte masks 0x08 and 0x80 establish A/C selected at
  bit 3 and AM2 at bit 7. These are reference mappings, not proof for this ECU.
  Optional equipment is unverified; the automatic gearbox reference is identified
  as inapplicable to this manual vehicle. Neutral/park is not a clutch switch.
- FMEM details and the existing technical panel show the hexadecimal byte, all
  eight SET/CLEAR states and source sample timing. Any original upper source bits
  remain visible separately. Per-bit meanings remain unverified and are not DTCs.

Reference: https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/PIDs
The reference uses low-byte masks for bits 0–7 and high-byte masks for bits 8–11.
No CPP channel, gearbox sensor identity, electrical test or new ECU conversion
was introduced. Throttle 179/970 references are owner-defined relative travel,
not certified angular position or independently verified mechanical endpoints.

## Validation

- `SME105_EVIDENCE_DIR=<immutable November 6 archive> npm test`: **128 passed,
  zero failures/skips**. Includes actual app boot, persisted layout restoration,
  pin/remove, pointer and keyboard reordering, speed/chart formatting, playback,
  sparse/large recordings, global confirmation foreground/background/resume,
  delayed archive completion, Later, restart, single durable resolution, journal,
  warnings, raw fidelity and prior authorization/provenance/lifecycle regression.
- Archived original exports, four TPS comparison recordings and later 24-session
  manifest verified read-only. The affected recording replays 30,192 samples over
  exactly 242.280126 seconds, retains INCOMPLETE and pending confirmation, and
  displays speed maxima as 19.2 and 17.7. All **156 evidence files** match the
  preflight SHA-256 snapshot after release work. No private evidence is committed.
- `PYTHONPATH=src .../python -m unittest discover -s tests -v`: **273 run,
  264 passed, 9 skipped**, no failures. Skips require unavailable older private
  captures. Includes strict v24 parser, offline replay and firmware source checks.
  This project uses unittest; pytest is not installed in the established venv.
- `npm run android:sync`, then JDK 21 / established Android SDK:
  `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`: **successful**.
  Native app JUnit tasks have **NO-SOURCE**; no device instrumentation was run.
  Android app lint: **0 errors, 19 warnings**. Cordova plugin lint: **0 errors,
  3 warnings**. Existing Gradle flatDir repository warnings remain.
- `git diff --check` and JavaScript syntax checks passed.
- APK identity: `com.maximizotech.sme105dclstudio`, **1.8.7 / code 9**.
  Signature verified using APK v2; debug signer matches the prior 1.8.6 artifact.
  All **37 runtime source assets** in the packaged APK match current source bytes,
  including both new modules and their service-worker cache entries.

APK: `artifacts/android/sme105-dcl-studio-1.8.7-debug.apk`

SHA-256: `68a5b768542a56ce8284934ea6e437f2045dc608aa3989054d0c6328f6d92e57`

Signer certificate SHA-256:
`bf29b03fa7c5e7b4003a4df0fce71e4e1b6fe1ea81657542450a955722194505`

Machine-readable proof: `artifacts/android/sme105-dcl-studio-1.8.7-verification.json`.

## Files

Runtime: `app/index.html`, `app/styles.css`, `app/sw.js`, `app/js/app.js`,
`app/js/dashboard-layout.js`, `app/js/display-format.js`,
`app/js/bit-presentation.js`, `app/js/ignition-review.js`, `app/js/pids.js`,
`app/js/protocol.js`, `app/js/recording-review.js`, `app/js/review-controls.js`,
`app/js/ui.js`, `android/app/build.gradle`.

Tests: `app/tests/dashboard-layout.test.mjs`, `app/tests/display-format.test.mjs`,
`app/tests/bit-presentation.test.mjs`, `app/tests/ignition-notice.test.mjs`,
`app/tests/layout-restart.test.mjs`, `app/tests/dashboard-archive.test.mjs`,
`app/tests/review-boot.test.mjs`, `app/tests/review-ui.test.mjs`.

Delivery: this document, versioned APK and verification JSON.

## Limitations and safety

Browser security approval rejected the local visual preview because permission
was declined. No browser workaround was attempted. DOM integration tests passed;
phone-sized visual and actual Samsung WebView verification remain outstanding.

No phone access, extraction, installation, firmware change/flash, ECU commands,
code clearing, electrical action, K-Line/Pin7 change, push or deployment occurred.
No storage schema, recording bytes, historical timestamps or original verdicts
were rewritten. Signing continuity is established against the prior APK offline;
current installed-package verification is deferred to an explicitly authorized
installation task. Physical behavior, optional equipment and ECU-specific bit
meanings remain unverified; automated tests do not provide real-vehicle validation.
