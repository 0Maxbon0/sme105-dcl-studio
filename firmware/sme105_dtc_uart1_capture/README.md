# Experimental UART1 receiver for SME-105 CART (read only after reference handshake)

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
automatically**. Keep the original evidence and restore stable V5 when needed:

```sh
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot \
    -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_timed_session.py --port /dev/ttyUSB0 --action status
```
