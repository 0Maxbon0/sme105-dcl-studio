# SME-105 CART plan attempt — captured ESP32 panic and correction (2026-11-02)

## Immutable vehicle-session evidence

* Source: `captures/TIMED_CART/20261102T181943265142Z-cart-isr.txt`
* SHA256: `7d52258ea15b0476f45939d19552b91dc443912d7822fe261bef96c15087eec8`
* 1,759 bytes; 39 lines. Leave original unchanged.
* Reference transmission reported complete for Echo-ID and Go-CART, with
  `cutoff=0`; receive was the documented 11-byte local echo plus candidate
  `01` ACK. There are **no CART_EVT records** and **no DTCs**.
* Immediately after Go-CART, ESP32 core 1 panicked with `StoreProhibited`,
  `EXCVADDR=0x00000008`, then rebooted. The sequence appears twice in the
  saved evidence. Do not infer two separately authorized operator commands.

## Symbolicated root cause

The crash log identifies ELF SHA256 starting `dbb651825bd68d10`.
The matching local old ELF had full SHA256:

`dbb651825bd68d1041b6ffccb8453b95adf4f9d28768e6b9932723bfe6348865`

Its Xtensa `addr2line -a -f -C` report:

| PC | Function / source |
| --- | --- |
| `0x400d6ca5` | `uart_isr_register`, IDF `driver/uart.c:637` |
| `0x400d1b63` | `captureOnce(bool)`, `sme105_dtc_one_shot.ino:269` |
| `0x400d2151` | `loop()`, `sme105_dtc_one_shot.ino:434` |
| `0x400d3c69` | `loopTask(void*)`, Arduino `main.cpp:50` |

`HardwareSerial::end()` deletes the UART2 IDF driver object, then the code
called driver-dependent `uart_isr_register()`. The fault address `0x8` is
consistent with dereferencing a null driver object. This is a **firmware
integration crash**, not evidence that the SME-105 refused read-codes.

## Fix status and bench verification

* Corrected safe firmware **V2** registers a native RX interrupt using
  `esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM, ...)` and frees
  it via `esp_intr_free()`. This does not depend on the removed UART driver.
* The isolated, default compile-locked B prototype received the same UART
  lifecycle fix because it contained the identical failure path.
* The safe firmware adds `SELFTEST_RX_ISR`, with `DE=LOW`, no vehicle UART
  transmit, a 40 ms RX interrupt initialization test and clean removal.
* Host refuses older V1 status identity and recognizes `Guru Meditation`
  as an immediate incomplete session, preserving the backtrace instead of
  waiting for a generic 60-second timeout.
* Build/tests can confirm compilation and software invariants. **Only**
  running the new selftest on the physical ESP32 (with A/B disconnected)
  confirms this particular interrupt-allocation crash is absent. It does
  not prove a working vehicle CART capture or DTC read.

## Exact next hardware operation — with A/B disconnected

Turn ignition off and physically disconnect the adapter's differential
A/B from vehicle pins 3/11 before USB flashing or bench tests. Run from the
repository root:

```bash
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot \
  -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_timed_session.py \
  --port /dev/ttyUSB0 --action status
./.venv/bin/python scripts/sme105_timed_session.py \
  --port /dev/ttyUSB0 --action rx-isr-selftest
```

Require `STATUS SME105_DTC_ONE_SHOT_V2` and `RX ISR SELFTEST PASS` with no
reboot. B still compile-locked. Any next ECU session must be separately
evaluated for electrical protection and wiring integrity, and cannot be
declared DTC extraction in this state.
