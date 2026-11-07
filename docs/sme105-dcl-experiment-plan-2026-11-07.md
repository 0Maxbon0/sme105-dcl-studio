# SME-105 DCL experiment plan and command matrix

**Date:** 2026-11-07  
**Target:** 1998 Ford Escort 1.6 Zetec-E, EEC-IV SME-105 (`97AB-12A650-KA`)  
**Release context:** firmware v25 (`esp32dev_ble`) and Android app 1.8.12 / versionCode 14

This is the working command matrix and bounded experiment plan for the target
ECU. The A–R labels and descriptions come from experimental third-party EEC-IV
references, not an OEM SME-105 command specification. A command label, parity
match, local pad witness, or raw RO traffic does not alone prove ECU acceptance
or response meaning. See the [source discovery catalogue](SME105-DCL-command-discovery-2026-11-07.md)
and [protocol structure analysis](SME105-DCL-protocol-structure-analysis-2026-11-07.md)
for provenance and the detailed evidence audit.

## Evidence levels

| Level | Meaning in this plan |
|---|---|
| **Historical target-ECU evidence** | Earlier target-session/profile records exist for these words: `26A4`, `260E`, `253E`, and the live sequence `4196` / `21F6`. This records historical use and available transcript evidence; it is not a blanket claim that every word was accepted or semantically decoded by the ECU. A local `TX2_BENCH` with the vehicle bus isolated is pad evidence only. |
| **Prepared new read candidate** | Fixed, single-shot raw-capture profiles prepared for `0381` (ECU status), `005E` (published PID-map literal), and `242E` (DMR map). They have not been established as SME-105-supported commands. |
| **Experimental variant** | Separate, unresolved work: DMR values `22C6`, combined PID/DMR `271E`, memory sequence `42F3` / `22D3`, DTC clear `0291` (`CLR`), and go-offline `80CE` / `7F20` (`OFF`). Risk, prerequisites, and state effects differ; do not chain them together. |
| **Deferred source candidate** | Listed in a reference but withheld from routine experiments because it clears state, changes mode, needs an unverified map/sequence, or has no validated recovery path. |

## Four-word request envelope

The standard fixed request is four 16-bit words, sent in order:

```text
word 0          word 1       word 2       word 3
01B0            FF5F         CMD          00A0
module/select   idle/sync    command      trailer/idle
```

For ordinary read candidates, only `CMD` changes. The bridge sends the named
profile once, then captures raw RO bytes for its bounded window. There is no
arbitrary opcode field, automatic scan, retry, or fallback. `OFF` is a separate
profile whose fourth word is the `7F20` qualifier:

```text
01B0 FF5F 80CE 7F20
```

It does not use the standard `00A0` trailer. The `MEM` hypothesis is also a
multi-step concept (`42F3` followed by `22D3` value access), not a validated
standalone four-word read.

## VPARITY and the `005E` / `004E` distinction

The reference word model carries 12 data bits and a 4-bit vertical-parity
nibble. The generic second-byte calculation is:

```text
n      = second_byte & 0x0F
parity = (first_byte low nibble XOR first_byte high nibble XOR n XOR 0xA) & 0x0F
second = (parity << 4) | n
```

The calculation matches 14 of the 15 non-empty A–R source-table words. `F`
is the sole mismatch: `tables.h` stores `005E`, while generic `VPARITY(00,0E)`
produces `004E`. Keep `005E` as the published literal candidate. `004E` is only
a local parity-derived hypothesis; there is no automatic fallback and it is
not enabled as a command.

The same two bytes `00 4E` also encode a received CART header with status byte
`00` and frame ID `E` (0x0E). In that position `004E` is **frame-header syntax**,
not proof that diagnostic command `004E` was transmitted. A repeated received
frame-ID E must never be reported as a PID-map request.

All other populated A–R words below match the generic calculation. The
alternative words `26A4`, `2594`, `01F4`, `42F3`, `80CE`, and `7F20` also match.
The local memory value word `22D3` does not: generic parity yields `2293`, so
the `42F3` / `22D3` sequence remains unresolved and deferred.

## Authoritative A–R command matrix

“Generic match” means only that the stored word satisfies the reference parity
formula. It does not establish target compatibility. A dash under N/O/P means
the reviewed A–R source table lists no command for that letter.

