# USB-isolated UART timing bench (never vehicle firmware)

The known-safe on-vehicle firmware is `firmware/sme105_dtc_one_shot`, V5.
This separate build has no handshake or ECU B request and is **not** qualified
to connect to a car. It tests the FIFO threshold one-byte lag in a real
ESP32 using a **3.3 V** physical TX/RX loop with a separate timestamp trace.

With ignition OFF and MAX487 + every car cable **completely disconnected**
from ESP32, use **two 1k series resistors** (470 ohm–4.7k acceptable):

- ESP32 GPIO17 (local UART2 TX) to GPIO16 (UART1 RX), series 1k.
- ESP32 GPIO17 to GPIO19 (GPIO edge timestamp), series 1k.
- Common ground is already the ESP32 ground; no extra power or car pins.
- GPIO18 is always LOW. Do not attach MAX487 for this bench.

```bash
./.venv/bin/python -m platformio run -d firmware/sme105_uart_edge_bench -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_uart_edge_bench.py --port /dev/ttyUSB0 --action status
./.venv/bin/python scripts/sme105_uart_edge_bench.py --port /dev/ttyUSB0 --action pins
./.venv/bin/python scripts/sme105_uart_edge_bench.py --port /dev/ttyUSB0 --action bench
```

The pin check is repeatable; it reports actual GPIO17, GPIO16, GPIO19
idle-high levels and sends **no test bytes**, including if the jumper
preflight fails. A failed bench consumes the one-shot per boot, so diagnose
wiring with `--action pins` before trying the bench again after a reset.

Type `BENCH_GPIO_ONCE` when prompted by the bench command. Evidence is recorded in
`captures/ISOLATED_GPIO`. Runs two locally generated eight-byte tests at
9600 8N1: UART1 RX FIFO threshold 1 without timeout, and threshold 1 plus
UART RX timeout. The GPIO19 edge ISR records independent RX logic transitions
with microsecond timestamps, **not** logic-analyzer grade bus metrics.

The bench cannot prove vehicle electrical levels, DE turnaround, collision
handling or which `26 A4`/`26 0E` B request the SME-105 accepts.

After the bench, disconnect both jumpers and **restore V5 before any future
vehicle connection**:

```bash
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_timed_session.py --port /dev/ttyUSB0 --action status
```
