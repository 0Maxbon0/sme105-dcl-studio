"""Minimal BLE line client for the SME105 bridge (Nordic UART Service).

Pairing (once, Linux/BlueZ):  bluetoothctl -> agent KeyboardOnly ->
default-agent -> scan on -> pair <MAC> -> enter the PIN printed by the
bridge's USB-only ``BLE_PIN`` command. Afterwards this client connects to the
bonded device, subscribes to TX notifications and sends each command line.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time

from bleak import BleakClient, BleakScanner

NAME = "SME105-DCL"
RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # phone -> bridge (write)
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # bridge -> phone (notify)


async def run(commands: list[str], wait: float, address: str | None) -> int:
    device = (await BleakScanner.find_device_by_address(address, timeout=10.0) if address
              else await BleakScanner.find_device_by_name(NAME, timeout=10.0))
    if device is None:
        print(f"{NAME} not found", file=sys.stderr)
        return 2
    received = bytearray()

    def on_notify(_sender: object, data: bytearray) -> None:
        received.extend(data)
        while b"\n" in received:
            line, _, rest = received.partition(b"\n")
            print(f"{time.monotonic():.3f} < {line.decode(errors='replace').rstrip()}", flush=True)
            received[:] = rest

    async with BleakClient(device) as client:
        print(f"connected {device.address} mtu={client.mtu_size}", flush=True)
        await client.start_notify(TX, on_notify)
        for command in commands:
            if command.startswith("sleep:"):
                await asyncio.sleep(float(command.split(":", 1)[1]))
                continue
            print(f"{time.monotonic():.3f} > {command}", flush=True)
            await client.write_gatt_char(RX, (command + "\n").encode(), response=True)
            await asyncio.sleep(0.4)
        await asyncio.sleep(wait)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commands", nargs="*", default=["HELLO", "STATUS", "BLE_STATUS"],
                        help="command lines; 'sleep:<s>' pauses")
    parser.add_argument("--wait", type=float, default=2.0, help="seconds to keep listening")
    parser.add_argument("--address", help="bonded device MAC (skip name scan)")
    args = parser.parse_args()
    return asyncio.run(run(args.commands, args.wait, args.address))


if __name__ == "__main__":
    raise SystemExit(main())
