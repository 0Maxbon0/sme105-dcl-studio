import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createCartDecoder } from "../js/cart.js";
import { createController } from "../js/controller.js";
import { ALL_LIVE_MAP, ALL_LIVE_PIDS, PIDS, pidSetForVariant } from "../js/pids.js";
import { EXPECTED_HELLO, EXPECTED_PINS, parseLine } from "../js/protocol.js";

const word = (data) => {
  const lo = data & 255, nib = (data >> 8) & 15;
  return [lo, (((lo & 15) ^ (lo >> 4) ^ nib ^ 10) << 4) | nib];
};
const rawFor = pid => pid * 11 + 1;

// Fixed 22.5ms frames, including an old-map block before map loading.
export function allEvents({ load = true, corrupt = false } = {}) {
  const events = [];
  let t = 100000;
  const modes = load ? [0x21, 0x41, 0x21, 0x21, 0x21] : [0x21, 0x21, 0x21];
  for (const mode of modes) for (let frame = 0; frame < 16; frame += 1) {
    const add = (offset, pair) => pair.forEach((byte, i) => events.push({ t_us: t + offset + i * 1042, byte }));
    add(0, [0, 0]); add(2500, word((frame << 8) | 0xf8));
    add(5000, word(frame === 4 ? (0x600 | mode) : 0));
    if (frame && mode === 0x21) ALL_LIVE_MAP[frame].forEach((pid, column) => {
      const data = word(rawFor(pid));
      if (corrupt && column === 2 && frame === 5) data[1] ^= 0x10;
      add(7500 + column * 2500, data);
    });
    t += 22500;
  }
  return events;
}

function batch(events) {
  const base = events[0].t_us;
  return `RXB t_us=${base} data=${events.map(e=>e.byte.toString(16).padStart(2,"0").toUpperCase()).join("")} dt=${events.map(e=>e.t_us-base).join(",")}`;
}

test("the firmware and browser use identical 45-slot maps containing exactly 39 channels", () => {
  const source = fs.readFileSync(new URL("../../firmware/sme105_usb_bridge/live_all_map.h", import.meta.url), "utf8");
  const body = source.match(/kAllLivePids\[16\]\[3\] = \{([\s\S]*?)\n\};/)[1];
  const rows = [...body.matchAll(/\{([^}]+)\}/g)].map(m=>m[1].split(",").map(v=>Number(v.trim())));
  assert.deepEqual(rows, ALL_LIVE_MAP);
  assert.equal(rows.slice(1).flat().length, 45);
  assert.deepEqual(new Set(rows.slice(1).flat()), new Set(ALL_LIVE_PIDS.slice(1)));
  assert.equal(pidSetForVariant("ALL"), ALL_LIVE_MAP);
});

test("compact batches retain every byte and timestamp, including uint32 wrap", () => {
  const events = allEvents();
  for (let i = 0; i < events.length; i += 16) {
    const chunk = events.slice(i, i + 16);
    assert.deepEqual(parseLine(batch(chunk)).events.map(({ t_us, byte })=>({t_us, byte})), chunk);
  }
  assert.deepEqual(parseLine("RXB t_us=4294967290 data=AAFF dt=0,10").events.map(e=>e.t_us), [4294967290,4]);
  for (const malformed of ["RXB t_us=1 data=AABB dt=0", "RXB t_us=1 data=AA dt=1", "RXB t_us=1 data=AABBCC dt=0,20,10", "RXB t_us=4294967296 data=AA dt=0"]) {
    assert.equal(parseLine(malformed).type, "fault");
  }
});

