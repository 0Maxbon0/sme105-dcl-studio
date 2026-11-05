import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
test("firmware producer model survives 1000 cross-session transitions, faults, partial TX and isolated K-Line RX",()=>{
  const temp=mkdtempSync(join(tmpdir(),"sme105-native-"));
  try {
    const binary=join(temp,"regression");
    execFileSync("g++",["-std=c++17","-Wall","-Wextra","-Werror",join(root,"tests/firmware/passive_integrity.cpp"),"-o",binary]);
    execFileSync(binary,[]);
    const source=join(temp,"gate.cpp");writeFileSync(source,'#include "kline_rx.h"\nint main(){}\n');
    for(const flag of ["KLINE_TX_ENABLED","KLINE_HW_ENABLED"]) {
      const result=spawnSync("g++",["-std=c++17",`-D${flag}=1`,"-I",join(root,"firmware/sme105_usb_bridge"),source,"-o",join(temp,"blocked")],{encoding:"utf8"});
      assert.notEqual(result.status,0);assert.match(result.stderr,/must remain hardware-disabled/);
    }
    const firmware=readFileSync(join(root,"firmware/sme105_usb_bridge/sme105_usb_bridge.ino"),"utf8");
    assert.ok(firmware.indexOf("padEvidence.begin();")<firmware.indexOf("variant = kind;"));
    assert.match(firmware,/padEvidence\.start\(dpsBlocks, index, selected.first, selected.second, now\)/);
    const reporter=firmware.slice(firmware.indexOf("void flushPadReports()"),firmware.indexOf("void flushRaw()"));
    assert.doesNotMatch(reporter,/dpsWord\(/);assert.match(reporter,/record.completed && record.match/);
    const kline=readFileSync(join(root,"firmware/sme105_usb_bridge/kline_rx.h"),"utf8");
    assert.doesNotMatch(kline,/pinMode\(|digitalWrite\(|uart_set_pin\(|uart_write_bytes\(/);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
