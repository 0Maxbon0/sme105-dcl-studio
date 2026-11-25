# EscortScope — product identity and release

**25 November 2026 · Android v2.1.0 (build 28) · ESP32 firmware v30**

EscortScope is an independent Ford Escort SME-105 / EEC-IV diagnostic research product made by Basita (بسيطة). Product-specific steel blue, a gauge icon and automotive layouts distinguish it from the company brand; original Basita typography, semantic colors, motion and sonic identity provide a consistent endorsement. The company identity is not replaced by the product and neither identity implies Ford affiliation.

## Design system

- Product palette: steel blue #203B50 and light diagnostic action #2C4F7B; official Basita Canvas/Ink backgrounds and Lagoon/Mineral selection accents. Shared Basita 8px control radius, 16px card radius, 48px touch targets and 4/8px spacing rhythm.
- Basita assets: pinned release 1.0.0-rc.3 / commit 0d39988; exact source and SHA-256 in [provenance](../app/brand/provenance.json). Font license files are retained.
- v2.1 layout: compact vehicle and connection panels, four direct data-set choices synchronized with the original select, earlier live readings, shorter navigation labels and shared component roles. Dataset selection keeps existing persistence and disabled-state behavior.
- Startup: genuine readiness gate for local storage, recovery and initial dashboard data. No artificial minimum duration; recovered capture Stop remains available without waiting for optional history.
- Header: original English Unravel motion, cropped and scaled for the header; four-second completed-logo hold, 7.63-second cycle, muted, offline, both themes. Reduced motion and background visibility pause playback.
- The original brand sound is available as an explicit preview; no automatic sound during diagnosis.
- The product and Basita artwork remain owner-controlled; source publication does not grant a general redistribution or trademark license.

## Compatibility

Android package ID `com.maximizotech.sme105dclstudio` and existing storage keys are intentionally unchanged. Install updates in place, not by uninstalling. New exports continue to use `Download/Escort SME-105 Diagnostic Lab`; existing exports in `Download/SME105 DCL Studio` are not moved or deleted. Protocol identifiers and stored credentials are unchanged.

## Verified release boundaries

Android 2.1.0 build 28 installed on Samsung Galaxy A52s; 135 saved recordings were visible after update. Browser motion tests passed startup gating, looping, both themes and reduced motion. The 2.1 redesign passed 48 screen checks across four widths and both actual theme settings; direct dataset selection was verified in browser and regression tests. JavaScript tests recorded 324 passes, 3 skips and no failures. Android debug assembly passed. See [firmware documentation](../firmware/sme105_usb_bridge/README.md) for v30 and the isolated BLE test. These are not vehicle qualification. Debug APKs and private field evidence stay local; publication of a distributable signed app is a separate step.

## Repository

The current remote is [sme105-dcl-studio](https://github.com/0Maxbon0/sme105-dcl-studio). The product name is independent of the repository slug; a rename can be handled separately without disrupting existing links.
