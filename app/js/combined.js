/** One combined recording; the bridge still reads one existing PID map at a time. */
export const LIVE_GROUPS = Object.freeze(["LIVE", "LIVE2", "LIVE3"]);
export const GROUP_WINDOW_MS = 5000;
export const COMBINED_LIMIT_MS = 30 * 60 * 1000;

export function createCombined(now) {
  return {
    active: true, startedAt: now, endAt: now + COMBINED_LIMIT_MS,
    groupIndex: 0, segment: 0, nextPending: false, rotateRequested: false,
    rotateAt: null, cursor: 0, offset: null, rowStart: 0,
    rows: [], pids: {}, segments: [], error: "", failed: false,
  };
}

export function startCombinedSegment(recording, now) {
  recording.segment += 1;
  recording.cursor = 0;
  recording.offset = null;
  recording.rowStart = recording.rows.length;
  recording.rotateAt = null;
  recording.nextPending = false;
  recording.rotateRequested = false;
}

export function appendCombined(recording, snapshot, now) {
  if (!snapshot) return;
  const fresh = snapshot.rows.slice(recording.cursor);
  if (fresh.length && recording.offset == null) {
    // Align separate capture clocks to the host's first received sample.
    // These are arrival-aligned timestamps, not simultaneous ECU measurements.
    recording.offset = (now - recording.startedAt) / 1000 - fresh[0].t;
  }
  for (const sample of fresh) {
    const row = {
      ...sample, t: recording.offset + sample.t, source_t: sample.t,
      variant: LIVE_GROUPS[recording.groupIndex], segment: recording.segment,
      validity: "progress", receivedAt: now,
    };
    recording.rows.push(row);
    const series = recording.pids[row.name] ||= { name: row.name, unit: row.unit, samples: [] };
    series.samples.push(row);
  }
  recording.cursor = snapshot.rows.length;
}

export function finishCombinedSegment(recording, result, now, valid) {
  appendCombined(recording, result, now);
  for (let i = recording.rowStart; i < recording.rows.length; i += 1) {
    recording.rows[i].validity = valid ? "valid" : "untrusted";
  }
  recording.segments.push({ variant: result.variant, valid, samples: recording.rows.length - recording.rowStart });
  if (!valid) recording.failed = true;
}

export function combinedSnapshot(recording) {
  return { rows: recording.rows, pids: recording.pids };
}