test("every all-data channel is revisited within 360ms; slot columns cannot exchange values", () => {
  const decoder = createCartDecoder(ALL_LIVE_MAP);
  for (const e of allEvents()) decoder.pushRx(e.t_us, e.byte);
  const result = decoder.finish();
  assert.equal(result.parityRejects, 0);
  assert.equal(Object.keys(result.pids).length, 39);
  assert.ok(result.rows[0].t > .36, "discard the previous map's stream");
  for (const pid of ALL_LIVE_PIDS.slice(1)) {
    const samples = result.pids[PIDS[pid][0]].samples;
    assert.ok(samples.length >= 2, PIDS[pid][0]);
    assert.ok(samples.every(s=>s.raw === rawFor(pid)), PIDS[pid][0]);
    for (let i = 1; i < samples.length; i += 1) assert.ok(samples[i].t - samples[i-1].t <= .360001, PIDS[pid][0]);
  }
  const old = createCartDecoder(ALL_LIVE_MAP);
  for (const e of allEvents({load:false})) old.pushRx(e.t_us, e.byte);
  assert.equal(old.finish().rows.length, 0, "never label an old-map stream as ALL");
  const bad = createCartDecoder(ALL_LIVE_MAP);
  for (const e of allEvents({corrupt:true})) bad.pushRx(e.t_us, e.byte);
  assert.ok(bad.finish().parityRejects > 0);
});

test("packed full-frame evidence plus pad reports fits the 115200-baud USB budget", () => {
  const events = [];
  // Worst occupancy of the length-6 map: sync plus seven words each frame.
  for (let frame=0; frame<16; frame++) for(let slot=0;slot<8;slot++) {
    const t = 1000000000 + frame*22500 + slot*2500;
    events.push({t_us:t,byte:255},{t_us:t+1042,byte:255});
  }
  const bytes = Array.from({length:events.length/16},(_,i)=>batch(events.slice(i*16,i*16+16)).length+1).reduce((a,b)=>a+b,0);
  const withMetadataPerSecond = (bytes + 4*150 + 100)/.36;
  assert.ok(withMetadataPerSecond < 115200/10, String(withMetadataPerSecond));
});

test("ALL sends one read, never rotates, and requires map plus all-channel evidence", () => {
  for (const scenario of ["good", "bad-map", "fault-end", "de-high"]) {
    const good = scenario === "good";
    let now=1000; const sent=[];
    const c=createController({now:()=>now,send:cmd=>sent.push(cmd)});
    c.onConnected("test"); c.handleLine("AUTH OK transport=BLE"); c.handleLine(EXPECTED_HELLO); c.handleLine(EXPECTED_PINS);
    c.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0 fw=20");
    assert.equal(c.requestAllLive().ok,false);
    const status="STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0 live_all=1 rx_batch=1 fw=21";
    c.handleLine(status); assert.equal(c.requestAllLive().ok,true);
    c.handleLine(status); assert.equal(sent.at(-1),"ARM_ALL");
    c.handleLine("EVENT read_armed variant=ALL valid_ms=15000 no_tx_yet=1");
    assert.equal(sent.at(-1),"READ_ALL");
    c.handleLine("EVENT session=READ_CANDIDATE");
    const events=allEvents();
    for(let i=0;i<events.length;i+=16)c.handleLine(batch(events.slice(i,i+16)));
    now+=20000;c.tick();
    assert.equal(sent.at(-1),"READ_ALL", "no timer-driven group switching");
    for(const [slot,expected] of ["01B0","FF5F","21F6","00A0"].entries())c.handleLine(`TX_PAD slot=${slot} expected=${expected} observed=${expected} match=1`);
    c.handleLine(`EVENT live_pid_map set=ALL sent=45 verified=${scenario === "bad-map"?44:45}`);
    c.handleLine(`END reason=${scenario === "fault-end"?11:16} ro_bytes=${events.length} ro_lost=0 uart_errors=0 pad_verified=4 words_started=4 DE=${scenario === "de-high"?"HIGH":"LOW"}`);
    assert.equal(c.state.lastSession.verdict.valid,good);
    assert.equal(Object.keys(c.state.lastSession.pids).length,39);
    assert.equal(c.state.combined,null);
  }
});

