# SME-105 standalone timed CART capture — B transmitter locked

PlatformIO Arduino ESP32 DevKit V1 (`espressif32@6.12.0`, Arduino core
2.0.17, IDF 4.4). Pins: MAX487 RO→GPIO16, DI←GPIO17, DE←GPIO18. External
GPIO18 pulldown and protected automotive electrical interface are mandatory
for any ECU-connected use. This firmware is an experimental receiver, not a
car-ready diagnostic fault reader.

Build without flashing:

```sh
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot
```

This revision was also uploaded to the connected ESP32 on 2026-11-02 and
read back via exact USB `STATUS` identity. The upload verified flash hashes.
It remains a timed-capture development firmware, not a DTC reader.

USB serial at 115200, CR/LF commands:

* `STATUS` and `HELP` are passive.
* `READ_B_ONCE` responds `DENIED B_TX_COMPILE_LOCKED`, **never sends B**.
* `PLAN_B_ONCE` performs the same one-shot reference handshake as
  `CAPTURE_CART_ONCE`, then the hardware timers dry-run the four full
  command-word opportunities `01 B0`, `FF 5F`, `26 A4`, `00 A0`
  in CART IDs 0–3 slot 1 after a validated 16-frame baseline. ISR witnesses
  report predicted versus fired times; **zero B TX bytes are sent**.
* `CAPTURE_CART_ONCE` consumes one attempt per boot and explicitly sends
  only the documented 2400/8N2 `Echo Module ID` 11-byte frame. It demands
  the exact observed 11-byte self-echo followed by one `01` candidate byte,
  then sends the documented 11-byte `Go CART` frame. A hardware timer cuts
  off DE at 100 ms for each reference frame. It then switches to 9600/8N1
  with UART2's receive interrupt timestamping every FIFO byte and collects
  at most 8192 events / 10 seconds. No automatic bus TX at boot.
* `STOP` drives DE LOW when idle; no second attempt is permitted.
* `PLAN_B_ONCE` consumes one explicit reference handshake attempt and
  collects 9600/8N1 UART ISR events while running a zero-transmission model
  of the four-word CART command. A full, timed, ID-only baseline cycle
  `0..15` with correct parity and consistent 0/4-bit header gap must finish
  first; a second ID cycle is required to plan frame IDs `0..3` slot 1.
  The candidate four words are `01 B0`, `FF 5F`, `26 A4`, `00 A0`.
  UART ISR arms a dedicated 1 MHz group timer for each theoretical slot
  edge; hardware timer ISR records its actual firing time, with no GPIO or
  UART writes. Any missing frame, wrong ID, bad parity, phase/cadence drift,
  late timer, FIFO coalescing, UART error or cap makes the model fail.
  `CART_B_PLAN ... mode=DRY_RUN tx_bytes=0` and `CART_B_SLOT ...` are **model
  witnesses**, never real `CART_TX` records. Complete means a timing model
  processed two ID cycles; it is not a demonstrated ECU command or DTC.

Pure state-machine tests (synthetic, no device):

```sh
./.venv/bin/python firmware/sme105_dtc_one_shot/verify_b_plan.py
```

The `CART_EVT t_us=<integer> byte=<hex>` records are MCU UART RX FIFO
interrupt timestamps, buffered and printed **after** collection. They
approximate byte completion, but ISR scheduling jitter must be measured
using a logic analyzer before relying on the 175 µs offline timing bound.
If ISR FIFO coalescing, UART errors or buffer overflow occurred, `CART_CAPTURE`
marks the recording compromised. `CART_BASELINE` validates only exact
zero-slot ID-only cycles and cannot prove fault-code decoding. Host tools
should parse the raw event stream, align to complete ID0 cycles and retain
its physical timing, rejected event evidence and UART error counts.

Why no B: `flxkrmr/eec-iv-reader-arduino` gives read-code candidate
`26 A4`, while `doncreat0r/eeciv` gives `26 0E`; the latter's command is
part of a multi-frame CART command buffer. The ID2/slot1 word alone cannot
be assumed sufficient. A two-byte B TX also needs independent bench proof
of actual 16-frame synchronization, slot phase, DE turn-on/turn-off and
collision-free behavior. Enabling the macro fails compilation by design.
No 2400 handshake, 9600 UART capture or valid 16-ID cycles imply an
authenticated ECU response or a verified stored trouble code.
