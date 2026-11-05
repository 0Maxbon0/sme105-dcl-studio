import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import { createCartDecoder } from "../app/js/cart.js";
import { parseLine } from "../app/js/protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "../app/js/session.js";
import assert from "node:assert/strict";
const path=process.argv[2]||"/home/maxim/Downloads/sme105-phone-diagnostics-20261105-165356.zip";
const bytes=await readFile(path), hash=createHash("sha256").update(bytes).digest("hex");
assert.equal(hash,"852d3dcfd47c9876d28c9606ce5c38bbf6bdbf4723237347444c5e17ed1375d9");
const zip=await JSZip.loadAsync(bytes), lines=(await zip.file("bridge-raw.txt").async("string")).trimEnd().split(/\r?\n/);
const main=lines.slice(58919,91791).join("\n")+"\n";
assert.equal(gunzipSync(await readFile(new URL("../captures/derived-20261105/main-koer.txt.gz",import.meta.url))).toString(),main);
const decoder=createCartDecoder(),session=createSession();let rx=0;
for(const line of main.trimEnd().split("\n")) {
  const [utc,,raw]=line.split("\t");const p=parseLine(raw);noteSessionLine(session,p);
  if(p.type==="rx"){decoder.pushRx(p.t_us,p.byte,utc);rx++;}
}
const cart=decoder.finish(),verdict=sessionVerdict(session,{variant:"KOER",cart});
assert.equal(rx,32862);assert.equal(cart.frameCount,5695);assert.equal(cart.completeBlocks25,353);
assert.deepEqual(cart.frame7Counts,{ACC0:86,EC80:267});assert.equal(verdict.valid,false);
const report={inputSha256:hash,rawLines:lines.length,mainRawLines:[58920,91791],rx,frames:cart.frameCount,
  completeMode25Cycles:cart.completeBlocks25,frame7Counts:cart.frame7Counts,codeCounts:cart.codeCounts,
  codes:cart.codes,evidence:cart.evidence,verdict,authenticatedOperatorPrompts:[],verifiedKoerSuccess:false,
  timestampNote:"frameReceivedAt is the source RX frame-sync host timestamp; receivedAt is the actual code/phase word's host receipt. MCU timestamps are preserved independently; host batching is not ECU time."};
await writeFile(new URL("../artifacts/koer-forensic-verification.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({sha256:hash,rx,frames:cart.frameCount,completeMode25:cart.completeBlocks25,codes:cart.codes.map(c=>c.code),status:verdict.status}));
