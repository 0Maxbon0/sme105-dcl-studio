/** Incremental CART word / frame / block decoder. */

import { PIDS, pyRoundDiv, scaleWord } from "./pids.js";

export const SLOT_US = 2500;
export const WORD_GAP_US = 1300;

export function parityOk(b0, b1) {
  return ((b0 & 15) ^ (b0 >> 4) ^ (b1 & 15) ^ 0x0a) === (b1 >> 4);
}

export function wordData(b0, b1) {
  return ((b1 & 0x0f) << 8) | b0;
}

export function formatCode(data) {
  return data.toString(16).toUpperCase().padStart(3, "0");
}

export function createCartDecoder(pidSet = null) {
  const dec = {
    pending: [],
    prev: null,
    frame: null,
    block: [],
    mode: null,
    t0: null,
    codes: [],
    codeSeen: new Set(),
    rom: null,
    frame7First: null,
    frame7Last: null,
    selfTestComplete: false,
    blocks25: 0,
    blocks26: 0,
    frameCount: 0,
    parityRejects: 0,
    rows: [],
    pids: {},
    pidSet,
    closed: false,
  };

  function closeFrame(fr) {
    if (dec.block.length && fr.fid <= dec.block[dec.block.length - 1].fid) {
      emitBlock(dec.block);
      dec.block = [];
    }
    dec.block.push(fr);
    dec.frameCount += 1;
    emitPid(fr);
  }

  function emitBlock(block) {
    let mode = null;
    let low = null;
    let high = null;
    for (const fr of block) {
      const word = fr.slots[2];
      if (!word) continue;
      if (fr.fid === 4) mode = word[0];
      if (fr.fid === 7) {
        if (dec.frame7First === null) dec.frame7First = word[0];
        dec.frame7Last = word[0];
        if (word[0] & 0x40) dec.selfTestComplete = true;
      }
      if (fr.fid === 10) low = word[0];
      if (fr.fid === 11) high = word[0];
    }
    if (low !== null && high !== null) dec.rom = { low, high };
    if (mode === 0x25) dec.blocks25 += 1;
    if (mode === 0x26) dec.blocks26 += 1;
    if (mode !== 0x25 && mode !== 0x26) return;
    for (const fr of block) {
      const slots = Object.keys(fr.slots).map(Number).sort((a, b) => a - b);
      for (const slot of slots) {
        if (slot < 3) continue;
        const [b0, b1] = fr.slots[slot];
        if (!parityOk(b0, b1)) continue;
        const code = formatCode(wordData(b0, b1));
        if (dec.codeSeen.has(code)) continue;
        dec.codeSeen.add(code);
        dec.codes.push({ code, mode, frame: fr.fid, slot });
      }
    }
  }

  function emitPid(fr) {
    if (dec.t0 === null) dec.t0 = fr.t;
    if (fr.fid === 4 && fr.slots[2]) dec.mode = fr.slots[2][0];
    if (dec.mode !== 0x21 || fr.fid === 0 || !dec.pidSet) return;
    const word = fr.slots[3];
    if (!word) return;
    if (!parityOk(word[0], word[1])) {
      dec.parityRejects += 1;
      return;
    }
    const pid = dec.pidSet[fr.fid];
    const spec = PIDS[pid];
    if (!spec) return;
    const raw = wordData(word[0], word[1]);
    const scaled = scaleWord(pid, raw);
    const sample = {
      t: (fr.t - dec.t0) / 1e6,
      name: scaled.name,
      unit: scaled.unit,
      raw,
      value: scaled.value,
    };
    dec.rows.push(sample);
    let series = dec.pids[scaled.name];
    if (!series) {
      series = { name: scaled.name, unit: scaled.unit, pid, samples: [] };
      dec.pids[scaled.name] = series;
    }
    series.samples.push(sample);
  }

  function processPair(w, nxt) {
    const sync = w.length === 2 && w[0].b === 0 && w[1].b === 0
      && nxt.length === 2 && parityOk(nxt[0].b, nxt[1].b);
    if (sync) {
      if (dec.frame) closeFrame(dec.frame);
      dec.frame = {
        t: w[0].t,
        fid: nxt[1].b & 15,
        idb0: nxt[0].b,
        slots: {},
      };
      return;
    }
    if (dec.frame && w.length === 2) {
      const slot = pyRoundDiv(w[0].t - dec.frame.t, SLOT_US);
      if (dec.frame.slots[slot] === undefined) dec.frame.slots[slot] = [w[0].b, w[1].b];
    }
  }

  function onWord(word) {
    if (dec.prev) processPair(dec.prev, word);
    dec.prev = word;
  }

  return {
    pushRx(t, b) {
      if (dec.closed) return;
      const pending = dec.pending;
      if (pending.length && t - pending[pending.length - 1].t <= WORD_GAP_US && pending.length < 2) {
        pending.push({ t, b });
        return;
      }
      if (pending.length) onWord(pending);
      dec.pending = [{ t, b }];
    },
    finish() {
      if (dec.closed) return dec;
      if (dec.pending.length) {
        const word = dec.pending;
        dec.pending = [];
        onWord(word);
      }
      if (dec.frame) {
        const fr = dec.frame;
        dec.frame = null;
        closeFrame(fr);
      }
      if (dec.block.length) {
        emitBlock(dec.block);
        dec.block = [];
      }
      dec.closed = true;
      return dec;
    },
    snapshot() {
      return dec;
    },
  };
}