test("the Live overview labels the four exact request scopes and six reading groups", async () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const { LIVE_GROUP_TITLES } = await import("../js/live-dashboard.js");
  const nav = html.match(/<nav>([^]*?)<\/nav>/)?.[1] || "";
  assert.equal((nav.match(/data-view=/g) || []).length, 5);
  assert.match(nav, /data-view="live" aria-current="page"/);
  assert.match(html, /id="live-set"/);
  assert.match(html, /value="LIVE">Engine/);
  assert.match(html, /value="LIVE2"/);
  assert.match(html, /value="LIVE3"/);
  assert.match(html, /value="ALL"/);
  assert.match(html, /<option value="advanced">Technical inputs<\/option>/);
  assert.equal(Object.keys(LIVE_GROUP_TITLES).length, 6);
});

test("three hours of continuous decoding crosses two clock wraps with bounded history", () => {
  let count = 0;
  const decoder = createCartDecoder(ALL_LIVE_MAP, { historyLimit: 32, onSample() { count++; } });
  const events = allEvents();
  // Map phase, then keep streaming the final mode-21 block for three hours.
  for (const event of events) decoder.pushRx(event.t_us, event.byte);
  const block = events.filter(e => e.t_us >= 100000 + 4 * 360000);
  for (let cycle = 1; cycle <= 30000; cycle++) for (const event of block)
    decoder.pushRx((event.t_us + cycle * 360000) >>> 0, event.byte);
  const result = decoder.finish();
  assert.equal(result.parityRejects, 0);
  assert.equal(result.totalRows, count);
  assert.ok(count > 1_300_000);
  assert.ok(result.rows.length <= 32 * 39);
  for (const series of Object.values(result.pids)) {
    assert.ok(series.samples.length <= 32);
    assert.ok(series.samples.at(-1).t >= 10800);
    assert.ok(series.summary.n > series.samples.length);
    for(let i=1;i<series.samples.length;i++)assert.ok(series.samples[i].t >= series.samples[i-1].t);
  }
});

test("the recording controller archives every sample while bounding UI/log memory", () => {
  let archivedSamples = 0, archivedLines = 0, completed = 0;
  const c = createController({ send() {} });
  c.onConnected("test"); c.handleLine("AUTH OK transport=BLE"); c.handleLine(EXPECTED_HELLO); c.handleLine(EXPECTED_PINS);
  const status="STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0 live_all=1 rx_batch=1 fw=21";
  c.handleLine(status);
  c.setArchive({ sample() { archivedSamples++; }, line() { archivedLines++; }, finish() { completed++; return Promise.resolve(); } });
  assert.equal(c.requestAllLive().ok,true); c.handleLine(status);
  c.handleLine("EVENT read_armed variant=ALL valid_ms=15000 no_tx_yet=1");
  c.handleLine("EVENT session=READ_CANDIDATE");
  const initial = allEvents();
  const block = initial.filter(e => e.t_us >= 100000 + 4 * 360000);
  let received = 0;
  const feed = events => {
    received += events.length;
    for(let i=0;i<events.length;i+=16)c.handleLine(batch(events.slice(i,i+16)));
  };
  feed(initial);
  for(let cycle=1;cycle<=1000;cycle++)feed(block.map(e=>({...e,t_us:e.t_us+cycle*360000})));
  c.handleLine("EVENT live_pid_map set=ALL sent=45 verified=45");
  c.handleLine(`END reason=16 ro_bytes=${received} ro_lost=0 uart_errors=0 pad_verified=4 words_started=4 DE=LOW`);
  assert.ok(c.state.lastSession.verdict.valid);
  assert.equal(archivedSamples,c.state.lastSession.totalRows);
  assert.ok(archivedSamples > 45000);
  assert.ok(archivedLines > 10000);
  assert.ok(c.state.log.length <= 2100);
  assert.ok(c.state.lastSession.rows.length <= 512*39);
  for(const series of Object.values(c.state.lastSession.pids))assert.ok(series.samples.length <= 512);
  assert.equal(completed,1);
});
