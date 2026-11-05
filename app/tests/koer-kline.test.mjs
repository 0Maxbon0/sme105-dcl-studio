import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createCartDecoder } from "../js/cart.js";
import { parseLine } from "../js/protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "../js/session.js";
import { createKoerGuide } from "../js/koer-guide.js";
import { createKlineSession, importKline, klineCsv, KLINE_CAPABILITY } from "../js/kline.js";
const root = new URL("../../", import.meta.url);
function replay(name) {
  const d = createCartDecoder(), session = createSession(); let count = 0;
  for (const line of gunzipSync(readFileSync(new URL(`captures/derived-20261105/${name}.txt.gz`, root))).toString().trim().split("\n")) {
    const [utc,,raw] = line.split("\t"); const p = parseLine(raw); noteSessionLine(session,p);
    if(p.type === "rx") { d.pushRx(p.t_us,p.byte,utc); ++count; }
  }
  return { cart:d.finish(), session, count };
}
test("full 32,862-byte KOER replay preserves exact frames, code words, source clocks and incomplete integrity", () => {
  const {cart,session,count}=replay("main-koer");
  assert.equal(count,32862);assert.equal(cart.frameCount,5695);assert.equal(cart.blocks25,353);assert.equal(cart.completeBlocks25,353);
  assert.deepEqual(cart.codes.map(c=>c.code),["172","538","521"]);
  assert.deepEqual(cart.frame7Counts,{ACC0:86,EC80:267});
  assert.deepEqual(Object.values(cart.codeCounts),[267,267,267]);
  assert.deepEqual(cart.codes.map(c=>c.rawBytes),[[0x72,0xe1],[0x38,0x45],[0x21,0xc5]]);
  assert.deepEqual(cart.codes.map(c=>c.frameReceivedAt),["2026-11-05T16:48:47.417Z","2026-11-05T16:48:47.485Z","2026-11-05T16:48:47.506Z"]);
  assert.ok(cart.codes.every(c=>c.slot===15 && c.rxTimeUs>c.frameTimeUs));
  const phase=cart.evidence.filter(e=>e.type==="RESULT_PHASE");assert.equal(phase.length,1);
  assert.equal(phase[0].frameReceivedAt,"2026-11-05T16:48:47.713Z");assert.deepEqual(phase[0].rawBytes,[0xec,0x80]);
  const verdict=sessionVerdict(session,{variant:"KOER",cart});assert.equal(verdict.valid,false);
  assert.equal(verdict.witnessStatus,"LEGACY_UNVERIFIED");assert.equal(verdict.verifiedSuccess,false);
  assert.match(verdict.reasons.join(" "),/expected 253E observed 260E match 1/);
});
test("KOEO has the same result bit; neither test can generate a real-time operator prompt",()=>{
  const events=[];const g=createKoerGuide({journal:(type,detail)=>events.push({type,detail}),now:()=>42});g.start("test");
  for(const name of ["koeo","main-koer"]){const {cart}=replay(name);assert.ok(cart.evidence.some(e=>e.type==="RESULT_PHASE"));cart.evidence.forEach(g.evidence);}
  assert.equal(g.state.prompt,null);assert.equal(g.state.phase,"RESULT_PHASE");
  g.confirm("throttle-reported");assert.equal(events.at(-1).detail.source,"human");assert.equal(events.at(-1).detail.ecuConfirmed,false);
  g.finish({timedOut:true});assert.equal(g.state.phase,"TIMED_OUT");assert.equal(g.state.verifiedSuccess,false);
  assert.throws(()=>g.confirm("external-cue"),/No active/);
});
test("new pad provenance is bound to a single epoch; legacy remains unverified",()=>{
  const s=createSession();for(const line of ["EVENT session=READ_CANDIDATE epoch=5 boot_id=77","TX_PAD slot=2 expected=253E observed=253E match=1 evidence=2 epoch=4 boot_id=77 tx_seq=3 block=0 complete=1","END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW epoch=5 boot_id=77"])noteSessionLine(s,parseLine(line));
  assert.equal(sessionVerdict(s).valid,false);assert.match(sessionVerdict(s).reasons.join(),/provenance/);
  s.pads[0].epoch=5;assert.equal(sessionVerdict(s).witnessStatus,"SESSION_BOUND");
});
test("K-Line hardware absent and every import is unverified, with independent clocks and binary provenance",()=>{
  assert.equal(KLINE_CAPABILITY.hardwareEnabled,false);assert.equal(KLINE_CAPABILITY.txEnabled,false);
  assert.throws(()=>createKlineSession({source:"hardware"}),/unavailable/);
  const s=importKline("KLINE t_us=4294967290 byte=55\nKLINE t_us=12 byte=08");
  assert.equal(s.records[1].monotonic_us,4294967308);assert.equal(s.hardwareVerified,false);assert.equal(s.protocol,"UNKNOWN");
  assert.match(klineCsv(s),/simulation/);
  const b=importKline(Uint8Array.from([0x33,0x55]).buffer,{binary:true,source:"import"});
  assert.equal(b.records[0].metadata.timeBasis,"synthetic-byte-index");assert.equal(b.source,"simulation");
});
test("K-Line rejects interleaved DCL, reversed clocks, invalid framing payloads, overflow, disconnected RX",()=>{
  const s=createKlineSession({capacity:2});
  assert.throws(()=>s.receive({channel:"DCL",t_us:1,byte:0}),/Channel mismatch/);
  s.receive({channel:"KLINE",t_us:10,byte:0});assert.throws(()=>s.receive({channel:"KLINE",t_us:9,byte:0}),/reversal/);
  assert.throws(()=>s.receive({channel:"KLINE",t_us:11,byte:256}),/Invalid byte/);
  s.receive({channel:"KLINE",t_us:11,edge:1,protocol:"KWP-CLAIM"});assert.equal(s.state.errors[0],"PROTOCOL_MISMATCH");
  s.receive({channel:"KLINE",t_us:12,error:"VOLTAGE_FAULT"});assert.equal(s.state.overflow,1);assert.equal(s.state.status,"OVERFLOW");
  assert.throws(()=>s.receive({channel:"KLINE",t_us:13,byte:0}),/closed/);
  const next=createKlineSession();assert.notEqual(s.state.id,next.state.id);assert.equal(next.state.received,0);
  assert.equal(parseLine("KLINE t_us=11 byte=55").type,"kline");
});
test("5-baud init stays inert metadata; framing, edges and errors survive JSONL import",()=>{
  const s=importKline(JSON.stringify({channel:"KLINE",t_us:1,metadata:{init:"5-baud",address:0x33},frame:"synthetic-1",framing:"8N1 claimed",protocol:"ISO9141"})+"\n"+JSON.stringify({channel:"KLINE",t_us:2,edge:0,error:"FRAMING"}));
  assert.equal(s.records[0].metadata.init,"5-baud");assert.equal(s.records[0].protocol,"UNKNOWN");assert.equal(s.records[1].error,"FRAMING");
  assert.throws(()=>importKline("RX t_us=1 byte=55"),/Expected KLINE/);
});

