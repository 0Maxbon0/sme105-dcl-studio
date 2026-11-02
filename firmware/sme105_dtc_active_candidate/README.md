# Unreleased CART B active request candidate — isolated bench only

This directory is separate from the previously flashed safe firmware.
ESP32 DevKit V1 / MAX487: RO=GPIO16, DI=GPIO17, DE=GPIO18. The default
firmware **does not transmit B**. Attempting to compile with
`-DSME105_ACTIVE_B_TX=1` deliberately fails with `#error` until timing,
collision and external electrical protection have been demonstrated on a
protected differential bench with a logic analyzer. **Do not flash it or
connect it to a vehicle.**

The substantive but hardware-unverified active implementation is present in
`sme105_dtc_active_candidate.ino` and is compiled into an inert default build:

* An operator would select exactly one `BENCH_B_A4_ONCE` or
  `BENCH_B_0E_ONCE`. Both return `DENIED COMPILE_LOCK` in this build.
* A candidate active attempt requires 2400 baud/8N2 `Echo ID` followed by
  an exact 11-byte self-echo plus `01` candidate ACK, then `Go CART`.
* UART2 9600 baud/8N1 RX FIFO ISR timestamping searches for ID0 and then
  requires 16 consecutive valid ID0..15 frames with correct parity, stable
  0/4-bit header phase, 10ms cadence, and no UART error/coalesced RX.
* The next cycle's ID0, ID1, ID2 and ID3 headers arm a 1MHz timer for
  slot1. Its ISR would assert DE and put exactly two fixed allowlisted bytes
  in UART2 TX FIFO: `01 B0`, `FF 5F`, `26 A4` or `26 0E`, `00 A0`.
* A second hardware timer deasserts DE after 2250us regardless of UART
  task scheduling. A UART TX_DONE ISR normally drops DE earlier after both
  stop bits; strict byte-for-byte local RX echo and device-side 9600 baud
  completion timestamps must agree before allowing the next word.
* Any failure prevents subsequent B words; after the fourth verified word,
  no further B TX can be queued. Raw timestamped `CART_EVT` bytes continue
  to be captured. Only all-four-word echo plus TX_DONE completion qualifies
  the informational `CART_TX` witness; incomplete attempts are reported
  under `CART_TX_ATTEMPT`.

No clear-codes, KOEO self-test, actuator, generic PID, arbitrary write or
repeat-TX command exists. The only other explicitly invoked bus command is
`OBSERVE_CART_ONCE` using the existing reference handshake and passive CART
capture. Boot/STATUS/HELP never transmit on the vehicle bus.

## Software-only evidence

```sh
./.venv/bin/python firmware/sme105_dtc_active_candidate/verify_active_model.py
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_active_candidate
```

On 2026-11-02, the native host C++11 synthetic state-machine tests passed
**11/11**, and the ESP32 Arduino 2.0.17/IDF 4.4 firmware compiled and linked
with `-mtext-section-literals` (RAM 87,256 bytes; flash 276,521 bytes).
Deliberate attempted active-B compile must fail with `#error`.

This is **software verification only**. It cannot prove interrupt jitter,
relative timer phase, correct DE turn-on/turn-off, RX echo provenance,
collision-free operation, 2250us cutoff, four-slot alignment or ECU
compatibility without isolated-harness differential waveform measurements.
The conflicting `26 A4` and `26 0E` variants are both experimental. There
are no authenticated Ford SME-105 responses or verified DTCs.
