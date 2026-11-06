import { ALL_LIVE_PIDS, LIVE_PIDS, LIVE2_PIDS, LIVE3_PIDS, AUTOMATIC_PIDS, PIDS } from './pids.js';
import { sensorsForGroup } from './live-dashboard.js';

// Hidden from this vehicle's dashboard, never removed from decoding or exports.
export const HIDDEN_DASHBOARD_CHANNELS = new Set([...AUTOMATIC_PIDS, 'MAP', 'MAP_FREQ', 'EGRDC', 'IEGR', 'INDS', 'IOCC']);
export const DASHBOARD_DEFAULTS = Object.freeze({
  LIVE: ['THROTTLE_PERCENT', 'N', 'ECT', 'VBAT', 'ITP', 'ACT', 'LOAD', 'IEGO1', 'FUELPW1'],
  LIVE2: ['THROTTLE_PERCENT', 'N', 'DSDRPM', 'ISCDTY', 'ITP', 'RATCH', 'VBAT'],
  LIVE3: ['N', 'MAF', 'VBAT', 'SAFTOT', 'VSBAR'],
  ALL: ['THROTTLE_PERCENT', 'N', 'ECT', 'VBAT', 'ITP', 'MAF', 'IEGO1', 'FUELPW1', 'LOAD'],
});
const SETS = { LIVE: LIVE_PIDS, LIVE2: LIVE2_PIDS, LIVE3: LIVE3_PIDS, ALL: ALL_LIVE_PIDS };
export function dashboardChannels(variant = 'ALL') {
  const names = [...new Set((SETS[variant] || SETS.ALL).map(pid => PIDS[pid]?.[0]).filter(name => name && !HIDDEN_DASHBOARD_CHANNELS.has(name)))];
  return names.includes("ITP") ? ["THROTTLE_PERCENT", ...names] : names;
}
export function cleanLayout(names, variant) {
  const allowed = new Set(dashboardChannels(variant));
  return [...new Set(names)].filter(name => allowed.has(name));
}
export function normalizeDashboardPrefs(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const layouts = {};
  for (const variant of Object.keys(SETS)) {
    const saved = value.layouts?.[variant];
    const legacy = variant === 'ALL' && value.pins?.length ? value.pins : null;
    const names = Array.isArray(saved) ? saved : legacy || DASHBOARD_DEFAULTS[variant];
    // The formerly fixed card was always present. Migrate once; v2 removals stay removed.
    layouts[variant] = cleanLayout(value.version === 2 ? names : ['THROTTLE_PERCENT', ...names], variant);
  }
  return { version: 2, layouts, density: value.density === 'compact' ? 'compact' : 'comfortable' };
}
export function dashboardSensors(group, variant) {
  const allowed = new Set(dashboardChannels(variant));
  const sensors = sensorsForGroup(group === 'overview' ? 'advanced' : group, { manual: false }).filter(sensor => allowed.has(sensor.name));
  if (allowed.has('THROTTLE_PERCENT') && ['overview', 'advanced', 'engine'].includes(group)) sensors.unshift(dashboardSensor('THROTTLE_PERCENT'));
  return sensors;
}
export function reorderedPins(pins, name, target) {
  const from = pins.indexOf(name), to = pins.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...pins];
  const next = [...pins]; next.splice(from, 1); next.splice(to, 0, name);
  return next;
}

// Display descriptor only: never inserted into PIDS, ECU requests or raw archives.
export function dashboardSensor(name) {
  return name === 'THROTTLE_PERCENT'
    ? { name, title: 'Throttle', unit: '%', source: 'ITP', derived: true }
    : sensorsForGroup('advanced', { manual: false }).find(sensor => sensor.name === name);
}