test("five historic stored codes and KOER remain independent after a later 111 dataset",async()=>{
  const {warningsForDiagnosticSession}=await import("../js/dtc-history.js");
  const sessions=[{variant:"0E",startedAt:1,codes:["122","113","214","157","452"].map(code=>({code,mode:0x26,requestedMode:0x26}))},
    {variant:"KOER",startedAt:2,codes:["172","538","521"].map(code=>({code,mode:0x25,requestedMode:0x25}))},
    {variant:"0E",startedAt:3,codes:[{code:"111",mode:0x26}]}];
  const historical=sessions.flatMap(warningsForDiagnosticSession);
  assert.equal(historical.length,8);assert.equal(new Set(historical.map(w=>w.key)).size,8);
  assert.ok(historical.filter(w=>w.warning.evidence.variant==="KOER").every(w=>!w.key.startsWith("stored-")));
  assert.equal(warningsForDiagnosticSession(sessions[2]).length,0);assert.equal(sessions[0].codes.length,5);
  const {lookupCode}=await import("../js/codes-db.js");assert.match(lookupCode("111").description,/this response dataset/);
});
test("preserved IAT recording shows delayed channels; no calibration or fallback is inferred",()=>{
  const rows=readFileSync(new URL("captures/derived-20261105/iat.csv",root),"utf8").trim().split("\n").slice(1).map(l=>l.split(","));
  const act=rows.find(r=>r[1]==="ACT"&&r[3]==="37.8");const iact=rows.find(r=>r[1]==="IACT"&&r[2]==="474");
  assert.equal(+act[0],16.564338);assert.equal(+iact[0],42.88828);
  assert.ok(Math.abs(+iact[0]-act[0]-26.323942)<1e-9);
});
