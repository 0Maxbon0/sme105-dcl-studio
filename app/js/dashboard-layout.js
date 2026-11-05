import { ALL_LIVE_PIDS, LIVE_PIDS, LIVE2_PIDS, LIVE3_PIDS, AUTOMATIC_PIDS, PIDS } from './pids.js';
import { sensorsForGroup } from './live-dashboard.js';

// Hidden from this vehicle's dashboard, never removed from decoding or exports.
export const HIDDEN_DASHBOARD_CHANNELS = new Set([...AUTOMATIC_PIDS, 'MAP', 'MAP_FREQ', 'EGRDC', 'IEGR', 'INDS', 'IOCC']);
export const DASHBOARD_DEFAULTS = Object.freeze({
  LIVE: ['N', 'ECT', 'VBAT', 'ITP', 'ACT', 'LOAD', 'IEGO1', 'FUELPW1'],
  LIVE2: ['N', 'DSDRPM', 'ISCDTY', 'ITP', 'RATCH', 'VBAT'],
  LIVE3: ['N', 'MAF', 'VBAT', 'SAFTOT', 'VSBAR'],
  ALL: ['N', 'ECT', 'VBAT', 'ITP', 'MAF', 'IEGO1', 'FUELPW1', 'LOAD'],
});
const SETS = { LIVE: LIVE_PIDS, LIVE2: LIVE2_PIDS, LIVE3: LIVE3_PIDS, ALL: ALL_LIVE_PIDS };
export function dashboardChannels(variant = 'ALL') {
  return [...new Set((SETS[variant] || SETS.ALL).map(pid => PIDS[pid]?.[0]).filter(name => name && !HIDDEN_DASHBOARD_CHANNELS.has(name)))];
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
    layouts[variant] = cleanLayout(Array.isArray(saved) ? saved : legacy || DASHBOARD_DEFAULTS[variant], variant);
  }
  return { layouts, density: value.density === 'compact' ? 'compact' : 'comfortable' };
}
export function dashboardSensors(group, variant) {
  const allowed = new Set(dashboardChannels(variant));
  return sensorsForGroup(group === 'overview' ? 'advanced' : group, { manual: false }).filter(sensor => allowed.has(sensor.name));
}
export function reorderedPins(pins, name, target) {
  const from = pins.indexOf(name), to = pins.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...pins];
  const next = [...pins]; next.splice(from, 1); next.splice(to, 0, name);
  return next;
}
