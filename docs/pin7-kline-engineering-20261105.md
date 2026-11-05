# Pin 7 K-Line: source review and hardware-disabled integration

Software source review, 2026-11-05. This is a purchasing/design basis, **not an approved vehicle installation schematic**. Exact VIN routing, protective-device coordination and electrical measurements remain prerequisites. No K-Line hardware has been installed or enabled.

## Published evidence and limitations

The published [Escort 1998–2000 diagram collection](https://zanotowane.pl/1029/4146/) identifies C3020/7 as ISO9141; EEC-IV/PATS variants route toward C915/49. It is a third-party reproduction, not verification of this ECU harness. The [Ford forum recovery](https://www.ford-forum.de/threads/obd-2-buchse-und-zuendspulenfehler.185090/) is supporting historical context, not authority for this VIN. Obtain the applicable factory diagram before wiring. Pin 7 is neither DCL nor STO. Existing DCL pins 3/11 remain separate. Central locking is fitted; independent module addressability is unknown. ABS is absent. No PATS services are implemented.

The [ST L9637 Rev 8 datasheet](https://www.st.com/resource/en/datasheet/l9637.pdf), pp.3–6, specifies RX=1, LO=2, VCC=3, TX=4, GND=5, K=6, VS=7, LI=8. VS operates at 4.5–36 V; 40 V is a limited transient rating. VCC is specified at 3–7 V, with testing at 5 V and full-range compliance guaranteed by design. RX is pulled toward VCC. Thus a 5 V implementation is not directly safe for ESP32 inputs; 3.3 V operation requires checking the actual board circuit and measured output. Device protection alone does not qualify a complete automotive supply.

[MIKROE-4331 ISO9141 Click](https://www.mikroe.com/iso-9141-click) provides selectable logic supply and a separate VS terminal. Its [v101 schematic](https://download.mikroe.com/documents/add-on-boards/click/iso_9141_click/iso-9141-click-schematic-v101.pdf) was visually reviewed: JP1 selects VCC; the K net has a 4.7 kΩ pull-up to VS and 1 nF to ground. These load the vehicle even without TX and require qualification. Trace U1 pin 1 to the actual header; do not infer signal direction from ambiguous TX/RX header names. The breakout lacks a complete automotive input-protection chain.

## Purchase list and engineering acceptance criteria

- One genuine MIKROE-4331, or a documented E-L9637D implementation with separately supplied VS and verified 3.3 V logic. Do not substitute an undocumented 5 V-only board.
- An automotive-rated protected supply front end for **transceiver VS only**: fused input, reverse-polarity protection, coordinated transient suppression, decoupling and fault-current limiting. Fuse and TVS part/rating selection must follow the actual cable, maximum clamping voltage/current, thermal dissipation and applicable transient tests. A generic “12 V module” is insufficient. Clamp must remain within the transceiver ratings under worst-case tolerances; do not select a TVS solely by its nominal voltage.
- A keyed, strain-relieved diagnostic breakout/harness and insulated enclosure with test points, rated wiring and fuse holder. No exposed jumpers as the finished automotive assembly.
- A qualified ground/reference interface and equipment for isolated voltage/continuity checks. USB isolation or an independently powered isolated interface may be necessary depending on the laptop/vehicle ground arrangement; verify the complete isolation boundary rather than adding an arbitrary ground wire.
- A safe laboratory supply and scope/logic probe suitable for checking logic-high voltage, recessive boot state, protection behavior and receiver loading **off vehicle** first.

The MAX487 and BSS138 already owned are not K-Line transceivers. Neither may connect to Pin 7. ESP32 and laptop stay USB powered; never power them from DLC Pin 16.

## Intended architecture, not wiring authorization

```text
Future qualified DLC7 path -> automotive ESD/protection -> L9637 K
Future approved vehicle reference -> protected common reference -> L9637 GND
Future protected/fused vehicle-side VS -> L9637 VS only
USB-derived, qualified 3.3 V logic -> VCC; independently verify RX high level
L9637 RX -> qualified, future receive backend (candidate GPIO19)
L9637 TX -> recessive hardware bias, no ESP32 TX wire in this RX-only design
USB -> ESP32/laptop power; no Pin16 connection to USB/ESP32 power
```

If Pin16 is later chosen for transceiver VS, the protection front end and ground strategy must first be reviewed on the actual assembly. No connection is made in this task. Do not add an active tester pull-up without qualifying the existing bus loading. L/LI is not a substitute for STO and is not connected by this design.

## Peripheral allocation and fail-closed implementation

UART0 is USB/logging, UART1 is DCL RO/GPIO16, UART2 is DCL DI/GPIO17 and physical pad witness. GPIO18/RMT2–5 is DE timing; other RMT resources serve existing safety/handshake/pad functions. No fourth UART is available. Source search found no GPIO19 peripheral allocation. GPIO19 is **candidate-only**, not configured, driven or attached to interrupts.

The delivered `kline_rx.h` is a portable bounded RX/edge model with its own session counter, uint32-to-uint64 clock unwrapping, error/overflow accounting, explicit simulation entry points and no electrical backend. `KLINE_HW_ENABLED=0` and `KLINE_TX_ENABLED=0` are compile-time enforced: attempting to enable either fails compilation. A future RX backend must first undergo a resource/timing design review; no concurrency claim is made for an unimplemented GPIO edge ISR.

Android independently imports tagged ASCII/JSONL or binary captures, preserves bytes/edges and timestamps, stores history in the durable journal and exports CSV/ZIP. Binary input has synthetic byte-index timestamps, not measured baud or timing. Supplied framing/protocol fields remain claims; no keyword, address, module, fault code or service is inferred. Passive silence alone is expected and is not ECU failure. No five-baud/fast initialization, wake-up, raw TX, address scans, retries, PATS programming or central-lock actuation exists in this subsystem.

## Review outcome

The software abstraction is suitable for offline testing while hardware is absent. Vehicle electrical deployment remains blocked by missing transceiver/protection hardware, the exact harness/schematic review, ground and loading qualification, and a resource-safe RX backend. The owner separately authorized uploading the repaired **DCL** firmware; that does not authorize K-Line wiring or activation.
