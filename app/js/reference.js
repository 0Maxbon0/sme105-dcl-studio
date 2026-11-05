/** Vehicle references reviewed 2026-11-05. A protocol domain is not a healthy band. */
export const IDLE_SOURCE = "https://workshop-manuals.com/ford/escort.orion_1991_08.1990-09.2001/mechanical_repairs/3_powertrain/329_engine_management/329-04_engine_management_zetec-zetec-e_engines/specificationsgeneral_specifications/";
export const VEHICLE_PROFILE = "1998 Escort 1.6 Zetec · manual · SME-105 / 97AB-12A650-KA (owner confirmed)";
const unknown = "Factory normal limits not verified for this ECU.";
const raw = "Physical conversion and factory normal limits not verified for this ECU.";

// Each entry has a range/reference plus an explanation of what rising/falling means.
export const READING_REFERENCES = {
  N: ["Regulated idle reference: 825–925 rpm (875 ± 50).", "Compare only at settled, fully warm idle, stationary in neutral, pedal released and loads off. Higher RPM during acceleration or warm-up is not a fault by itself."],
  DSDRPM: ["875 rpm is the published regulated idle reference, not a fixed target in every condition.", "The ECU may request a different idle during warm-up or extra load; compare actual RPM with its current target."],
  ECT: [unknown, "Rises as coolant warms. Lower is not always better. Warm-up, thermostat and fan operation matter; an operating band is not a sensor accuracy test."],
  ACT: [unknown, "Depends on ambient temperature and heat soak. A high raw intake input can accompany a substituted temperature; neither hotter nor colder is universally better."],
  IACT: [raw, "Raw IAT-related ECU channel, not degrees or another physical sensor. ACT and IACT changed 26.324 seconds apart in a preserved recording; calibration and fallback are unverified."],
  IECT: [raw, "Use the separate ECT channel in °C. The thermistor conversion is nonlinear; raw counts are retained for circuit diagnosis."],
  ITP: [raw, "Should respond smoothly to throttle movement. More counts describe a signal change, not better health. Percent opening needs verified closed/open endpoints."],
  RATCH: [raw, "The ECU's learned closed-throttle reference. Compare with throttle only while the pedal is released; there is no verified fixed difference limit here."],
  VBAT: [unknown, "Voltage varies during cranking, charging and electrical loads. Compare the ECU value with a battery measurement; a starting dip is not a running-voltage fault."],
  BP: [unknown, "Absolute outside pressure changes with altitude and weather. Higher or lower is not inherently better; compare against local absolute pressure, not sea-level corrected weather pressure."],
  MAP: [unknown, "If supported, manifold absolute pressure varies with throttle and engine load. Zero alone does not prove a fault or that a sensor is absent."],
  MAP_FREQ: [unknown, "Frequency is not pressure without the appropriate sensor curve. Confirm the channel is implemented before interpreting zero."],
  SAFTOT: [unknown, "Ignition advance depends on RPM, load and temperature. More advance is not always better; no fixed idle pass/fail band is established."],
  FUELPW1: ["Protocol resolution: 32 clock ticks per raw unit. Milliseconds are not verified.", "A larger command means more injector on-time in the same encoding. Fuel demand changes with load, temperature and battery voltage; there is no single normal pulse width."],
  LAMBSE1: ["1.00 is the stoichiometric command reference, not a universal healthy range.", "Below 1 commands richer; above 1 commands leaner. This is requested mixture, not measured exhaust mixture. Enrichment and deceleration require context."],
  IEGO1: [raw, "Count-to-voltage direction is unverified. High raw counts cannot be labelled rich. Evaluate signal response only with the sensor hot and the ECU's loop state known."],
  KAMRF1: ["0% displayed correction corresponds to factor 1.00. Factory allowed band not verified.", "Positive/negative values describe learned correction relative to unity. A fixed zero does not prove feedback is working; learning and loop state matter."],
  LOAD: [unknown, "Higher means greater calculated engine load, not a fault. Normal load depends on throttle, RPM and accessories; this is not accelerator percentage."],
  ISCDTY: ["Duty-cycle command, nominally 0–100%; this is not a normal idle band.", "Higher means more electrical on-time, not measured valve opening. Load and warm-up can change the command; neither end alone establishes valve health."],
  EGRDC: ["Duty-cycle command, nominally 0–100%; this is not a normal operating band.", "If this equipment/channel is supported, the value describes electrical command rather than measured EGR flow. Zero can be expected in some conditions."],
  IEGR: [raw, "Confirm EGR equipment and channel identity first. A changing input does not establish EGR valve opening or exhaust flow."],
  MAF: ["MAF sensor signal (PID 0x26), identified by the owner’s unplug/reconnect test. Physical scaling remains unverified; no normal airflow band assigned.", "The owner identified the tested connection as the MAF sensor. The ECU raw word is shown unchanged. This does not establish g/s, sensor volts, or engine health."],
  VS: ["Expected while stationary: 0 km/h. No universal healthy driving-speed band.", "Higher means faster travel. A stationary zero cannot verify road-speed calibration."],
  VSBAR: ["Expected while stationary: 0 km/h. Filtered speed may lag changes.", "Higher means faster travel; compare with VS and an independent speed reference before diagnosing a discrepancy."],
  FMEM_FLAGS: ["Bit flags, not a numeric normal range; bit meanings unverified for this ECU.", "A larger packed number is not more severe. Read individual bits with calibration-specific definitions and fault codes."],
  FMEM_FLAG2: ["Bit flags, not a numeric normal range; bit meanings unverified for this ECU.", "A set bit is not automatically a confirmed component fault; do not score the packed number as better/worse."],
  BITMAP_0: ["On/off states have no high/low normal band.", "Interpret each named switch/output in the corresponding vehicle condition. Packed numeric magnitude is meaningless as a health score."],
  BITMAP_1: ["On/off states have no high/low normal band.", "Closed-loop, A/C and other states depend on operation. Reference bit assignments still need corroboration on this exact calibration."],
  INDS: [raw, "A switch/input channel; do not label gear or neutral from its magnitude without a verified manual-car mapping."],
  IOCC: [raw, "Octane-adjust input if implemented. A larger number does not establish higher fuel octane or better fuel quality."],
  IVCAL: [raw, "Calibration/reference input, not battery voltage. Do not interpret it with a generic ADC volts formula."],
  APT: ["Reference states: -1 closed, 0 part throttle, 1 wide open.", "These are operating states, not percentages or a good/bad scale. Confirm that states follow the pedal on this ECU."],
  ATMR1: ["Elapsed seconds; no healthy upper or lower limit.", "Increases with the engine's key/start cycle according to the reference strategy. A larger number is not wear or a fault."],
  BCSDC: ["Not applicable to the owner's manual gearbox.", "Automatic torque-converter clutch command; preserve values as technical evidence without judging this car."],
  GR_CM: ["Not applicable to the owner's manual gearbox.", "An automatic commanded-gear channel; value 2 does not establish second gear in this car."],
  ETVOCM: ["Not applicable to the owner's manual gearbox.", "Reference name means transmission overcurrent-monitor voltage, not measured hydraulic pressure or selected gear."],
  TV_PRES: ["Not applicable to the owner's manual gearbox.", "Automatic-transmission pressure command; no manual-car health judgement is assigned."],
  ITOT: ["Not applicable to the owner's manual gearbox.", "Automatic transmission-temperature raw input; zero cannot establish actual gearbox oil temperature."],
  PDL: ["Not applicable to the owner's manual gearbox.", "Automatic range-selector channel; do not infer manual gear position from it."],
};

export function readingReference(name, { manual = true } = {}) {
  const entry = READING_REFERENCES[name];
  if (!entry) return { normal: unknown, meaning: "Interpretation is unverified." };
  const automatic = ["BCSDC", "GR_CM", "ETVOCM", "TV_PRES", "ITOT", "PDL"].includes(name);
  return {
    normal: automatic && !manual ? unknown : entry[0],
    meaning: automatic && !manual ? "Automatic-transmission reference channel. Confirm equipment and calibration before using a numeric limit." : entry[1],
    source: name === "N" || name === "DSDRPM" ? IDLE_SOURCE : null,
  };
}
