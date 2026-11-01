# Desk bench test (ESP32 + XY-K485)

Standalone hardware self-test. It is not sniffer firmware and must not be on
the ESP32 when the adapter is connected to a vehicle.

The first sketch version drove A+ only and tied **B− to GND**. That collapses
the UART start bit (A≈B≈0 V), so every loop failed. This sketch drives a real
differential pair:

- GPIO4 = UART TX → A+
- GPIO21 = inverted UART TX → B−

Re-flash `firmware/passive_binary` before any car session.

## Bench wiring (no vehicle)

Leave the K485 A+/B− leads off the car, OBD, and any other bus. **Do not**
connect B− to ground.

| From | To | Note |
|---|---|---|
| Laptop USB | ESP32 USB | Host serial only |
| ESP32 **3V3** | K485 **VCC** | Not 5V/VIN |
| ESP32 **GND** | K485 UART **GND** and K485 bus **GND** | Common reference |
| K485 **TXD** (RO) | ESP32 **GPIO16** (RX2) | Receiver return |
| K485 **RXD** (DI) | ESP32 **3V3** via 10 kΩ | Idle-high so auto-direction stays receive |
| ESP32 **GPIO4** | **1 kΩ** then K485 **A+** | Non-inverted UART |
| ESP32 **GPIO21** | **1 kΩ** then K485 **B−** | Inverted UART |
| ESP32 **GPIO17** | *nothing* | Sniffer TX stays disconnected |

If the module has a 120 Ω termination jumper, leave it **open**.

```text
Laptop USB ──► ESP32 DevKit V1
                 3V3 ──────────────► K485 VCC
                 GND ──────────────► K485 GND (both sides)
                 GPIO16 RX2 ◄────── K485 TXD (RO)
                 GPIO17 TX2         (no wire)
                 GPIO4  ── 1 kΩ ──► K485 A+
                 GPIO21 ── 1 kΩ ──► K485 B-
                 3V3 ── 10 kΩ ──► K485 RXD (DI)
```

If TXD/RXD labels on the clone are MCU-centric (TXD = “connect MCU TX”), then
put K485 **TXD** on GPIO16 still only if that pin is the **RO output**. The RO
pin is the one that wiggles when A/B are stimulated and DI is high. If MCU
UART self-test PASSes and the physical test stays `(none)`, swap the TTL TXD
and RXD wires.

## Visual cues

- ESP32 power LED on after USB enumerate.
- K485 power LED on if the clone has one.
- K485 **RX** LED (RO/TTL) should blink about once per second.
- TX LED should stay dark (DI held high).
- Heat, smell, or a warm 1 kΩ resistor: unplug USB immediately.

## Flash and watch

In Diagnostic Studio: **Desk Bench Test** → confirm car is disconnected →
**Upload** → **Start serial monitor**.

Or:

```bash
pio run --project-dir firmware/bench_test --target upload --upload-port COM7
```

## Validation

On boot the sketch prints `MCU UART self-test: PASS` or `FAIL` (internal
GPIO4→UART2, no K485). Then once per second:

**Pass**

```text
MCU UART self-test: PASS
LOOP 1  polarity=normal  TX: A5 5A 00 FF 55 AA 01 00
         RX: A5 5A 00 FF 55 AA 01 00  (8 bytes)
RESULT: PASS  XY-K485 receiver + UART2 path intact
```

Ten consecutive physical PASS lines means the K485 receiver path is intact for
this desk differential stimulus. It does not prove vehicle DCL polarity.

**MCU UART FAIL** — sketch/UART2 problem; re-upload. Do not debug the K485 yet.

**Physical RX: (none)** while MCU PASSes — 3V3, GND, TXD→GPIO16, both 1 kΩ
leads, RXD idle-high, 120 Ω open.

**Physical RX hex ≠ TX** — the sketch swaps A/B polarity on the next loop. If
it then PASSes, keep that wiring. If it never PASSes, TXD/RXD silk is swapped
or the module is 5 V-only; move VCC only after confirming RO is 3.3 V.
