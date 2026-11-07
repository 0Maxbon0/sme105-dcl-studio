# SME-105 DCL protocol structure and A–R command analysis

Date: 2026-11-07  
Target: 1998 Ford Escort 1.6 Zetec-E, EEC-IV KALE SME-105, engineering identity
`97AB-12A650-KA`  
Scope: source analysis, offline parity calculation, and preserved evidence
review. No command was transmitted to the vehicle during this analysis.

## 1. Executive findings

1. The repeated Hex patterns are meaningful. The common DCL word is 12 data
   bits plus 4 vertical-parity bits. For ordinary command-table words, the
   12-bit data is interpreted as an 8-bit operation identifier plus a 4-bit
   next-block receive-slot field; other word classes use those data bits for
   frame IDs, PID entries, qualifiers, or control values.
2. The source formula is:

   ```c
   VPARITY(x, y) = ((((x & 0x0F) ^ ((x >> 4) & 0x0F) ^
                      (y & 0x0F) ^ 0x0A) << 4) | (y & 0x0F))
   ```

   Equivalently, if `n = y & 0x0F`, then
   `second = (((low(x) XOR high(x) XOR n XOR 0xA) & 0xF) << 4) | n`.
   This is XOR-based vertical parity, not a CRC over the full request.
3. Running the local `src/ford_dcl/cart_reference.py::parity_byte()` against
   all 15 non-empty A–R entries produced **14/15 matches**. The only mismatch
   is `F = 00 5E`; the formula produces `00 4E` for the same low nibble `E`.
4. The source table stores `00 5E` literally and its transmit path copies that
   word without recalculating it. The same source's receive-side parity check
   uses the generic rule, so `00 5E` fails the reference's own parity equation.
   F is reachable and has a generic 14-slot response window, but its dedicated
   `f` response-state handler is commented out. This proves what that source
   would emit if F were selected; it does not prove ECU acceptance or a decoded
   PID-map result. Treat `00 5E` as a published but unverified literal, not a
   known parity exception.
5. The `babroval` communication-map PDF does not corroborate `00 5E`. It
   contains `00 4E` repeatedly in the frame-ID rows (a valid frame ID word),
   and its live-data sequence uses `41 96` then `21 F6`. It also shows `26 A4`
   and `25 94` in its fault/self-test sequences.
6. The `flxkrmr` alternatives `26 A4`, `25 94`, and `01 F4` all satisfy the
   same parity formula. Their low nibbles differ from `26 0E`, `25 3E`, and
   `01 A1`; they are not merely alternate parity encodings of identical words.
   The source uses those low nibbles in slot-count/state logic, so treat each
   as a separate length/profile variant.
7. No recovered TX witness shows `00 5E` or `00 4E` sent to the SME-105. The
   earlier `ALL` recording shows `41 96` and ends with `ecu_verified=0`. The
   local `TX2_BENCH` `26 A4` record explicitly had the external bus disabled.

## 2. Two-byte word structure

The common DCL word is **12 data bits plus 4 vertical-parity bits**, carried in
two bytes. The on-wire byte pair is `first second`; to view it as the word used
by the community decoder, swap the bytes: `word16 = (second << 8) | first`.
Then:

- `data12 = word16 & 0x0FFF = (first << 4) | (second & 0x0F)`.
- `parity4 = word16 >> 12 = second >> 4`.
- `parity4 = high(first) XOR low(first) XOR low(second) XOR 0xA`.

