# Android 1.8.9 adjustable dashboard

The dashboard now offers Large, Small, Dense and List views and an independent
Auto / 1 / 2 / 3 / 4 column selector. Auto adapts to available width. List keeps
one column while retaining the previous column preference for the next card view.
Both preferences are local, reversible, persistent and independent of pin order.
Existing Cards/List preferences and saved layouts remain compatible.

Expand dashboard hides the surrounding Live panels and condenses the header.
The existing Stop control, connection status, navigation, ignition alert and
recorded/live source context remain available. Exit expanded view restores the
panels; leaving the Live screen also exits it. Expanded state is not forced after
restart. Cards retain details/charts, pin controls and the dedicated Arrange drag
handles; swiping card bodies continues to scroll.

For eight readings, Small cards with two columns is a starting point. For twelve,
try Dense cards with three columns and Expand dashboard. The exact number visible
depends on viewport, text settings and measurement labels. No fixed 8/12-card limit,
forced density, fake readings or forced landscape orientation is introduced.
Android Auto-rotate continues to control rotation. Auto layout uses more columns
when wider space is available.

The adjustable grid pattern was checked against the published Home Assistant
reference: https://www.home-assistant.io/dashboards/cards/

Validation: 129 Node tests passed, including 12 pinned cards, all size choices,
column persistence, a fresh app boot, legacy preference compatibility, expanded
panel visibility/source labelling, global safety control placement and existing
playback/Arrange/lifecycle regressions. Python: 273 run, 264 passed, 9 skips for
older unavailable private captures. Gradle testDebugUnitTest, lintDebug and
assembleDebug passed. Native JUnit tasks are NO-SOURCE. App lint retains 19 warnings
and zero errors. All 37 runtime assets in the APK match source; all 156 archived
evidence files are unchanged. git diff --check passed.

APK: artifacts/android/sme105-dcl-studio-1.8.9-debug.apk (versionCode 11).

SHA-256: 49d1d5c25655fb2045c961ee15eac7c555d4513381cb8ff5b60fd562b1d5c30b

Debug signing certificate matches 1.8.8. This build is not installed. No phone
access, firmware change/flash, ECU command, data migration, evidence change or push
was performed. Actual Samsung visual/rotation validation remains for an authorized
installation. Automated DOM/CSS checks do not establish physical vehicle behavior.
