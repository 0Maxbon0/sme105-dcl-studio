import { displayReading } from './pids.js';

export function chartTime(sample) {
  return Number.isFinite(sample?.t) ? sample.t * 1000 : Number.isFinite(sample?.receivedAt) ? sample.receivedAt : null;
}
export function chartPoints(samples, name, range = '30', unitSystem = 'metric') {
  const points = samples.map(sample => ({ time: chartTime(sample), value: displayReading(name, sample.value, { unitSystem }).value }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value));
  if (!points.length) return [];
  const end = points.at(-1).time;
  return range === 'full' ? points : points.filter(point => end - point.time <= Number(range) * 1000);
}
/** Keep the first/last and extrema of each pixel bucket; preserve chronological order. */
export function chartEnvelope(points, width) {
  if (points.length <= width * 4 || !points.length) return points;
  const span = Math.max(1, points.at(-1).time - points[0].time), start = points[0].time;
  const buckets = new Map();
  for (const point of points) {
    const key = Math.floor((point.time - start) / span * width);
    const bucket = buckets.get(key);
    if (!bucket) buckets.set(key, { first: point, last: point, min: point, max: point });
    else { bucket.last = point; if (point.value < bucket.min.value) bucket.min = point; if (point.value > bucket.max.value) bucket.max = point; }
  }
  return [...buckets.values()].flatMap(bucket => [...new Set([bucket.first, bucket.min, bucket.max, bucket.last])].sort((a,b) => a.time-b.time));
}
export function chartBounds(points, nonNegative = false) {
  let min = Infinity, max = -Infinity;
  for (const point of points) { min = Math.min(min,point.value); max = Math.max(max,point.value); }
  if (!points.length) return { min:0, max:1, step:0.25 };
  const target = (max-min || Math.max(Math.abs(max)*0.1,1))/4;
  const power = 10**Math.floor(Math.log10(target));
  const step = [1,2,2.5,5,10].find(value=>value*power>=target)*power;
  let lower = Math.floor(min/step)*step, upper = Math.ceil(max/step)*step;
  if (lower === upper) { lower-=step; upper+=step; }
  if (nonNegative) lower=Math.max(0,lower);
  return { min:lower, max:upper, step };
}
export function chartClock(time) {
  const seconds = Math.max(0, time / 1000);
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
/** Read only the requested native signal from a recording without retaining other channels. */
async function visitCsvSamples(blob, visit) {
  const reader = blob.stream().getReader(), decoder = new TextDecoder();
  let pending = '';
  const line = text => {
    const columns = text.trim().split(',');
    if (columns[0] === 't_s') return;
    const t = Number(columns[0]), raw = Number(columns[2]), value = Number(columns[3]);
    if ([t, raw, value].every(Number.isFinite)) visit({ t, raw, value, name: columns[1], unit: columns[4] || '' });
  };
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(line);
    }
    pending += decoder.decode(); if (pending) line(pending);
  } finally { reader.releaseLock(); }
}
export async function sensorSamplesFromCsv(blob, name) {
  const samples = [];
  await visitCsvSamples(blob, sample => { if (sample.name === name) samples.push(sample); });
  return samples;
}
export async function dashboardSeriesFromCsv(blob, names) {
  const allowed = new Set(names), pids = {};
  await visitCsvSamples(blob, sample => {
    if (!allowed.has(sample.name)) return;
    const series = pids[sample.name] ||= { name: sample.name, unit: sample.unit, saved: true, samples: [] };
    series.samples.push(sample);
    if (series.samples.length > 1024) series.samples.splice(0,512);
    const old = series.summary;
    series.summary = old ? { ...old, n:old.n+1, min:Math.min(old.min,sample.value), max:Math.max(old.max,sample.value), last:sample.value, rawLast:sample.raw }
      : { n:1, first:sample.value, min:sample.value, max:sample.value, last:sample.value, rawLast:sample.raw };
  });
  for (const series of Object.values(pids)) series.samples = series.samples.slice(-512);
  return pids;
}
