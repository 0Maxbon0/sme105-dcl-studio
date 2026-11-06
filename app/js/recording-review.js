import { formatReplayTime } from './display-format.js';
/** Read-only, bounded CSV index over the existing recording Blob. No transport imports. */
import { PIDS, summarizeSeries } from './pids.js';
import { listRecordings, recordingBlob } from './recording.js';
const names = new Set(Object.values(PIDS).map(p => p[0]));
const encoder = new TextEncoder();
const BLOCK_ROWS = 2048;
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
export function parseRecordedSample(line) {
  const c = line.trim().split(',');
  if (c[0] === 't_s' || !line.trim()) return null;
  if (c.length < 4 || !names.has(c[1]) || [c[0], c[2], c[3]].some(v => !v?.trim())) throw new Error('Malformed recorded PID row');
  const [t, raw, value] = [c[0], c[2], c[3]].map(Number);
  if (![t, raw, value].every(Number.isFinite) || t < 0 || !Number.isInteger(raw) || raw < 0 || raw > 65535) throw new Error('Invalid recorded PID value');
  return { t, name: c[1], raw, value, unit: c[4] || '' };
}
async function visitLines(blob, visit) {
  const reader = blob.stream().getReader(), decoder = new TextDecoder();
  let pending = '', offset = 0;
  const consume = async final => {
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
      await visit(line, offset); offset += encoder.encode(line).length;
    }
    if (final && pending) await visit(pending, offset);
  };
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      pending += decoder.decode(part.value, { stream: true }); await consume(false);
      if (pending.length > 8192) throw new Error('Recorded CSV line is too long');
    }
    pending += decoder.decode(); await consume(true);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function indexRecording(blob, { progress = () => {}, cancelled = () => false } = {}) {
  let count = 0, duration = 0, invalid = 0, lastTime = -Infinity;
  const last = {}, checkpoints = [{ offset: 0, t: 0, last: {} }];
  await visitLines(blob, async (line, offset) => {
    if (cancelled()) throw new Error('Recording load cancelled');
    let sample;
    try { sample = parseRecordedSample(line); }
    catch { invalid++; return; }
    if (!sample) return;
    if (sample.t < lastTime) throw new Error('Recorded sample times are out of order');
    if (count && count % BLOCK_ROWS === 0) {
      checkpoints.push({ offset, t: lastTime, last: { ...last } });
      progress({ count, bytes: offset, total: blob.size }); await yieldFrame();
    }
    lastTime = sample.t; duration = sample.t; count++; last[sample.name] = sample;
  });
  const cache = new Map();
  let blockReads = 0;
  async function block(index) {
    if (cache.has(index)) return cache.get(index);
    const task = (async () => {
      const rows = [];
      const start = checkpoints[index].offset, end = checkpoints[index + 1]?.offset ?? blob.size;
      await visitLines(blob.slice(start, end), line => { try { const s = parseRecordedSample(line); if (s) rows.push(s); } catch { /* Counted in index; never fabricate a replacement. */ } });
      blockReads++;
      return rows;
    })();
    cache.set(index, task);
    if (cache.size > 3) cache.delete(cache.keys().next().value);
    try { return await task; }
    catch (error) { if (cache.get(index) === task) cache.delete(index); throw error; }
  }
  function checkpointAt(t) {
    let lo = 0, hi = checkpoints.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (checkpoints[mid].t <= t) lo = mid; else hi = mid; }
    return lo;
  }
  return {
    count, duration, invalid,
    get stats() { return { checkpoints: checkpoints.length, cachedBlocks: cache.size, blockReads, blockRows: BLOCK_ROWS }; },
    async at(position) {
      const t = Math.max(0, Math.min(duration, Number.isFinite(position) ? position : 0));
      // Include the preceding block for stable-window inspection near a boundary.
      const index = checkpointAt(t), first = Math.max(0, index - 1);
      const current = { ...checkpoints[first].last }, history = {};
      for (let i = first; i <= index; i++) for (const sample of await block(i)) {
        if (sample.t > t) break;
        current[sample.name] = sample;
        const rows = history[sample.name] ||= []; rows.push(sample);
        if (rows.length > 256) rows.shift();
      }
      const pids = {};
      for (const [name, sample] of Object.entries(current)) {
        const samples = history[name]?.length ? history[name] : [sample];
        pids[name] = { name, unit: sample.unit, saved: true, samples, summary: summarizeSeries(samples),
          sampleTime: sample.t, ageSeconds: t - sample.t, newAtPosition: sample.t === t };
      }
      return { position: t, pids };
    },
  };
}
export function recordingLabel(item) {
  const start = item.started || Date.parse(item.id);
  const duration = item.duration ?? (item.ended && item.started ? (item.ended - item.started) / 1000 : null);
  return `${Number.isFinite(start) ? new Date(start).toLocaleString() : item.id} · ${item.variant || 'Unknown'} · ${duration == null ? 'duration unknown' : formatReplayTime(duration)} · ${item.sampleCount == null ? 'samples not indexed' : item.sampleCount + ' samples'} · ${item.verdict?.status || 'Unfinished'}${item.outcome ? ' · ' + item.outcome.replaceAll('_', ' ').toLowerCase() : ''} · ${item.id.slice(-8)}`;
}
export function createRecordingPlayer({ load = async id => {
  const metadata = (await listRecordings()).find(item => item.id === id);
  if (!metadata) throw new Error('Selected recording is no longer available');
  return { metadata, blob: await recordingBlob(id, 'csv') };
}, now = () => performance.now(), changed = () => {}, storage = globalThis.localStorage } = {}) {
  const state = { active: false, loading: false, playing: false, metadata: null, pids: {}, position: 0, duration: 0, count: 0, invalid: 0, error: '', sensorProfile: null };
  let index = null, generation = 0, seekGeneration = 0, anchor = 0, anchoredPosition = 0;
  const remember = id => { try { storage?.setItem('sme105-review-recording', id); } catch { /* Selection is optional. */ } };
  async function seek(position) {
    if (!index || state.loading) return;
    const token = ++seekGeneration, g = generation, selected = index;
    const value = await selected.at(position);
    if (g !== generation || token !== seekGeneration) return;
    Object.assign(state, value);
    if (state.position >= state.duration) state.playing = false;
    anchoredPosition = state.position; anchor = now(); changed(state);
  }
  return {
    state,
    async select(id) {
      const token = ++generation; seekGeneration++; index = null;
      Object.assign(state, { active: true, loading: true, playing: false, metadata: { id }, pids: {}, position: 0, duration: 0, count: 0, invalid: 0, error: '', sensorProfile: null }); changed(state);
      remember(id);
      try {
        const { metadata, blob } = await load(id);
        if (token !== generation) return;
        state.metadata = metadata;
        const built = await indexRecording(blob, { cancelled: () => token !== generation, progress: p => { state.count = p.count; changed(state); } });
        if (token !== generation) return;
        index = built; Object.assign(state, { duration: index.duration, count: index.count, invalid: index.invalid, loading: false });
        await seek(0);
      } catch (error) { if (token === generation) { state.loading = false; state.error = error.message; state.pids = {}; changed(state); } }
    },
    seek,
    play() { if (!index || !state.count || state.loading || state.error) return; if (state.position >= state.duration) return; state.playing = true; anchor = now(); anchoredPosition = state.position; changed(state); },
    pause() { state.playing = false; changed(state); },
    async restart() { state.playing = false; await seek(0); },
    async tick() { if (state.playing) await seek(anchoredPosition + (now() - anchor) / 1000); },
    exit() { generation++; seekGeneration++; index = null; Object.assign(state, { active: false, playing: false, loading: false, pids: {}, metadata: null, sensorProfile: null }); changed(state); },
    remembered() { try { return storage?.getItem('sme105-review-recording'); } catch { return null; } },
  };
}
