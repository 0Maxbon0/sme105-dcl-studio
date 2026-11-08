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

The fixed request candidates use the existing four-word CART request envelope:

`01B0 FF5F <candidate-word> 00A0`

The firmware pad-verifies every transmitted byte pair. Single-shot candidates
send one command word and capture raw RO data for a fixed bounded window:
10 seconds by default, 5 seconds for standalone `4196` PID-map transmission,
and 4 seconds for clear candidates. The KOEO self-test and MEM continuation
profiles use their own bounded repeating schedules. No profile automatically
retries another opcode or accepts arbitrary host-provided bytes. Capture is not
interpreted as ECU acceptance: RO may include local self-echo.

## A–R command map from `doncreat0r/eeciv/tables.h`

| Letter | Word | Source label | Current disposition |
|---|---:|---|---|
| A | `0381` | Get ECU status | **Enabled** as `READ_ECU_STATUS` single-shot candidate |
| B | `260E` | Read stored trouble codes | Existing `READ_0E` candidate |
| C | `0291` | Clear trouble codes | Existing `READ_CLR`; state-changing, not part of discovery |
| D | `253E` | Run KOEO/KOER self-test | Existing `READ_KOEO` / `READ_KOER`; controlled test, not passive read |
| E | `4196` | Transmit/load PID map | Used by LIVE profiles and enabled as standalone `READ_PIDMAP_TX` |
| F | `005E` | Read PID map | **Enabled** as `READ_PIDMAP` single-shot candidate; published literal has an unresolved parity mismatch, not a verified exception |
| G | `21F6` | Read PID values | Used by LIVE profiles and enabled as standalone `READ_PID_VALUES` |
| H | `01A1` | Clear DCL error/flag register | Enabled as `READ_CLEAR_A1`; fixed one-shot, state-changing candidate |
| I | `42A6` | Transmit/load DMR map | Enabled as `READ_DMRMAP_TX`; fixed one-shot candidate, payload/target compatibility unverified |
| J | `242E` | Read DMR map | **Enabled** as `READ_DMRMAP` single-shot candidate |
| K | `22C6` | Read DMR values | **Enabled** as `READ_DMR` single-shot candidate |
| L | `271E` | Read PID and DMR values | **Enabled** as `READ_BOTH` single-shot candidate |
| M | `8174` | Switch baud rate | Enabled as `READ_CHANGE_BAUD`; fixed one-shot mode-changing candidate, recovery is unverified |
| N/O/P | — | No command listed in this source table | No candidate inferred |
| Q | `411E` | Zero/stop PID-value flow | Enabled as `READ_STOP_PID_FLOW`; fixed one-shot flow-control candidate |
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
candidate and exposes `004E` as a separate command; it does not silently
substitute or automatically try it. A GPIO pad witness proves only emission,
not ECU acceptance. See the follow-up audit below.

## Conflicting commands from `flxkrmr/eec-iv-reader-arduino`

| Word | Source label | Current disposition |
|---|---|---|
| `26A4` | Stored-code read | Existing `READ_A4` candidate; separate from `260E` |
| `2594` | KOEO request | Enabled controlled self-test candidate; not interchangeable with `253E` without a separate test |
| `01F4` | Clear DCL errors/flags | Enabled one-shot state-clearing candidate |
| `4196` | Load PID map | Already used by LIVE profiles |
| `21F6` | Read PID values | Already used by LIVE profiles |

Do not automatically fall back from `260E` to `26A4`, or from `253E` to
`2594`, after a no-response result. Each variant is an independent experiment.

## Firmware request profiles and command map

Variant IDs 3–4 are unused by `CART_READ`; passive LISTEN and OBSERVE reuse
session-kind values in their separate `CART_PASSIVE` path. Every candidate
below has a fixed ARM/READ pair and exact command word. Each ARM expires after
15 seconds, and each vehicle transmission requires a 4/4 `TX2_BENCH` pass in
the current boot plus GPIO17 pad-witness validation.

