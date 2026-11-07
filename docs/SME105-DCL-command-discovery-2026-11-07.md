# SME-105 DCL command discovery catalogue — 2026-11-07

## Scope and target

Target under investigation: 1998 Ford Escort 1.6 Zetec-E, EEC-IV KALE SME-105,
engineering identity `97AB-12A650-KA`, using the existing ESP32 + MAX487 DCL
bridge and Android application.

This is a reverse-engineering candidate catalogue, **not** a Ford-published
SME-105 command specification. There is no verified universal `IDENTIFY ALL`
or `DISCOVER ALL` command in the references reviewed. The closest map queries
are `005E` (PID map) and `242E` (DMR map). Third-party EEC-IV projects disagree
on some command words. No command below is considered ECU-supported until a
real SME-105 response is captured and its direction, framing, parity, and
semantic meaning are independently established.

## External source evidence

1. [`doncreat0r/eeciv` — `tables.h`](https://github.com/doncreat0r/eeciv/blob/master/tables.h)
   contains an A–R command table and PID/DMR map definitions. Its comments are
   experimental reverse-engineering labels, not an OEM guarantee.
2. [`doncreat0r/eeciv` — `Diag324.c`](https://github.com/doncreat0r/eeciv/blob/master/Diag324.c)
   contains the scanner's command sequencing and map-loading logic. In
   particular, PID/DMR map-load commands have payload/continuation behavior;
   they are not equivalent to a one-word read request.
3. [`flxkrmr/eec-iv-reader-arduino` — `EecIv.cpp`](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp)
   uses alternative stored-code and KOEO words and clears DCL errors before
   some reads. Its README explicitly calls the project work-in-progress and
   not completely working; its development wiki says DCL is not publicly
   documented and that the author first tested against a separate cheap EEC-IV
   ECU. These differences are retained as lower-confidence candidates, not
   SME-105 facts.
4. [`babroval/ford-eec-iv-diagnostic` — `DCL_communication_map.pdf`](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/DCL_communication_map.pdf)
   is an additional reverse-engineered DCL reference. Its existence does not
   establish compatibility with this particular ECU.

## Request envelope used by this bridge

The new fixed read candidates use the existing four-word CART request envelope:

`01B0 FF5F <candidate-word> 00A0`

The command word's vertical parity is checked at compile time. The firmware
sends one command word, captures raw RO data for the bounded 10-second window,
and does not automatically retry or scan other opcodes. The capture is not
interpreted as ECU acceptance: RO may include local self-echo.

## A–R command map from `doncreat0r/eeciv/tables.h`

| Letter | Word | Source label | Current disposition |
|---|---:|---|---|
| A | `0381` | Get ECU status | **Enabled** as `READ_ECU_STATUS` single-shot candidate |
| B | `260E` | Read stored trouble codes | Existing `READ_0E` candidate |
| C | `0291` | Clear trouble codes | Existing `READ_CLR`; state-changing, not part of discovery |
| D | `253E` | Run KOEO/KOER self-test | Existing `READ_KOEO` / `READ_KOER`; controlled test, not passive read |
| E | `4196` | Transmit/load PID map | Already used by LIVE profiles; not a standalone discovery read |
| F | `005E` | Read PID map | **Enabled** as `READ_PIDMAP` single-shot candidate; published literal has an unresolved parity mismatch, not a verified exception |
| G | `21F6` | Read PID values | Already used by LIVE profiles |
| H | `01A1` | Clear DCL error/flag register | **Deferred**; state-clearing |
| I | `42A6` | Transmit/load DMR map | **Deferred**; map-load payload and target compatibility unverified |
| J | `242E` | Read DMR map | **Enabled** as `READ_DMRMAP` single-shot candidate |
| K | `22C6` | Read DMR values | **Enabled** as `READ_DMR` single-shot candidate |
| L | `271E` | Read PID and DMR values | **Enabled** as `READ_BOTH` single-shot candidate |
| M | `8174` | Switch baud rate | **Deferred**; risks communication desynchronization and has no verified recovery sequence |
| N/O/P | — | No command listed in this source table | No candidate inferred |
| Q | `411E` | Zero/stop PID-value flow | **Deferred**; sequence-dependent state control |
| R | `FF5F` | Idle block | Already word 2 of our fixed envelope; not a standalone query |

The source does not clearly expand the acronym **DMR**. The application
therefore preserves the source's label and does not guess what the acronym
means. The same source's default `PIDMap` is a 64-slot (16 × 4) FDS/WDS v4
map with repeated groups and additional transmission/memory-related IDs;
`PIDMapT` is a separate test map extending through IDs `0x6A`. These are
reference maps, not proof that SME-105 supports every listed PID. Its `DMRMap`
contains address entries `0x10`–`0x4F` with zero second bytes, so it is not a
validated sensor-name map.

The reference scanner can select and transmit F; its generic receive path can
also collect parity-valid response slots. However, the dedicated `f`
response-state handler is commented out, and no separate `j` or `l` handlers
appear in that switch. This means the source does not provide a complete
command-specific decoded response implementation for F/J/L. Our app therefore
captures raw response bytes and does not claim a successful semantic decode.

**Important `005E` parity discrepancy:** the generic `VPARITY(00,0E)`
calculation produces `004E`, while `doncreat0r/eeciv/tables.h` stores the PID-map
read literal as `005E`. This is an unresolved source-table mismatch, **not a
verified protocol exception**. The firmware preserves `005E` as the published
candidate, but a GPIO pad witness can prove only emission, not ECU acceptance.
See the follow-up audit below; do not silently substitute or automatically try
`004E`.

## Conflicting commands from `flxkrmr/eec-iv-reader-arduino`

| Word | Source label | Current disposition |
|---|---|---|
| `26A4` | Stored-code read | Existing `READ_A4` candidate; separate from `260E` |
| `2594` | KOEO request | Deferred controlled self-test candidate; not interchangeable with `253E` without a separate test |
| `01F4` | Clear DCL errors/flags | Deferred state-clearing command |
| `4196` | Load PID map | Already used by LIVE profiles |
| `21F6` | Read PID values | Already used by LIVE profiles |

Do not automatically fall back from `260E` to `26A4`, or from `253E` to
`2594`, after a no-response result. Each variant is an independent experiment.

## Existing local bridge profiles

| Host profile | Fixed DCL words / behavior | Notes |
|---|---|---|
| `READ_A4` | `01B0 FF5F 26A4 00A0` | Stored-code candidate |
| `READ_0E` | `01B0 FF5F 260E 00A0` | Stored-code candidate |
| `READ_KOEO`, `READ_KOER` | `01B0 FF5F 253E 00A0` | Self-test; not passive |
| `READ_CLR` | `01B0 FF5F 0291 00A0` | DTC clear; now single-shot, then capture |
| `READ_LIVE*`, `READ_ALL` | `4196` map-load sequence then `21F6` PID values | Existing live-data map/profile behavior |
| `ARM_MEM` / `READ_MEM` | Local candidate `42F3` / `22D3` | **Deferred / not-sendable**; target address map is unverified and `22D3` parity byte `93` differs from generic result `2293`. |
| `READ_OFF` | `80CE` with `7F20` qualifier | Existing go-offline candidate |

## Deferred / not-sendable commands

These are recorded so the research does not lose them, but they are not
exposed as active send buttons in the discovery UI. The firmware HELP lists
the corresponding deferred host names and returns
`DENIED command_deferred_not_sendable` if one is submitted:

- `004E`: parity-derived alternative to the published `005E`; no external source identifies it as a PID-map command, so it remains explicitly denied.
- `01A1`, `01F4`: clear DCL error/flag state.
- `0291`: clear DTCs; already available as the explicit `CLR` action, not a read.
- `8174`: change baud rate; no validated return-to-9600/recovery sequence.
- `42A6`: transmit/load DMR map; the source's map payload is not validated for SME-105.
- `411E`: stop PID-value flow; requires a verified live-mode sequence.
- `2594`: alternate KOEO self-test; keep separate from the current `253E` test.
- `ARM_MEM` / `READ_MEM`: memory candidate `42F3` / `22D3`; the target address map and sequence are unverified, and parity byte `93` differs from generic result `2293`. Firmware denies both before DPS transmission.
- `FF5F` and `00A0`: envelope idle/trailer words, not standalone discovery commands.

No arbitrary hex entry, all-byte sweep, or brute-force opcode scan is provided.
Unknown commands can change ECU diagnostic state, clear information, change
communication mode, or enter tests; an assumption that every unknown request
can only clear DTCs is not valid.

## Application and firmware behavior

The Android/PWA app offers the five fixed read candidates: `0381`, `005E`,
`242E`, `22C6`, `271E`. It records the selected command, source and target
uncertainty, bridge capture verdict, raw RO byte count, and raw transcript in
the append-only diagnostic journal. It shows raw response evidence without
assigning a sensor name or claiming ECU ownership. The full diagnostic ZIP
retains the raw DCL records.

The firmware accepts only the named `ARM_*` / `READ_*` variants and checks the
exact four TX words through the existing local GPIO17 pad witness. New probes
are single-shot; no repeated DCL request is issued. The existing DTC-clear
profile was corrected to be single-shot as well; its 4-second window is for
capturing the response, not repeating `0291`.

## Test and deployment boundary

The changes in this workstream are source-only. No car command was transmitted,
no firmware was flashed, no Android APK was installed, and no commit/push was
performed. A passing software test proves only the application/firmware model
and expected request words, not that the target ECU accepts any candidate.

## PID dictionary candidates and naming disagreements

The `flxkrmr/eec-iv-reader-arduino` [PIDs wiki](https://github-wiki-see.page/m/flxkrmr/eec-iv-reader-arduino/wiki/PIDs)
(last modified 2023-04-02) publishes candidate identifiers and scaling for
many common EEC-IV channels. It overlaps substantially with our current
39-channel `live_all_map.h`, but several labels differ. These are **cross-check
candidates**, not authority to relabel decoded data before the target's map
and raw values are observed.

| PID | Current local app label | External wiki label / note | Status |
|---:|---|---|---|
| `01` | N | N / engine RPM | Agreement |
| `02` | MAP | MAP | Agreement |
| `03` | BP | BP | Agreement |
| `04` | SAFTOT | SAFTOT | Agreement |
| `05` | IACT | IACT | Agreement |
| `06` | IECT | IECT | Agreement |
| `07` | IEGR | IEGR | Agreement |
| `08` | IEGO1 | IEGO1 | Agreement |
| `09` | ITP | ITP | Agreement |
| `0B` | IVCAL | IVCAL | Agreement |
| `0C` | FUELPW1 | FUELPW1 | Agreement |
| `0D` | LAMBSE1 | LAMBSE1 | Agreement |
| `0E` | APT | APT | Agreement |
| `0F` | ACT | ACT | Agreement |
| `10` | ECT | ECT | Agreement |
| `11` | VBAT | VBAT | Agreement |
| `12` | MAP_FREQ | MAP_FREQ | Agreement |
| `13` | EGRDC | EGRDC | Agreement |
| `15` | ISCDTY | ISCDTY | Agreement |
| `17` | VSBAR | VSBAR | Agreement |
| `18` | VS | VS | Agreement |
| `1A` | BITMAP_0 | BITMAP_0 | Agreement |
| `1B` | BITMAP_1 | BITMAP_1 | Agreement |
| `24` | FMEM_FLAGS | Not listed in wiki | Local-only candidate |
| `25` | FMEM_FLAG2 | Not listed in wiki | Local-only candidate |
| `26` | MAF | Air Flow Meter | Same general signal; label differs |
| `27` | LOAD | LOAD | Agreement |
| `28` | KAMRF1 | KAMRF1 | Agreement |
| `29` | Unknown/unused in local decoder | Unspecified value range 13–16 | Unresolved |
| `2A` | DSDRPM | Desired RPM | Likely related; exact scaling/meaning needs proof |
| `2B` | RATCH | Lowest filtered throttle position | Name agrees; description differs |
| `2C` | Unknown/unused in local decoder | Unspecified; note says 2048 off and a falling/rising pattern | Unresolved |
| `2D` | ATMR1 | Time since startup in seconds | Meaning/scaling conflict |
| `2E` | IOCC | OCC | Meaning/name conflict |
| `2F` | INDS | Neutral/Drive input | Meaning/scaling conflict |
| `30` | BCSDC | Converter clutch | Meaning/name conflict |
| `32` | GR_CM | Command gear | Likely related; exact mapping unverified |
| `35` | ETVOCM | ETV monitor voltage | Similar label; scaling unverified |
| `36` | TV_PRES | EPC pressure | Meaning/name conflict |
| `37` | ITOT | Transmission oil temperature | Meaning/name conflict |
| `38` | PDL | PRNDL position | Likely related; automatic-transmission applicability |

The local decoder already marks `BCSDC`, `GR_CM`, `ETVOCM`, `TV_PRES`, `ITOT`
and `PDL` as automatic-transmission-only for our manual gearbox. The external
wiki's descriptions for the corresponding PIDs also point toward transmission
functions, but the exact register names differ. Do not change the existing
manual-transmission filtering or PID scaling based only on the wiki.

## Factory scan-tool routines are not raw DCL opcodes

The SPX 9640 Professional manual documents two EEC-IV routines that are
important to the larger capability question, but it does **not** provide a
raw DCL command word for either routine:

- **Output Switch Test / Output State Check:** tests PCM-controlled relays and
  solenoids. The manual explicitly says fuel injectors are **not energized**
  during this test. The sequence warms the engine, turns ignition off, waits
  10 seconds, then enters key-on/engine-off; the scan tool prompts the operator
  to fully depress/release the throttle to toggle the relays/solenoids. The
  manual warns the cooling fan may turn on. This is a scan-tool-managed
  diagnostic procedure, not evidence for a direct IAC/injector opcode.
- **Cylinder Balance Test:** only applicable to EEC-IV SEFI/SFI engines. With
  the engine running, the PCM shuts off fuel to each cylinder in turn and
  measures RPM drop. The scan tool waits for a Cylinder ID, begins a KOER
  self-test, and prompts the operator through the test. The manual requires
  parking brake, neutral/park, A/C off, a ventilated area, and warns not to
  over-rev or approach moving engine parts. This is a guided diagnostic
  routine, not a free-form injector command.

Sources: [SPX 9640 manual, Output Switch Test and Cylinder Balance Test,
pp. 6–10 to 6–12](https://device.report/m/485b125f9ed0d13eb1c774b5f48ae83c0510a25fdf486f5c8958a0cbcfa719de.pdf).

We have not identified the exact DCL sub-sequence for either factory routine
on SME-105. Do not improvise a raw command or run Cylinder Balance as a
substitute for an unverified DCL probe. The five new discovery probes are
read-only candidates and should be tested first with ignition on, engine off,
vehicle stationary.

## Follow-up audit: `005E` test status and protocol structure — 2026-11-07

### Result: no ECU test of `005E` or `004E` is evidenced

The distinction is now explicit:

- **Offline parity test: performed.** The local `parity_byte()` implementation
  was run against all 15 non-empty A–R words. Fourteen match the published
  second byte; `005E` is the sole mismatch and calculates to `004E`. The three
  `flxkrmr` alternatives `26A4`, `2594`, and `01F4` all pass the same formula.
- **Reference-source inspection: performed.** `tables.h` stores `005E`
  literally. `Diag324.c` copies the selected `cmdData` word into the command
  buffer unchanged. `RecalcCmdBufVP()` recalculates subsequent map payload
  words, not the command word at offsets 0–1. The `f` response-state handler is
  commented out, so the source does not demonstrate a decoded PID-map response.
- **Vehicle transmission: not performed / not evidenced.** The recovered
  phone recording `diagnostic-run-17004e46-recovered/raw.txt` is an earlier
  `ALL` run. Its TX witness shows `01B0 FF5F 4196 00A0`, not `005E` or `004E`,
  and its END record says `ecu_verified=0`. The `TX2_BENCH` `26A4` witness in
  that recording explicitly has `external_bus_disabled=1`, so it is a local
  pad test, not a car command. No `READ_PIDMAP`/`ARM_PIDMAP` event or TX witness
  was found in the recovered phone evidence.
- **Current connection snapshot: unavailable for a live attempt.** At review
  time there was no `/dev/ttyUSB*` or `/dev/ttyACM*`, no ADB device, and the
  paired `SME105-DCL` BLE device reported `Connected: no`. No ECU command was
  sent in this review.

The raw stream contains repeated `RXB ... data=0000004E` words. These occur in
the received CART frame-ID/status position (frame ID `0xE` with valid vertical
parity); they are **not** evidence that the two-byte diagnostic command `00 4E`
was transmitted. The independent `babroval` communication-map PDF likewise
shows `00 4E` in the recurring frame-ID rows, while its DATA sequence uses
`41 96` followed by `21 F6`; it does not list `00 5E` as a command.

**Current conclusion:** `005E` has not been shown to work on the SME-105. The
most defensible classification is *published but unverified literal with a
likely table-entry error or an undocumented exception*. The disabled `f`
response handler and lack of corroboration make “known-good exception” an
unsupported claim. Keep `005E` and parity-derived `004E` as separate hypotheses;
do not auto-fallback. A live `005E` attempt remains pending a connected bridge
and confirmation that the vehicle is stationary with ignition ON and engine
OFF. Only one candidate should be sent per separately armed session.

The source-only statement in the earlier test-boundary section applies to the
new discovery-probe work in this change set. It does not erase earlier evidence
from existing profiles: the recovered `ALL` session did send `4196` with a
local pad witness, but did not verify ECU acceptance.

See [`SME105-DCL-protocol-structure-analysis-2026-11-07.md`](SME105-DCL-protocol-structure-analysis-2026-11-07.md)
for the full A–R structural analysis and cross-reference comparison.
