import { createTpsProfiles, calibratedTpsReading, stableTpsReference } from './tps-calibration.js';
export function createTpsControls({ state, changed, document: doc = globalThis.document, storage = globalThis.localStorage }) {
  const profiles = createTpsProfiles(storage), node = id => doc.getElementById(id);
  const currentProfile = () => profiles.state.profiles[profiles.state.active];
  let context = { samples: [], position: 0, raw: null };
  let referenceEvidence = {};
  let draftSource = '';
  const error = (fn, message = 'Saved on this device.') => { try { fn(); node('tps-message').textContent = message; } catch (e) { node('tps-message').textContent = e.message; } changed(); };
  function fields() {
    node('tps-profile').value = profiles.state.active;
    const p = currentProfile();
    for (const key of ['freeRest', 'mountedClosed', 'maximum']) node(`tps-${key}`).value = p?.[key] ?? '';
    node('tps-confirm').checked = false;
    referenceEvidence = { ...(p?.referenceEvidence || {}) };
    draftSource = p?.source || 'Operator-entered references';
    node('tps-save').disabled = !p; node('tps-reset').disabled = !p;
    node('tps-source').textContent = p ? `${p.status === 'confirmed' ? 'Operator-accepted references' : p.status} · ${p.source || 'No references'}${p.updatedAt ? ' · updated ' + p.updatedAt : ''}` : 'Calibration disabled';
  }
  function update() {
    state.tpsProfiles = profiles.state;
    const series = state.review?.active ? state.review.pids.ITP : state.cart?.snapshot()?.pids?.ITP || state.lastSession?.pids?.ITP;
    const samples = series?.samples || [];
    const latest = samples.at(-1);
    const live = state.op?.kind === 'live' && state.phase === 'read';
    const position = state.review?.active ? state.review.position : latest?.t ?? 0;
    context = { samples, position, raw: latest?.raw ?? null };
    const reading = calibratedTpsReading(context.raw, profiles.state, state.review);
    node('tps-raw').textContent = context.raw == null ? 'ITP raw: no sample at this position' : `ITP raw: ${context.raw} counts · sample ${latest.t.toFixed(3)}s`;
    node('tps-travel').textContent = reading.throttle == null ? '—' : reading.throttle.toFixed(1);
    node('tps-sensor-reference').textContent = `Sensor reference position (%): ${reading.sensor == null ? '—' : reading.sensor.toFixed(1)} · unloaded reference, not mounted opening`;
    node('tps-context').textContent = reading.message;
    node('tps-history-apply').hidden = !state.review?.active;
    node('tps-history-profile').checked = state.review?.sensorProfile === profiles.state.active;
    for (const key of ['freeRest', 'mountedClosed', 'maximum']) node(`tps-capture-${key}`).disabled = !(state.review?.active || live) || (live && (!latest?.receivedAt || Date.now() - latest.receivedAt > 750));
  }
  function wire() {
    fields();
    node('tps-card-open').addEventListener('click', () => {
      const details = node('tps-profile-details');
      details.open = true;
      details.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      details.querySelector('summary')?.focus();
    });
    node('tps-profile').addEventListener('change', () => error(() => { profiles.select(node('tps-profile').value); if (state.review) state.review.sensorProfile = null; fields(); }));
    node('tps-save').addEventListener('click', () => error(() => {
      const values = Object.fromEntries(['freeRest', 'mountedClosed', 'maximum'].map(key => [key, node(`tps-${key}`).value.trim() === '' ? null : Number(node(`tps-${key}`).value)]));
      values.referenceEvidence = { ...referenceEvidence };
      profiles.save(profiles.state.active, values, { confirmed: node('tps-confirm').checked, source: node('tps-confirm').checked ? `Operator accepted references; ${draftSource}` : draftSource });
      if (state.review) state.review.sensorProfile = null;
      fields();
    }));
    node('tps-reset').addEventListener('click', () => error(() => { profiles.reset(profiles.state.active); if (state.review) state.review.sensorProfile = null; fields(); }));
    for (const key of ['freeRest', 'mountedClosed', 'maximum']) node(`tps-capture-${key}`).addEventListener('click', () => error(() => {
      node(`tps-${key}`).value = stableTpsReference(context.samples, context.position);
      referenceEvidence[key] = { source: state.review?.active ? 'selected recording' : 'live received sample', recordingId: state.review?.metadata?.id || state.archive?.id || null, sampleTime: context.samples.at(-1)?.t, acceptedPhysicalPosition: false };
      draftSource = 'Operator-selected stable samples; physical reference requires operator acceptance';
      node('tps-confirm').checked = false;
    }, 'Stable sample copied. Verify its physical reference, then save.'));
    for (const key of ['freeRest', 'mountedClosed', 'maximum']) node(`tps-${key}`).addEventListener('input', () => { delete referenceEvidence[key]; draftSource = 'Operator-entered references'; node('tps-confirm').checked = false; });
    node('tps-history-profile').addEventListener('change', () => {
      if (state.review) state.review.sensorProfile = node('tps-history-profile').checked ? profiles.state.active : null;
      changed();
    });
    update();
  }
  return { wire, update, profiles };
}
