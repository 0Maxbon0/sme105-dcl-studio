/** Local display preferences only. Raw ECU readings and recordings are never modified. */
const KEY = 'sme105-tps-profiles-v1';
const SOURCE = 'Suggested from field recordings';
export function defaultTpsProfiles() {
  return { active: 'spare', profiles: {
    original: { name: 'Original TPS', freeRest: null, mountedClosed: null, maximum: null, status: 'unconfigured', source: '', updatedAt: null },
    spare: { name: 'Spare TPS', freeRest: 103, mountedClosed: 179, maximum: 970, status: 'suggested', source: SOURCE, updatedAt: '2026-11-06T00:00:00.000Z' },
  } };
}
export function validateTpsReferences(p) {
  for (const field of ['freeRest', 'mountedClosed', 'maximum']) if (!Number.isInteger(p?.[field]) || p[field] <= 0 || p[field] >= 1000) throw new Error('Enter integer references from 1 to 999; zero and saturation are not calibration endpoints.');
  if (!(p.freeRest < p.mountedClosed && p.mountedClosed < p.maximum) || p.maximum - p.mountedClosed < 50) throw new Error('Use free-rest < mounted closed < upper, with at least 50 counts of mounted travel.');
  return true;
}
export function stableTpsReference(samples, position) {
  const window = samples.filter(s => s.t <= position && s.t >= position - 2);
  if (window.length < 5 || window.at(-1).t - window[0].t < 1 || position - window.at(-1).t > 0.5) throw new Error('Choose at least one second of recent, stable ITP samples.');
  if (window.some((s, i) => !Number.isInteger(s.raw) || s.raw <= 0 || s.raw >= 1000 || (i && (s.t <= window[i-1].t || s.t - window[i-1].t > 0.75)))) throw new Error('Disconnected, saturated or interrupted samples cannot set a reference.');
  const values = window.map(s => s.raw).sort((a,b) => a-b);
  if (values.at(-1) - values[0] > 3) throw new Error('ITP is moving or noisy. Choose a stable position.');
  return Math.round(values[Math.floor(values.length / 2)]);
}
const clamp = n => Math.max(0, Math.min(100, n));
export function tpsPercent(raw, profile) {
  try { validateTpsReferences(profile); } catch { return { throttle: null, sensor: null }; }
  if (!Number.isInteger(raw) || raw <= 0 || raw >= 1000) return { throttle: null, sensor: null };
  return { throttle: clamp(100 * (raw - profile.mountedClosed) / (profile.maximum - profile.mountedClosed)), sensor: clamp(100 * (raw - profile.freeRest) / (profile.maximum - profile.freeRest)) };
}
export function createTpsProfiles(storage = globalThis.localStorage, now = () => new Date().toISOString()) {
  let state = defaultTpsProfiles();
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || 'null');
    if (saved?.profiles) {
      for (const id of ['original', 'spare']) if (saved.profiles[id]) {
        const p = saved.profiles[id];
        if (p.status === 'unconfigured') state.profiles[id] = { ...state.profiles[id], ...p, status: 'unconfigured' };
        else { validateTpsReferences(p); state.profiles[id] = { ...state.profiles[id], ...p, status: p.status === 'confirmed' ? 'confirmed' : 'suggested' }; }
      }
      state.active = ['original', 'spare', 'none'].includes(saved.active) ? saved.active : 'none';
    }
  } catch { state = defaultTpsProfiles(); }
  const persist = next => { if (!storage) throw new Error('Calibration storage is unavailable'); storage.setItem(KEY, JSON.stringify(next)); state = next; return state; };
  return {
    get state() { return state; },
    select(id) { if (!['original', 'spare', 'none'].includes(id)) throw new Error('Unknown TPS profile'); return persist({ ...state, active: id }); },
    save(id, values, { confirmed = false, source = 'Operator-entered references' } = {}) {
      if (!['original', 'spare'].includes(id)) throw new Error('Select a TPS profile first');
      validateTpsReferences(values);
      const profile = { ...state.profiles[id], ...values, status: confirmed ? 'confirmed' : 'suggested', source, updatedAt: now(),
        confirmation: confirmed ? 'Operator accepted references; mechanical wide-open verification is not inferred' : null };
      return persist({ ...state, profiles: { ...state.profiles, [id]: profile } });
    },
    reset(id) { if (!['original', 'spare'].includes(id)) throw new Error('Select a TPS profile first'); return persist({ ...state, profiles: { ...state.profiles, [id]: defaultTpsProfiles().profiles[id] } }); },
  };
}
export function calibratedTpsReading(raw, profiles, review = null) {
  const profile = profiles.profiles[profiles.active];
  if (!profile || profile.status !== 'confirmed') return { throttle: null, sensor: null, message: profile?.status === 'suggested' ? 'Not calibrated · suggested references' : 'Not calibrated' };
  if (review?.active && review.sensorProfile !== profiles.active) return { throttle: null, sensor: null, message: 'Historical sensor identity unrecorded. Apply a profile explicitly.' };
  const result = tpsPercent(raw, profile);
  return { ...result, message: result.throttle == null ? 'No usable ITP sample' : `${profile.name} · operator-accepted references${review?.active ? ' · comparison only; historical identity unverified' : ''}` };
}