The same byte-swap and 12-data/4-parity interpretation is described in a
reverse-engineering comment on
[`babroval` issue #7](https://github.com/babroval/ford-eec-iv-diagnostic/issues/7).
That is community analysis, not an OEM protocol specification; it is useful
because it agrees with the `VPARITY` macro and the reference receiver's parity
check.

For ordinary A–M/Q command words, the 12 data bits are interpreted as an
8-bit operation identifier followed by a 4-bit field. In `Diag324.c`, that
low nibble is assigned to `slotCountNext`, the number of receive slots expected
in the next block/frame. In selected E/I/Q response paths, the same nibble is
also reused as `cmdLength`, the number of outbound command/data slots. These
are distinct counters; do not collapse them into one universal “argument.”
Other word classes use the same 12+4 representation differently: PID-map
words, frame-ID words, qualifiers, and filler/control words have their own
field meanings.
- `R = FF 5F` is explicitly described as an idle/control block, not an ordinary
  sensor-query opcode. `01 B0`, `FF 5F`, and `00 A0` also occur as framing or
  control words in the four-word request envelope.

The request envelope used by the current bridge is:

```text
01 B0  FF 5F  <operation-word>  00 A0
```

The four two-byte words must be kept in their correct synchronized slots. A
GPIO17 pad witness proves that bytes reached the local TX pad; it does not prove
that the MAX487 differential bus delivered them or that the ECU accepted them.

Examples of the 12+4 representation:

| On-wire bytes | Swapped word | 12-bit data | Parity nibble | Interpretation |
|---|---:|---:|---:|---|
| `FF 5F` | `5FFF` | `FFF` | `5` | Idle/control data word |
| `00 A0` | `A000` | `000` | `A` | Zero/trailer word |
| `00 B1` | `B100` | `001` | `B` | Frame-ID/status word example |
| `00 4E` | `4E00` | `00E` | `4` | Frame ID `0xE` with valid parity |
| `00 5E` | `5E00` | `00E` | `5` | Same data `00E`, but parity does not match the generic rule |

## 3. Parity audit of every non-empty A–R command

| Letter | Published word | Expected second byte | Low nibble | Source meaning | Parity |
|---|---:|---:|---:|---|---|
| A | `03 81` | `81` | `1` | Get ECU status | Match |
| B | `26 0E` | `0E` | `E` | Read codes | Match |
| C | `02 91` | `91` | `1` | Clear codes | Match |
| D | `25 3E` | `3E` | `E` | Run KOEO/KOER | Match |
| E | `41 96` | `96` | `6` | Transmit/load PID map | Match |
| F | `00 5E` | `4E` | `E` | Read PID map | **Mismatch** |
| G | `21 F6` | `F6` | `6` | Read PID values | Match |
| H | `01 A1` | `A1` | `1` | Clear DCL error/flag register | Match |
| I | `42 A6` | `A6` | `6` | Transmit/load DMR map | Match |
| J | `24 2E` | `2E` | `E` | Read DMR map | Match |
| K | `22 C6` | `C6` | `6` | Read DMR values | Match |
| L | `27 1E` | `1E` | `E` | Read PID and DMR values | Match |
| M | `81 74` | `74` | `4` | Switch baud rate | Match |
| Q | `41 1E` | `1E` | `E` | Stop PID-value flow | Match |
| R | `FF 5F` | `5F` | `F` | Idle/control block | Match |

The reserved N/O/P entries are zero placeholders, not discovered commands.
The `cmdData[19][2]` initializer has 18 explicit A–R entries; its final extra
element is implicitly zero-initialized and is not an S command. The reference
TX guard suppresses an all-zero command pair, so N/O/P and the implicit S entry
are not usable command words.

The alternate words from `flxkrmr` also pass the formula:

| Function family | `doncreat0r` word | `flxkrmr` word | Low-nibble change |
|---|---:|---:|---:|
| Stored-code read | `26 0E` | `26 A4` | `E` (14) → `4` (4) |
| KOEO | `25 3E` | `25 94` | `E` (14) → `4` (4) |
| Clear DCL flags | `01 A1` | `01 F4` | `1` (1) → `4` (4) |

The two projects label these as the same broad functional families, but the
different low nibbles mean different slot/length profiles in the examined
scanner code. Do not call them identical commands, assume identical response
lengths, or automatically retry one after the other.

## 4. What the source actually does with the commands

The A–R table is in [`doncreat0r/eeciv/tables.h`](https://github.com/doncreat0r/eeciv/blob/master/tables.h).
The execution state machine is in
[`doncreat0r/eeciv/Diag324.c`](https://github.com/doncreat0r/eeciv/blob/master/Diag324.c).

- `cmdData` stores the A–R words. When a command is selected, `Diag324.c`
  copies its two bytes into `cmdBuf[2][0..1]` unchanged and derives the next
  receive-slot count from the low nibble of the second byte. At each frame-0
  boundary, `slotCount` receives `slotCountNext`, and `slotCountNext` resets to
  the default 2 (`Diag324.c:376–377`).
- The PC queues a command letter; at the next frame-0 boundary the scanner
  promotes it to `cmdCurrent`, loads the table word, and schedules its next
  receive-slot count. The command word is sent in frame 2, slot 1. Frame 3,
  slot 1 is a separate qualifier word when the selected operation requires
  one; it is not the same field as the command word's low nibble.
- F is reachable through the scanner's PC command path: it can be queued,
  copied from `cmdData`, and sent in its synchronized command slot. It is not
  merely an unused table entry. The missing `f` handler means the scanner has
  no F-specific response-state action; the generic receive path can still
  collect parity-valid slots for the response window, but it does not provide
  a PID-map-specific decode or semantic acceptance check.
- `RecalcCmdBufVP()` begins at command-buffer byte offset 3. It recalculates
  parity for later payload words, such as the PID/DMR map data; it does not
  repair the operation word at offsets 0–1. Therefore the source would send
  `00 5E` as written if F is selected.
- The `case 'f'` response handler is commented out. The source does not provide
  a completed parser proving what the F response should contain or how to
  validate it.
- The E path loads a PID map and the G path reads values using that map. E is
  not a passive “discover supported sensors” operation. A loaded map is the
  scanner's chosen list, not necessarily a complete ECU capability bitmap.
- The I path transmits a DMR map. J/K/L are the corresponding map/value/combined
  labels in the command table, but the source has incomplete response handling
  for J and L. Preserve raw bytes until their structure is independently
  understood.
- H and C clear diagnostic state; M changes communication speed; D invokes a
  self-test; Q/R are mode/stream control. These do not belong in an
  unrestricted read-only discovery sweep.

### Reference state-machine caveats

- `cmdLength` is separately declared as the number of outbound command slots;
  `slotCount` and `slotCountNext` count inbound slots. The command low nibble
  directly sets the next inbound block's slot count. The E/I/Q response paths
  additionally reuse it for outbound map/command length.
- E's response state uses the low nibble as `cmdLength` and switches to R.
  I repeats while waiting for the ECU's diagnostic-mode status to become
  `0x42`, then switches to Q. Q switches to R while the source comments that
  the ECU saves the PID list. G repeats the PID-value request; K increments a
  DMR address qualifier by four for address iteration. D repeats while the
  self-test-complete status bit is not set. M's actual `SetBaudrate()` call is
  commented out in the response branch, so the table label alone does not
  establish a working baud-switch implementation.
- **Potential source buffer defect in R:** `frBuf` is declared as 16 rows ×
  30 bytes, with 2 header bytes and comments limiting frame data to `0x0E`
  (14) words (`Diag324.c:106–108`). R is `FF 5F`, whose low nibble F sets
  `slotCountNext=15`. If a 15th inbound word is processed, the write at
  `frBuf[frID][slotIdx*2 + wordSync - 1]` (`Diag324.c:514–517`) addresses byte
  30 or 31, outside indices 0–29. This is a source-level out-of-bounds risk
  for that reference implementation; do not copy R's 15-slot behavior blindly.
  R is reached automatically from the A, E, and Q response handlers, so this
  is not limited to manually selecting R.
- The frame-3 qualifier is constructed separately by `SetQualifier()`:
  byte 0 packs the two high address nibbles and decrements the 12-bit address;
  byte 1 carries the remaining qualifier nibble plus its own vertical parity
  (`tables.h:964–984`). `cmdSetQual`/`cmdReadAdr` use this path
  (`Diag324.c:3428–3455`). This is another structured field in the protocol,
  not evidence that every command byte pair is a simple opcode plus arbitrary
  argument.
- The PC command handler stores the requested letter without validating its
  range, and the uppercase path indexes `cmdData[letter - 'A']`
  (`Diag324.c:733–736, 480–484`). Only A–S fit the declared 19-entry array;
  S is the implicit zero entry and T+ can index beyond the array. The current
  SME-105 bridge's fixed command whitelist must remain in place; do not copy
  this reference's unrestricted letter interface.

## 5. PID and DMR maps are different data structures

- `PIDMap` is a 16 × 8-byte table: 64 two-byte PID entries, arranged as four
  entries per frame. The comments call it an FDS/WDS v4 default map and show
  repeated groups plus engine and transmission-related IDs.
- `PIDMapT` is a separate 64-entry test map whose identifiers extend through
  `0x6A`. It is not proof that the target SME-105 supports every ID.
- Each PID map word has its own parity byte. For example, PID `01` is encoded
  as `01 38`; the low nibble `8` is part of that PID-word format, and the high
  nibble is the calculated parity.
- `DMRMap` contains internal addresses `0x10` through `0x4F`, with the second
  byte initially zero before the map payload parity is recalculated. These are
  addresses, not friendly sensor names. The source does not expand “DMR”; do
  not invent an acronym expansion.

Consequently, “read PID map” (F), “load PID map” (E), and “read PID values” (G)
are three different operations. Likewise, I (load DMR map), J (read DMR map),
K (read DMR values), and L (combined values) must not be collapsed into one
generic “list sensors” request.

## 6. Cross-reference evidence

### `flxkrmr/eec-iv-reader-arduino`

[`EecIv.cpp`](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp)
shows the following eight-byte parameter sequences:

- Baud change: `01 B0 FF 5F 81 74 00 A0`.
- Clear DCL errors: `01 B0 FF 5F 01 F4 00 A0`.
- Stored-code read: `01 B0 FF 5F 26 A4 00 A0`.
- KOEO: `01 B0 FF 5F 25 94 00 A0`.
- PID mode/map sequence: `01 B0 FF 5F 41 96 00 A0`, followed by
  `01 B0 FF 5F 21 F6 00 A0` with its PID map payload.

The README explicitly says the project is work-in-progress and not completely
working. These words are alternate experimental profiles, not proof of
compatibility with the SME-105. Its [Development wiki](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Development)
also says DCL is not publicly documented and describes first testing against a
separate inexpensive EEC-IV ECU before testing the author's car.

### `babroval/ford-eec-iv-diagnostic`

The one-page [`DCL_communication_map.pdf`](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/DCL_communication_map.pdf)
shows `26 A4` for stored faults, `25 94` for KOEO/KOER, and `41 96` followed by
`21 F6` for live data. It does not list `00 5E` as a PID-map read command. Its
repeated `00 4E` values occur in the frame-ID rows, not as a standalone command
word. This is independent corroboration for the general framing and some
alternate operations, but not for F=`00 5E`.

## 7. `00 5E` versus `00 4E`: exact verdict

| Question | Finding |
|---|---|
| Is `00 5E` present in an external source? | Yes, as the literal F entry in `doncreat0r/eeciv/tables.h`. |
| Does it satisfy that same source's generic VPARITY formula? | No. The formula gives `00 4E`. |
| Does the reference scanner recalculate the command word before TX? | No. It copies `cmdData` unchanged; payload recalculation starts later in the buffer. |
| Does the source prove an accepted/decoded F response? | No. The `f` response handler is commented out. |
| Does the babroval map independently show F=`00 5E`? | No. It shows `00 4E` as a frame ID and other data commands. |
| Was either candidate sent to the SME-105 in preserved TX evidence? | No `TX_PAD`/`TX2_BENCH` witness for `005E` or `004E` was found. |
| Was either accepted by the ECU? | No acceptance evidence. |

The strongest current explanation is a source-table typo or an unverified
command, rather than a proven parity exception. A true exception remains
possible but unsupported. Keep `005E` as the published literal candidate and
`004E` as a parity-derived hypothesis; do not automatically send both.

## 8. Preserved local evidence and test boundary

The offline parity check was executed against the local helper with
`PYTHONPATH=src python3`; it returned 14 matching A–R words, one mismatch
(`005E` → expected `004E`), and parity matches for all three `flxkrmr`
alternatives. The focused app protocol test `node --test
app/tests/protocol.test.mjs` passed 6/6 after updating the explanatory text.
These are software/source checks only.

The recovered recording
`../sme105-field-evidence/2026-11-07/phone-pull-0058-readonly/diagnostic-run-17004e46-recovered/raw.txt`
contains `EVENT read_armed variant=ALL` and TX witnesses for:

```text
01B0 FF5F 4196 00A0
```

Its END line reports `ecu_verified=0 dtc_verified=0`. This is not an F test.
The same recording's `TX2_BENCH_WORD` for `26A4` says
`external_bus_disabled=1`, so it proves only local pad behavior. RX records
containing `00 4E` or the byte sequence `00 5E` are not TX evidence.

At the time of this review, the host had no USB serial device and no ADB device;
the paired BLE bridge reported disconnected. The phone snapshot from the prior
recording is historical and does not establish a current control connection.
No firmware flash, Android install, or vehicle command was performed in this
analysis. The current bridge implementation still preserves the published
`005E` literal as a fixed single-shot candidate and keeps `004E` deferred.

### Required conditions before the live experiment

1. Confirm the vehicle is parked and stationary, parking brake applied,
   ignition ON, engine OFF.
2. Confirm the ESP32/MAX487 bridge is physically connected in the normal,
   previously validated arrangement and the app has a current authenticated
   connection.
3. Complete the local `TX2_BENCH` gate after reboot. This test must keep DE LOW
   and the external bus disconnected; it is not an ECU test.
4. Arm and send **only** the published `005E` candidate once, using the fixed
   synchronized envelope. Capture the complete raw RO stream and TX witness.
5. Do not automatically follow with `004E`. Stop, preserve the raw evidence,
   inspect ECU mode/status/error flags and only then decide whether a separate
   experiment is justified.

The bridge's local pad witness is not a differential-bus/ECU acknowledgement.
No result should be called “accepted” without ECU-side state or response
evidence that is independently attributable to the ECU.

## 9. Safety classification for future exploration

| Class | Commands | Treatment |
|---|---|---|
| Read candidates | `03 81`, `00 5E`, `24 2E`, `22 C6`, `27 1E` | Fixed single-shot, one at a time, raw capture only; each remains unverified on SME-105. |
| Existing read/data flow | `26 0E`, `26 A4`, `21 F6` | Keep as separate known profiles; map/slot semantics and ECU acceptance remain profile-specific. |
| Test-mode entry | `25 3E`, `25 94` | Separate controlled KOEO/KOER procedures; not passive discovery. |
| State clearing | `02 91`, `01 A1`, `01 F4` | Explicitly gated; never part of automatic discovery. |
| Map/configuration writes | `41 96`, `42 A6` | Load selected PID/DMR maps; not generic read-only discovery. |
| Link/mode control | `81 74`, `41 1E`, `FF 5F`, `80 CE/7F20` | Deferred or sequence-bound; do not brute-force. |
| Unverified derived candidate | `00 4E` | Keep deferred; no automatic fallback from `00 5E`. |
| Reserved/unknown | N/O/P, arbitrary values | Do not infer or transmit. |

## 10. Source links

- [doncreat0r `tables.h`](https://github.com/doncreat0r/eeciv/blob/master/tables.h)
- [doncreat0r `Diag324.c`](https://github.com/doncreat0r/eeciv/blob/master/Diag324.c)
- [flxkrmr `EecIv.cpp`](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp)
- [flxkrmr `Cart.cpp`](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/Cart.cpp)
- [flxkrmr README](https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/README.md)
- [babroval `DCL_communication_map.pdf`](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/DCL_communication_map.pdf)
- [babroval issue #7 — community 12-bit data / 4-bit parity explanation](https://github.com/babroval/ford-eec-iv-diagnostic/issues/7)
- [flxkrmr Development wiki — undocumented protocol / separate ECU testing](https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Development)
- [local bridge implementation](../firmware/sme105_usb_bridge/sme105_usb_bridge.ino)
- [local app protocol catalogue](../app/js/protocol.js)