| ID | ARM / READ | Exact fixed words and behavior |
|---:|---|---|
| 0 | `ARM_A4` / `READ_A4` | `01B0 FF5F 26A4 00A0`; single stored-code candidate. |
| 1 | `ARM_0E` / `READ_0E` | `01B0 FF5F 260E 00A0`; single alternate stored-code candidate. |
| 2 | `ARM_LIVE` / `READ_LIVE` | Repeating live profile; first block uses `4196`, later blocks `21F6`, with fixed PID words in map frames. |
| 5 | `ARM_OFF` / `READ_OFF` | `01B0 FF5F 80CE 7F20`; fixed go-offline candidate. |
| 6 | `ARM_LIVE2` / `READ_LIVE2` | Repeating live profile with its fixed PID map. |
| 7 | `ARM_KOEO` / `READ_KOEO` | Repeating `01B0 FF5F 253E 00A0` KOEO self-test candidate. |
| 8 | `ARM_KOER` / `READ_KOER` | Repeating `01B0 FF5F 253E 00A0` KOER self-test candidate. |
| 9 | `ARM_CLR` / `READ_CLR` | `01B0 FF5F 0291 00A0`; single-shot state-changing DTC-clear candidate. |
| 10 | `ARM_MEM` / `READ_MEM` | `42F3`, then `22D3`; offsets 1–15; hard 10-second timeout. |
| 11 | `ARM_LIVE3` / `READ_LIVE3` | Repeating live profile with its fixed PID map. |
| 12 | `ARM_ALL` / `READ_ALL` | Repeating combined live profile with its fixed PID map. |
| 13 | `ARM_ECU_STATUS` / `READ_ECU_STATUS` | `01B0 FF5F 0381 00A0`; one request, 10-second raw RO capture. |
| 14 | `ARM_PIDMAP` / `READ_PIDMAP` | `01B0 FF5F 005E 00A0`; one request, 10-second raw capture; source parity discrepancy unresolved. |
| 15 | `ARM_DMRMAP` / `READ_DMRMAP` | `01B0 FF5F 242E 00A0`; one request, 10-second raw RO capture. |
| 16 | `ARM_DMR` / `READ_DMR` | `01B0 FF5F 22C6 00A0`; one request, 10-second raw RO capture. |
| 17 | `ARM_BOTH` / `READ_BOTH` | `01B0 FF5F 271E 00A0`; one request, 10-second raw RO capture. |
| 18 | `ARM_PIDMAP_ALT` / `READ_PIDMAP_ALT` | `01B0 FF5F 004E 00A0`; parity-derived alternative, one request, 10-second capture. |
| 19 | `ARM_KOEO_ALT` / `READ_KOEO_ALT` | Repeating `01B0 FF5F 2594 00A0` KOEO candidate, kept separate from `253E`. |
| 20 | `ARM_CLEAR_A1` / `READ_CLEAR_A1` | `01B0 FF5F 01A1 00A0`; single-shot, state-changing clear candidate. |
| 21 | `ARM_CLEAR_F4` / `READ_CLEAR_F4` | `01B0 FF5F 01F4 00A0`; single-shot, state-changing clear candidate. |
| 22 | `ARM_CHANGE_BAUD` / `READ_CHANGE_BAUD` | `01B0 FF5F 8174 00A0`; single-shot mode-change candidate. |
| 23 | `ARM_DMRMAP_TX` / `READ_DMRMAP_TX` | `01B0 FF5F 42A6 00A0`; single-shot map-transmit candidate. |
| 24 | `ARM_STOP_PID_FLOW` / `READ_STOP_PID_FLOW` | `01B0 FF5F 411E 00A0`; single-shot flow-control candidate. |
| 25 | `ARM_PIDMAP_TX` / `READ_PIDMAP_TX` | `01B0 FF5F 4196 00A0`; one request, 5-second raw RO capture. |
| 26 | `ARM_PID_VALUES` / `READ_PID_VALUES` | `01B0 FF5F 21F6 00A0`; one request, 10-second raw RO capture. |
| 27 | `ARM_MEM_OFF0` / `READ_MEM_OFF0` | `42F3`, then `22D3`; offsets 0–15 in the IW2/frame schedule; hard 10-second timeout. |
| 28 | `ARM_MEM_SINGLE` / `READ_MEM_SINGLE` | `01B0 FF5F 42F3 00A0` only; no continuation, then 10-second raw capture. |
| 29 | `ARM_MEM_PARITY` / `READ_MEM_PARITY` | `42F3`, then generic-parity `2293`; offsets 1–15; hard 10-second timeout. |

The four MEM variants isolate the sequence hypotheses. `MEM` sends one
`42F3` initialization block, then the published literal `22D3` continuation
and offset words 1–15. `MEM_OFF0` adds offset 0 to the same IW2/frame schedule
to test whether it is a RAM address or reserved. `MEM_SINGLE` sends only the
four-word `42F3` envelope and listens for 10 seconds. `MEM_PARITY` substitutes
generic `2293` for the published `22D3` continuation while retaining offsets
1–15. The target address map and ECU parity acceptance remain unverified.
All MEM variants stop at 10 seconds without the normal repeating-profile
block-boundary extension. Raw UART capture remains loss-aware through `RX`
and `RXB`; no host address or continuation payload is accepted.

`4196` and `21F6` are also exposed separately as `PIDMAP_TX` and `PID_VALUES`.
The former sends once and captures raw RO for 5 seconds; the latter sends once
and captures for 10 seconds. Their availability adds no claim of ECU support.

No arbitrary hex entry, all-byte sweep, or brute-force opcode scan is provided.
Unknown commands can change ECU diagnostic state, clear information, change
communication mode, or enter tests; an assumption that every unknown request
can only clear DTCs is not valid.

## Application and firmware behavior

The Android/PWA app maintains a separate UI allowlist from this firmware
command profile table. UI exposure should not be inferred from firmware
availability. The app records selected commands, source and target uncertainty,
bridge capture verdict, raw RO byte count, and raw transcript in the append-only
diagnostic journal. It shows raw response evidence without assigning a sensor
name or claiming ECU ownership. The full diagnostic ZIP retains raw DCL records.

The firmware accepts only the named `ARM_*` / `READ_*` variants and checks the
exact four request words through the existing local GPIO17 pad witness. Each
profile is bounded by its class: discovery and one-shot candidates transmit
once, standalone `PIDMAP_TX` captures for 5 seconds, clear requests capture for
4 seconds, and KOEO/MEM use their fixed bounded continuation behavior. No raw
bytes are accepted from the host.

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