| Letter | Command word | Reference label | Parity | Evidence level / disposition |
|---|---:|---|---|---|
| A | `0381` | Get ECU status | Generic match | **Prepared new read candidate**; fixed `READ_ECU_STATUS`, raw response only. |
| B | `260E` | Read stored trouble codes | Generic match | **Historical target-ECU evidence**; existing `READ_0E` profile. Keep distinct from `26A4`. |
| C | `0291` | Clear trouble codes | Generic match | **Experimental variant (`CLR`)**; state-changing, one command only, separate operator approval and capture. |
| D | `253E` | Run KOEO / KOER self-test | Generic match | **Historical target-ECU evidence**; controlled self-test, not a passive read. KOER needs its own running-engine procedure. |
| E | `4196` | Transmit/load PID map | Generic match | **Historical target-ECU evidence**; map-load step in LIVE profiles, not a standalone discovery read. |
| F | `005E` | Read PID map (published literal) | **Mismatch: generic result `004E`** | **Prepared new read candidate**; preserve literal `005E`, raw-only, never auto-substitute. |
| G | `21F6` | Read PID values | Generic match | **Historical target-ECU evidence**; used after map setup by LIVE profiles, not a standalone map-independent query. |
| H | `01A1` | Clear DCL error/flag register | Generic match | **Deferred source candidate**; state-clearing. |
| I | `42A6` | Transmit/load DMR map | Generic match | **Deferred source candidate**; payload and target map compatibility are unverified. |
| J | `242E` | Read DMR map | Generic match | **Prepared new read candidate**; raw-only; DMR expansion and response schema remain unresolved. |
| K | `22C6` | Read DMR values | Generic match | **Experimental variant**; requires a valid DMR map/address-iteration procedure; do not claim decoded values. |
| L | `271E` | Read combined PID and DMR values | Generic match | **Experimental variant**; combined map and response schema are unverified; raw-only. |
| M | `8174` | Switch baud rate | Generic match | **Deferred source candidate**; mode change has no validated recovery sequence. |
| N | — | No command in reviewed source table | — | No candidate inferred. |
| O | — | No command in reviewed source table | — | No candidate inferred. |
| P | — | No command in reviewed source table | — | No candidate inferred. |
| Q | `411E` | Zero/stop PID-value flow | Generic match | **Deferred source candidate**; sequence-dependent mode control, not a standalone read. |
| R | `FF5F` | Idle/control block | Generic match | Envelope word 1; not a standalone inquiry. |

## Alternate and local variants

| Variant | Word sequence | Parity / source note | Disposition |
|---|---|---|---|
| Stored-code alternate | `01B0 FF5F 26A4 00A0` | `26A4` matches generic VPARITY; flxkrmr alternative to `260E`. | Historical target-session evidence; separate from `260E`, never an automatic fallback. |
| Alternate KOEO | `01B0 FF5F 2594 00A0` | Generic VPARITY match; alternate from flxkrmr. | Deferred controlled self-test; not interchangeable with `253E` without its own procedure. |
| Alternate DCL flag clear | `01B0 FF5F 01F4 00A0` | Generic VPARITY match; flxkrmr alternative to `01A1`. | Deferred; state-clearing. |
| Memory read (`MEM`) | Hypothesized `42F3` address/header, then `22D3` value word | `42F3` matches; `22D3` generic result is `2293`. | Experimental and deferred; target memory map, sequence, and parity discrepancy unresolved. |
| Go offline (`OFF`) | `01B0 FF5F 80CE 7F20` | Both words match generic VPARITY. | Experimental mode change; ends diagnostic communication. Use only as a separate, explicitly selected operation with a recovery plan. |
| PID-map parity hypothesis | `004E` | Generic result for data nibble E; not published as the PID-map command. | Denied; distinct from an RX frame-ID E header. No fallback from `005E`. |

## Experiment sequence and controls

1. Record the firmware/app versions, ECU identity, ignition/engine state,
   wiring, transceiver, ambient conditions, and operator consent in the run
   notes/metadata. Begin with the vehicle stationary, ignition ON, engine OFF.
   The base IndexedDB capture record identifies the run and its verdict; do
   not assume it contains every physical setup note unless those fields were
   explicitly added to the record.
