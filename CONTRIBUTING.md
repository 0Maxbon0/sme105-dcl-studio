# Contributing to SME105 DCL Studio

This is an evidence-first experimental hardware/software project; the target EEC-IV SME105 ECU is not presumed to implement another Ford ECU's exact DCL commands.

## Before proposing changes

1. Read [README](README.md), [wiring safety](docs/wiring-safety.md), [protocol notes](docs/protocol-notes.md), [reference index](docs/REFERENCES.md) and [security policy](SECURITY.md).
2. State the exact vehicle/ECU revision and whether a claim is **Observed**, **Reference**, **Inferred** or **Unknown**. Never rename a hypothesis as a confirmed sensor or command.
3. Keep original RAW captures, event order, timestamps, hashes and Android IndexedDB handling unchanged. Supply a new derived dataset for interpretations.
4. Do not commit real Wi-Fi credentials, Bluetooth pairing secrets, authentication tokens, phone backups, NVS binaries, signed OTA private keys or identifiable vehicle data.
5. Never introduce arbitrary ECU TX, automatic DTC clear, unbounded retries, or bypasses of DE/PAD/TX2_BENCH/ARM safety gates.

## Local verification

```bash
npm ci
npm test
python -m pip install -e .
PYTHONPATH=src python -m unittest discover -s tests -q
```

For native release changes use JDK 21 and Android SDK:

```bash
npm run android:sync
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug --offline
```

For firmware work compile the **Wi-Fi** build:

```bash
python -m platformio run -d firmware/sme105_usb_bridge -e esp32dev
```

A software build or synthetic test does **not** count as vehicle or radio hardware acceptance. Keep physical bench and ECU validation results explicitly separate in a pull request.

## Public CI and private historical evidence

Some historical hardware assertions depend on captured RAW waveforms that are private or ignored by Git. The clean GitHub checkout runs synthetic decoder tests unconditionally and explicitly skips capture-dependent tests **only when those original files are unavailable**. Local researchers retaining the original files still run the complete real-capture regressions. Never upload sensitive recordings merely to make CI green.

## Pull requests

Explain the engineering goal, affected profiles and hardware, data migration/rollback impact, exact tests and their results, and any tests not performed. Prefer narrow changes with explicit expected outputs and no edits to old captured bytes. Do not assume public repository visibility supplies a license to redistribute or relicense third-party work.
