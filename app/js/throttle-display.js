/** Owner-defined throttle display range. Recorded ECU values stay unchanged. */
import { displayReading } from './pids.js';
export function throttlePercent(raw) {
  return Number.isFinite(raw) ? Math.round(Math.max(0, Math.min(100, 100 * (raw - 179) / (970 - 179)))) : null;
}
export function dashboardReading(name, value, options = {}) {
  return name === 'THROTTLE_PERCENT' ? { value: throttlePercent(value), unit: '%' } : displayReading(name, value, options);
}