2. After every firmware boot, run the local `TX2_BENCH` only with the external
   vehicle bus disconnected. Require the complete four-word GPIO17 pad witness,
   independent RMT decoding of `01B0`, `DE=LOW`, `PASS_LOCAL_PAD`, and a fresh
   `STATUS` reporting the successful per-boot latch. This is local GPIO proof,
   not a MAX487 differential measurement or ECU qualification.
3. If the pad bench fails, is incomplete, or has contradictory evidence, do not
   issue a vehicle command. Its attempt is consumed for that boot; inspect the
   bench setup and only retry after a fresh boot. The firmware gate remains
   fail-closed until a complete pass.
4. Run one prepared candidate per separately armed session: `0381`, then
   published literal `005E`, then `242E`. Do not send `004E` as fallback. Keep
   raw RO bytes and classify possible self-echo separately from ECU-originated
   response evidence.
5. Review and export each capture before moving to an experimental variant.
   Consider `22C6` only after a valid DMR map/iteration plan exists, and `271E`
   only after its map and response structure are specified. `MEM`, `CLR`, and
   `OFF` require independent risk review: memory access is unresolved, `CLR`
   changes diagnostic state, and `OFF` changes ECU communication mode.
6. Never combine `26A4` with `260E`, or `2594` with `253E`, as an automatic
   retry. A no-response result ends that experiment; record it and decide
   offline whether a new, separately approved run is justified.

### Durable recording and export

Each operation creates an IndexedDB capture record before dispatch. Database
`eeciv-recordings` stores metadata in `captures` and ordered raw/CSV Blob chunks
in `chunks` (`id`, `seq`, `raw`, `csv`, byte count). The app flushes about once
per second, retains pending data on a storage failure for export in that tab,
marks interrupted runs incomplete on startup, and does not invent an `END`.
Capture metadata includes the experiment/session identity, variant, persistence
status, start/end times, unit system, sample count, duration, verdict, and
outcome fields (including operator-confirmation fields when that workflow is
used).

`exportExperimentArchive(id)` builds a ZIP containing:

| File | Contents |
|---|---|
| `metadata.json` | Persisted capture metadata and integrity verdict. |
| `raw.txt` | Original stored bridge lines in capture order. |
| `events.jsonl` | JSON Lines for selected `EVENT`, `FAULT`, `DENIED`, `END`, `STATUS`, `PINS`, `BOOT`, and `HELLO` lines. |
| `ro.bin` | Raw RO bytes reconstructed from `RX` / `RXB` lines. |
| `ro-timestamps.csv` | `index,t_us,byte_hex` for each reconstructed RO byte. |
| `tx-pad.jsonl` | JSON Lines for local TX pad witness rows. |
| `SHA256SUMS` | SHA-256 for each preceding archive member. The exporter reopens and verifies every listed member before returning success. |

The exporter also computes an archive SHA-256 for the returned ZIP. Preserve the
ZIP unchanged and record its hash with the experiment. Installed Android
WebView data is private to that app and does not automatically migrate from a
Chrome PWA; export any prior recordings before removing the old app/site data.

## Electrical and deployment gate

Firmware v25 is built with `kActiveMasterQualified = true`; active profiles are
therefore available only behind the runtime qualification path. `TX2_BENCH`
must pass once on the current boot before any active `READ_*`. The volatile
pass latch resets on reboot. A failed or malformed bench consumes the attempt
and prevents command use for that boot. Each read still needs its matching
`ARM_*` within 15 seconds, and a host must validate the ordered pad/RMT
transcript plus fresh `STATUS` rather than accepting a partial pass.

The pad test keeps GPIO18 DE LOW and exercises the local GPIO17 TX/pad-return
path. It does **not** qualify the differential A/B bus, prove transceiver
turnaround, validate the vehicle connector/polarity, or prove ECU acceptance.
Before vehicle deployment, separately confirm a protected 3.3 V transceiver
with deterministic DE and `/RE`, boot-safe DE pull-down, DI idle bias, correct
grounding and isolated OBD pin 16, and measured electrical behavior under the
intended bus conditions. Use `wiring-safety.md` and the firmware bridge
README as the deployment procedure. Do not treat a successful `TX2_BENCH` as a
vehicle wiring sign-off.
