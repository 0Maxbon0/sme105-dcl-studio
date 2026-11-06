/** UI text only. Native values, chart points and exports retain their precision. */
import { dashboardReading } from './throttle-display.js';

export function formatMeasurement(name, value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  // Speed always shows tenths, including zero, in either supported unit system.
  if (name === 'VS' || name === 'VSBAR') return value.toFixed(1);
  const integer = name === 'THROTTLE_PERCENT' || ['A/D', 'counts', 'bits', 'byte', 'rpm', 'ticks'].includes(unit);
  // Battery steps are 1/16 V; lambda and adaptive correction benefit from hundredths.
  const precise = (name === 'VBAT' && unit === 'V') || (name === 'LAMBSE1' && unit === 'lambda') || (name === 'KAMRF1' && unit === '% correction');
  const text = value.toFixed(integer ? 0 : precise ? 2 : 1);
  return String(Number(text));
}
export function formattedReading(name, value, options = {}) {
  const reading = dashboardReading(name, value, options);
  return { ...reading, text: formatMeasurement(name, reading.value, reading.unit) };
}
export function formatReplayTime(seconds) {
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : '—';
}
