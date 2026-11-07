import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMAND_CATALOGUE, DCL_BLOCKED_CANDIDATES } from "../js/protocol.js";
import { STR } from "../js/strings.js";
import "./test-env.mjs";

test("MEM catalogue, deferred UI text, and wire vocabulary agree", async () => {
  const candidate = COMMAND_CATALOGUE.MEM_READ;
  assert.equal(candidate.sendable, false);
  assert.equal(candidate.commandWord, "42F3 / 22D3");
  assert.deepEqual(candidate.envelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.equal(candidate.requiredEcuState, "KEY_ON_ENGINE_OFF");
  assert.equal(candidate.parityStatus, "UNRESOLVED_MISMATCH");
  assert.match(candidate.description, /unverified for SME-105/);
  assert.match(candidate.description, /parity byte 93 differs.*2293/);
  assert.match(candidate.blockedReason, /Deferred pending protocol validation/);

  const blocked = DCL_BLOCKED_CANDIDATES.find(item => item.word === candidate.commandWord);
  assert.ok(blocked);
  assert.equal(blocked.reason, candidate.blockedReason);
  assert.match(blocked.label, /Experimental reverse-engineering/);
  assert.equal(STR.confirmMemTitle, "Experimental memory candidate (42F3 / 22D3)");
  assert.equal(STR.confirmMemBody, "Experimental direct memory sequence. Deferred pending protocol validation: target address map unverified and parity differs from generic rule.");
  assert.equal(STR.readIdentity, "Experimental memory read (deferred)");

  const [html, app, ui, firmware, python, readme, discovery, plan] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/ui.js", import.meta.url), "utf8"),
    readFile(new URL("../../firmware/sme105_usb_bridge/sme105_usb_bridge.ino", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/sme105_usb_bridge.py", import.meta.url), "utf8"),
    readFile(new URL("../../firmware/sme105_usb_bridge/README.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/SME105-DCL-command-discovery-2026-11-07.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/superpowers/plans/2026-11-07-sme105-dcl-studio-release.md", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="mem-btn"[^>]*data-str="readIdentity"[^>]*disabled/);
  const handler = app.slice(app.indexOf('getElementById("mem-btn").addEventListener'), app.indexOf('getElementById("reboot-btn")'));
  assert.match(handler, /COMMAND_CATALOGUE\.MEM_READ\.sendable === false/);
  assert.match(handler, /controller\.state\.message = COMMAND_CATALOGUE\.MEM_READ\.blockedReason/);
  assert.ok(handler.indexOf("return;") < handler.indexOf("ask("), "blocked MEM returns before any request dispatch");
  assert.match(ui, /COMMAND_CATALOGUE\.MEM_READ\.sendable === false/);
  assert.match(ui, /\$\("mem-btn"\)\.disabled = true/);
  assert.match(firmware, /DENIED command_deferred_not_sendable/);
  assert.match(firmware, /DEFERRED \(DENIED\): ARM_MEM\/READ_MEM=42F3 \/ 22D3 address_map_unverified parity_93_differs_from_generic_2293/);
  const runCommand = firmware.slice(firmware.indexOf("void runCommand(const char* cmd)"));
  const memGuard = runCommand.indexOf('!strcmp(cmd, "ARM_MEM") || !strcmp(cmd, "READ_MEM")');
  assert.ok(memGuard >= 0, "firmware rejects both MEM commands");
  assert.ok(memGuard < runCommand.indexOf('!strcmp(cmd, "ARM_A4")'), "MEM denial runs before any ARM command handling");
  assert.ok(memGuard < runCommand.indexOf('beginSession(CART_READ, kVariantMem)'), "MEM denial runs before READ can start DPS transmission");
  assert.match(python, /if command in \{"REQUEST_MEM", "ARM_MEM", "READ_MEM"\}:[\s\S]{0,300}REQUEST_MEM is deferred pending protocol validation/);
  assert.match(python, /target address map unverified for SME-105 and parity byte 93 differs from generic rule \(2293\)/);
  assert.match(readme, /memory reads are\s+deferred and denied pending SME-105 address-map and parity validation/);
  assert.match(readme, /\| `ARM_MEM` \/ `READ_MEM` \| \*\*Deferred and denied\*\*/);
  assert.doesNotMatch(readme, /allowlist includes explicitly\s+armed DTC, self-test, live-data, memory/);
  assert.match(discovery, /\| `ARM_MEM` \/ `READ_MEM` \| Local candidate `42F3` \/ `22D3` \| \*\*Deferred \/ not-sendable\*\*/);
  assert.match(discovery, /Firmware denies both before DPS transmission/);
  assert.match(plan, /Superseding MEM disposition[\s\S]{0,400}must remain deferred and be denied before serial\/DPS transmission/);
  assert.equal(candidate.sendable, false, "Android catalogue keeps MEM non-sendable");
});
