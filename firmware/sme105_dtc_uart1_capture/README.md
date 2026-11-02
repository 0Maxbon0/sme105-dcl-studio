# Experimental UART1 receiver for SME-105 CART (read only after reference handshake)

## Reference ACK overflow recovery guard (2026-11-02)

Vehicle test `captures/TIMED_CART/20261102T194847373892Z-cart-isr.txt`,
SHA256 `a429715158a76c52eed350cbe811e212de71eb33ab4b1215a5cec3b4a60611f3`,
contains `REF_TX ECHO_ID`, `ACK_REJECT overflow`, and immediate
`CART_ABORT`. No Go-CART, B command, or timer plan was performed in that
test. A prior attempt also overflowed; another attempt had an RX/precheck
failure. The actual 2400 baud ACK bytes were not preserved in the old build,
so the cause cannot be proven from those logs. Residual ECU CART mode,
incorrect ACK framing or a noisy/busy line remain hypotheses.

The next **source build**, not automatically uploaded, includes:

* A DE=LOW, receive-only 200ms pre-handshake quiet check. Existing RX data,
  UART errors or RX not idle-high deny Echo-ID; a bounded `PREHANDSHAKE_BUSY`
  evidence line includes the first 8 bytes and summary.
* On >16 ACK bytes, `ACK_FORENSIC` preserves the first 16 plus the first
  extra byte and returns `ACK_REJECT overflow` without Go-CART.
* No change to the compile-time B TX lock, no new vehicle request or retries.

**Do not rerun the previous firmware on the vehicle.** Turn ignition off,
disconnect the interface from the ECU before flashing, then verify identity
and receive-ISR lifecycle over USB. Reconnect only the already proven MAX487
wiring with the GPIO loopback jumpers removed. If a new user-authorized
reference capture aborts, save its evidence and stop; do not auto-retry.

The proven V5 on-vehicle reference receiver used UART2 and recorded 970
reference-compatible ID-only frames. An **isolated USB GPIO loop test**
on UART1 (`20261102T192700035926Z-uart-edge-bench.txt`, SHA256
`70b3611493d04e7a49eefe8e210599ffda94fdde7af0b9fb2946795068e6689e`)
recorded 8/8 bytes and GPIO edge events in both timeout modes, without UART
errors or a byte-late FIFO timestamp. This **does not certify timing on the
vehicle differential physical layer**.

V1 in this directory changes only the 9600 baud CART receiver from UART2 to
UART1, still on GPIO16. Reference handshake uses 2400-baud UART2 (GPIO17 DI),
and the MAX487 DE on GPIO18. The firmware does **not** send read-code B or any
other CART command. B remains compile-locked and ECU DTCs remain unverified.

USB-only checks after a successful upload:

```sh
./.venv/bin/python scripts/sme105_uart1_session.py --port /dev/ttyUSB0 --action status
./.venv/bin/python scripts/sme105_uart1_session.py --port /dev/ttyUSB0 --action rx-isr-selftest
```

**Before connecting to the vehicle:** remove BOTH GPIO17→GPIO16 and
GPIO17→GPIO19 isolated loopback jumpers. Turn off ignition while reconnecting
the existing tested MAX487 RX/DI/DE/GND setup. Never leave a jumper from TX2
to RX2 while the external MAX487 receiver is attached; outputs can contend.
GPIO19 is not used by this receiver. No change in automotive power wiring.

For an operator-controlled one-time reference capture (not a stored-code read):

```sh
./.venv/bin/python scripts/sme105_uart1_session.py --port /dev/ttyUSB0 --action capture-cart-once
```

This command asks for the exact `CAPTURE_CART_ONCE` operator confirmation.
If the handshake fails or the vehicle UART1 sample is not valid, **do not retry
automatically**. Keep the original evidence and restore stable V5 when needed.

After a successful UART1 ID-only sample, `scripts/analyze_timed_dtc.py`
accepts 1–3 byte partial **next-frame sync** endings only when matching
00-prefix bytes and the next 10 ms frame cadence; it preserves the original
capture and refuses any other trailing bytes. On the 2026-11-02 UART1 car
capture (SHA256 `c0bc2f6922525e13263ad4957581c85a799182dfdbfcaeb76ddb80a376779aeb`),
the sample was 996 full ID frames + one next-sync `00`. The nominal slot-1
lead after the fourth ID byte was 415–418 µs across 252 headers of IDs0..3.
**This margin is software ISR observation, not proven safe DE/TX timing.**

### Optional one-shot timer-only field test (no B transmitted)

The same **already flashed** UART1 firmware supports `PLAN_B_ONCE`. This
explicitly repeats the two reference handshake frames, records one full
ID0..15 baseline, then asks TIMERG0/T1 to fire four ID0–3 *inert* timing
alarms during the following cycle. No data are added to the CART transmit
FIFO, and the B opcode compile lock stays in force. Only if the operator
chooses to validate the timer on the connected vehicle, and only with the
original tested wiring (no GPIO loopback jumpers), run:

```sh
./.venv/bin/python scripts/sme105_uart1_session.py --port /dev/ttyUSB0 --action plan-b-once
```

Type the exact `PLAN_B_ONCE` confirmation. Save the Evidence path; `COMPLETE`
with `scheduled=4 fired=4` would prove only on-device hardware timer dry-run.
It would **not** authenticate an ECU, read any stored fault codes, or qualify
active UART TX/DE turnaround. A `FAILED`/`SEEK`/`INCOMPLETE` means stop and
analyze the raw evidence, **no automatic retries**.

For restoration to V5 after experiments:

```sh
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot \
    -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_timed_session.py --port /dev/ttyUSB0 --action status
```
