# Wiring and electrical safety

## Non-negotiable limits

- Establish a common reference between the interface signal ground and car
  ground at the approved diagnostic ground point.
- Do not use OBD connector pin 16 to power this project, the laptop, an ESP, or
  the transceiver. Use isolated or separately fused, regulated power suitable
  for the interface design.
- Do not infer DCL A/B polarity from RS-485 labels. Vendor A/B naming is not
  consistent. Record both the connector pin and transceiver terminal.
- Do not connect a bare MCU UART directly to either DCL conductor.
- Do not blindly add a 120 ohm termination resistor. The vehicle network may
  already contain its required loading, and DCL is not proven to require a
  standard RS-485 end termination at the diagnostic adapter.
- Do not probe, connect, disconnect, or move wiring near belts, fans, exhaust,
  ignition components, or a running engine.
- Stop immediately for heat, odour, smoke, visible arcing, USB disconnects,
  unstable engine operation, unexpected actuator movement, or a ground lead
  that becomes warm.

## Before any connection

1. Ignition off, key removed, engine stopped, transmission in park/neutral,
   parking brake applied, wheels chocked, and accessories off.
2. Identify the exact SME-105 ECU/diagnostic connector from vehicle-specific
   documentation. Public reports about other EEC-IV ECUs are not a pinout for
   this vehicle.
3. Inspect for damaged insulation, loose terminals, corrosion, and previous
   wiring modifications.
4. Ensure the laptop and interface cannot be powered accidentally from OBD
   pin 16.
5. Verify that the selected adapter mode cannot enable its transmitter during
   connection or host boot.
6. Connect car ground first and disconnect it last.
7. Make signal connections only with ignition off.

## XY-K485: receive-only phase

Treat the XY-K485 only as an experimental receive front end, not as an
approved DCL master.

- Connect car ground to the module signal ground.
- Connect only the candidate differential pair after the vehicle pinout is
  independently identified.
- Keep the module's transmit-data input in a defined inactive-high state. Do
  not leave TX floating, and do not connect software that can toggle it.
- Ensure the module remains receive-only for the whole session. If its
  automatic-direction circuit can drive the bus from TX activity, physical
  isolation or a proven inactive-high bias is required before connection.
- Record which vehicle wire went to A and B. If polarity is reversed for a
  second test, switch ignition off first and create a new session record.
- A passive capture may be completely silent because DCL appears to operate as
  request/response. Silence is not permission to start transmitting.

An XY-K485 module's clone, schematic revision, voltage tolerance, idle state,
and input pull-ups can vary. Visual similarity to an online module is not
electrical validation.

## Requirements for an active master

Active requests require a purpose-built interface with:

- a transceiver explicitly compatible with 3.3 V MCU logic;
- explicit, independently controlled driver enable (`DE`) and receiver enable
  (`/RE`) rather than an opaque auto-direction circuit;
- a boot/reset state that disables the driver;
- defined fail-safe input states;
- current limiting and vehicle-transient protection appropriate to the
  installation;
- a common signal reference or engineered isolation;
- software-enforced maximum request length, repetition rate, and session
  timeout;
- a physical method to remove bus drive immediately;
- verified A/B polarity and idle differential voltage;
- a documented reason for every request word.

Do not commission active mode solely because an RS-485 USB adapter can open at
9600 or 19200 baud. The public reference project states that ordinary
USB-to-RS-485 timing may be insufficient and uses a controller as a buffer.

Driver sequencing must be explicit: enable the receiver as designed, enable
the driver only for the bounded request, wait for the final stop bit to leave
the transceiver, disable the driver, and return to receive mode. Timing values
remain **Unknown** until measured and validated on SME-105.

## Termination and bias

Do not add 120 ohms as a generic cure for missing data. First establish:

- existing resistance and bias with the vehicle powered down;
- cable topology and diagnostic-stub length;
- transceiver input loading;
- idle differential voltage and waveform quality;
- whether the vehicle's DCL physical layer actually matches standard RS-485
  termination assumptions.

Adding termination without those measurements can overload the ECU driver or
change the idle state. Bias resistors can also contend with vehicle biasing.

## No-test-equipment restriction

Without at least a suitable multimeter and, for active work, an appropriate
oscilloscope or logic-capture arrangement, electrical assumptions cannot be
checked. Work is therefore limited to:

- ignition-off visual inspection and documented pin identification;
- a receive-only adapter whose transmitter is physically prevented from
  driving;
- KOEO (key on, engine off) sessions;
- short, bounded captures with an operator at the key;
- immediate abort on any anomaly;
- restoration to the original disconnected state after each run.

No active-master request, KOER experiment, termination change, improvised
power connection, or sensor simulation is allowed under the no-test-equipment
restriction. Passive silence is an acceptable result.

## Restoration

1. Stop capture and close the serial port.
2. Ignition off; wait for ECU and relays to power down.
3. Disconnect DCL signal conductors.
4. Disconnect project power, if separately supplied.
5. Disconnect car ground last.
6. Restore connector locks, insulation, and any unplugged sensor.
7. Start a fresh visual check before normal vehicle operation.

