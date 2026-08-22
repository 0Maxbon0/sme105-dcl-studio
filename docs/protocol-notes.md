# DCL protocol notes

This is an evidence ledger, not a protocol specification. A statement stays in
its present category until evidence justifies moving it. External code and
documents describe other hardware and ECUs; they do not verify SME-105.

## Observed

No SME-105 DCL capture, command response, bus timing, pin mapping, signal
scaling, or high-idle diagnosis has been recorded in this project.

Consequently:

- there is no verified SME-105 baud rate;
- there is no verified SME-105 DCL connector polarity;
- there are no verified frame boundaries;
- there are no verified request/response pairs;
- there are no verified SME-105 parameter addresses or formulas.

Add an **Observed** claim only with a capture filename, SHA-256, UTC event
marker, interface configuration, and a repeat run.

## Reference

The following claims describe public material, not this vehicle.

### Public implementation

The `tim8707/ford-eec-iv-diagnostic` repository describes a Java EEC-IV scanner
using a USB/AVR/75ALS176 bridge. Its README says the controller buffers
communication because an ordinary USB-RS-485 converter may not meet ECU
timing:

- Repository: <https://github.com/tim8707/ford-eec-iv-diagnostic>
- README: <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/README.md>
- AVR implementation:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/EEC-IV_asm>
- Host serial setup:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/util/ConnectionPool.java>

The public implementation uses serial configuration with eight data bits, no
UART parity, and two stop bits (8N2). Its AVR source includes DCL-side 9600 and
19200 baud paths. The Java host-to-bridge link is separately configured at
38400 baud; that must not be confused with a verified DCL bus rate.

Therefore, 8N2 with 9600 and 19200 are candidates to test separately, not
confirmed SME-105 settings.

### Communication map

The repository contains an experimentally developed DCL communication map:

- DCL map:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/DCL_communication_map.pdf>
- Commit that introduced the map:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/commit/0cd996cbe6bbe4d86718f6c56ebd85005aa37dc6>

The repository itself characterises the commands as found experimentally.
Treat every address, command, response, field offset, and label in the PDF as
a reference candidate. The map does not establish that SME-105 uses the same
calibration, strategy, revision, or command set.

### Two-byte word and parity claim

Issue 7 states that a DCL word arrives as two bytes, carries 12 data bits and a
four-bit parity nibble, and requires byte rearrangement/masking followed by a
vertical nibble parity check:

- Issue 7:
  <https://github.com/babroval/ford-eec-iv-diagnostic/issues/7>

The issue gives examples including `FF 5F`, `00 A0`, `00 B1`, and `18 21`.
These examples are useful decoder test vectors only after the exact
transformation and parity algorithm are specified in tests. They do not by
themselves establish message framing or SME-105 parameter meaning.

The four-bit parity nibble is DCL word content. It is not the UART parity
setting: the referenced serial configuration is `N` in 8N2.

### Published Java conversion formulas

The public Java parameter service contains formulas and fixed field offsets:

- Java formulas:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/service/ParameterServiceImpl.java>
- Parameter labels used by that project:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/eec-iv/EECIVParameters.csv>
- Live-data assembly:
  <https://github.com/tim8707/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/controller/StartController.java>

These are published implementation formulas, not authoritative physical-unit
definitions. Before reuse, preserve Java integer arithmetic and truncation,
identify the original raw word(s), compare against the project's CSV labels,
and validate direction, range, units, and response to controlled events on
SME-105. Do not assign ECT, TPS, load, IAC, O2, RPM, or any other name solely
because an offset occupies the same position in a reference frame.

## Inferred

The following are working hypotheses:

- DCL is request/response rather than an unsolicited broadcast. Therefore a
  truly receive-only adapter may capture no bytes.
- A successful active session may depend on bounded request timing and fast
  turnaround, consistent with the reference project's buffered bridge.
- Two received bytes may form one protected 12-bit word, but word alignment
  cannot be inferred from arbitrary byte pairs without request/response and
  parity evidence.
- Repeated, event-correlated values may represent physical signals, but
  correlation alone does not identify units or prove causation.
- ASCII hexadecimal lines emitted by an ESP may encode bridge records.
  However, CR, LF, spaces, timestamps, and line boundaries belong to the
  bridge protocol, not necessarily to DCL framing.

Every inferred decoder output must retain links to the exact raw byte offsets
and must be possible to regenerate without modifying the source capture.

## Unknown

The following remain unknown for SME-105:

- whether this ECU exposes DCL at the expected connector;
- DCL conductor identities, A/B polarity, idle voltage, loading, and
  termination;
- whether 9600, 19200, both, or neither applies;
- inter-byte timing, turnaround delay, request cadence, and timeout;
- start-of-frame, end-of-frame, addressing, length, escaping, and checksum
  rules beyond the referenced nibble-parity claim;
- the exact nibble-parity generation and acceptance rules;
- valid requests and whether any request can alter ECU state;
- field offsets, signedness, bit order, scaling, units, sentinel values, and
  update rates;
- mappings for ECT, TPS, calculated load, IAC command/feedback, O2, fuel
  correction, RPM, and vehicle speed;
- differences among SME-105 calibration, market, transmission, and model
  revision.

Unknowns must remain visible in analysis output. A decoder must not fill them
with reference defaults.

## Validation rules

1. Preserve and hash the raw capture before interpretation.
2. Record serial settings and adapter mode in the capture metadata.
3. Use explicit event markers; never derive events only from signal changes.
4. Repeat the same event in the same session and in a second session.
5. Change one condition at a time.
6. Require parity-valid, request-linked, repeatable data before proposing word
   alignment.
7. Require plausible cold-to-warm and controlled-input response before
   proposing a sensor mapping.
8. Keep raw value, candidate formula, units, and confidence separate.
9. Reject mappings that depend on editing, trimming, or regrouping raw bytes.
10. Never promote a mapping merely because it matches the public DCL map or
    Java formulas.

