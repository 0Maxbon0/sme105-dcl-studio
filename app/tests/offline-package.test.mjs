import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../js/protocol.js";
test("every runtime local module is present and pre-cached for offline use",()=>{
  const app=fileURLToPath(new URL("../",import.meta.url));
  const sw=readFileSync(resolve(app,"sw.js"),"utf8");
  const androidBuild=readFileSync(resolve(app,"../android/app/build.gradle"),"utf8");
  assert.equal(APP_VERSION,"1.8.13");
  assert.match(sw,/const CACHE_NAME = 'eeciv-v1\.8\.13';/);
  assert.match(androidBuild,/versionName\s+"1\.8\.13"/);
  const cached=new Set([...sw.matchAll(/"(\.\/[^"?]+)(?:\?[^"\n]*)?"/g)].map(m=>resolve(app,m[1])));
  const seen=new Set(),queue=[resolve(app,"js/app.js")];
  while(queue.length){const path=queue.pop();if(seen.has(path))continue;seen.add(path);
    assert.ok(existsSync(path),path);assert.ok(cached.has(path),`offline cache missing ${path}`);
    const source=readFileSync(path,"utf8");
    for(const match of source.matchAll(/(?:from\s*|import\s*\()(["'])(\.{1,2}\/[^"']+)\1/g))queue.push(resolve(dirname(path),match[2].split("?")[0]));
  }
  assert.ok(seen.has(resolve(app,"js/kline.js")));assert.ok(seen.has(resolve(app,"js/koer-guide.js")));
  assert.ok(sw.includes(`eeciv-v${APP_VERSION}`), 'offline cache version must match the app');
});
