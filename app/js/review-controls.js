import { formatReplayTime } from './display-format.js';
import { listRecordings } from './recording.js';
import { createRecordingPlayer, recordingLabel } from './recording-review.js';
export function createReviewControls({ state, render, closeDetails = () => {}, document: doc = globalThis.document, storage = globalThis.localStorage, now, load, list = listRecordings }) {
  const node = id => doc.getElementById(id);
  const player = createRecordingPlayer({ storage, now, load, changed() { state.review = player.state; update(); render(state); } });
  state.review = player.state;
  let entries = [];
  function update() {
    const s = player.state, busy = state.phase !== 'idle' || !!state.combined?.active;
    node('saved-recordings').disabled = busy;
    node('review-controls').hidden = !s.active;
    node('review-mode').hidden = !s.active;
    node('review-mode').textContent = 'Recorded Data — Offline Review';
    node('review-selected').textContent = !s.active ? '' : `${recordingLabel({ ...s.metadata, ...(s.loading ? {} : { sampleCount: s.count, duration: s.duration }) })}${s.loading ? ' · Loading and indexing…' : ''}${s.invalid ? ` · ${s.invalid} malformed rows omitted; source remains unchanged` : ''}${s.error ? ` · Cannot load: ${s.error}` : !s.loading && !s.count ? ' · No PID samples in this recording' : ''}`;
    node('review-position').max = s.duration;
    node('review-position').value = s.position;
    node('review-position').disabled = s.loading || !s.count || !!s.error;
    node('review-clock').textContent = `${formatReplayTime(s.position)} / ${formatReplayTime(s.duration)}`;
    node('review-play').disabled = s.loading || !s.count || !!s.error || s.playing || s.position >= s.duration;
    node('review-pause').disabled = !s.playing;
    node('review-restart').disabled = s.loading || !s.count || !!s.error;
    node('saved-csv').disabled = !entries.length;
    node('saved-log').disabled = !entries.length;
  }
  async function select(id) {
    if (state.op || state.combined?.active || !['idle', 'identify_hello', 'identify_pins', 'identify_status'].includes(state.phase)) return;
    closeDetails();
    // ALL layout exposes retained channels through the same dashboard; hidden channels remain hidden.
    const item = entries.find(e => e.id === id);
    node('live-set').value = ['LIVE', 'LIVE2', 'LIVE3', 'ALL'].includes(item?.variant) ? item.variant : 'ALL';
    await player.select(id);
    update();
  }
  async function refresh({ restore = false } = {}) {
    const prior = player.state.metadata?.id || node('saved-recordings').value;
    try {
      entries = (await list()).sort((a,b) => (b.started || Date.parse(b.id) || 0) - (a.started || Date.parse(a.id) || 0) || b.id.localeCompare(a.id));
      node('saved-recordings').replaceChildren(...entries.map(item => {
        const option = doc.createElement('option'); option.value = item.id; option.textContent = recordingLabel(item); return option;
      }));
      const remembered = restore ? player.remembered() : prior;
      const exists = entries.some(e => e.id === remembered);
      if (exists) node('saved-recordings').value = remembered;
      if (restore && (entries.length || remembered) && !state.op && ['idle', 'identify_hello', 'identify_pins', 'identify_status'].includes(state.phase)) {
        if (remembered && !exists) {
          // Keep the missing selection identifiable rather than showing a different recording.
          const option = doc.createElement('option'); option.value = remembered; option.textContent = `Unavailable recording · ${remembered}`;
          node('saved-recordings').append(option); node('saved-recordings').value = remembered;
          await player.select(remembered);
        } else await select(exists ? remembered : entries[0].id);
      }
      update();
    } catch (error) { node('review-selected').textContent = `Recording list unavailable: ${error.message}`; }
  }
  function wire() {
    node('saved-recordings').addEventListener('change', () => select(node('saved-recordings').value));
    node('review-play').addEventListener('click', () => player.play());
    node('review-pause').addEventListener('click', () => player.pause());
    node('review-restart').addEventListener('click', () => player.restart());
    node('review-position').addEventListener('input', () => { const position = Number(node('review-position').value); player.pause(); return player.seek(position); });
    node('review-exit').addEventListener('click', () => { closeDetails(); player.exit(); });
    update();
  }
  return { wire, refresh, update, player };
}
