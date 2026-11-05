import test from "node:test";
import assert from "node:assert/strict";
import * as fake from "fake-indexeddb";
import { redactDiagnostic } from "../js/diagnostics.js";

test("diagnostic redaction removes labeled pairing, Wi-Fi, path, and device identifiers", () => {
  const safe = redactDiagnostic("pair=123456 ssid=garage psk=private mac=AA:BB:CC:DD:EE:FF /home/maxim/private.txt");
  assert.doesNotMatch(safe, /123456|garage|private|AA:BB:CC|\/home\/maxim/);
  assert.match(safe, /REDACTED_PASSKEY/);
  assert.match(safe, /REDACTED_WIFI_SECRET/);
  assert.match(safe, /REDACTED_DEVICE_ID/);
  assert.match(safe, /LOCAL_PATH/);
});

test("structured run log persists raw, samples, warnings, and marks an unclosed prior run", async () => {
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  const { startDiagnosticRun, recordBridgeRaw, recordDiagnosticSample, recordDiagnosticWarning,
    diagnosticSnapshot, closeDiagnosticRun } = await import("../js/diagnostics.js?durable-test");

  const first = await startDiagnosticRun();
  await recordBridgeRaw("RXB t_us=1 data=00 pair=123456");
  await recordDiagnosticSample({ name: "N", t: 0.5, raw: 242, value: 968, unit: "rpm", receivedAt: 1000 }, { variant: "LIVE" });
  await recordDiagnosticWarning("stored-157", true, { severity: "amber", sensor: "DTC 157", ruleId: "DTC-157", reason: "MAF circuit context", source: "0E read mode 26H", evidence: { raw: [1, 2] } });
  let snapshot = await diagnosticSnapshot();
  assert.equal(snapshot.raw.length, 1);
  assert.doesNotMatch(snapshot.raw[0].line, /123456/);
  assert.equal(snapshot.samples[0].pid, "0x01");
  assert.equal(snapshot.warnings[0].active, true);
  await closeDiagnosticRun("test");

  await startDiagnosticRun();
  await recordDiagnosticWarning("stored-157", false, {});
  await closeDiagnosticRun("test");
  const interrupted = await startDiagnosticRun();
  await startDiagnosticRun();
  snapshot = await diagnosticSnapshot();
  assert.ok(snapshot.events.some(event => event.runId === interrupted.id && event.type === "SESSION_ABNORMAL_TERMINATION"));
  assert.equal(snapshot.warnings.find(item => item.key === "stored-157").active, false);
  assert.ok(snapshot.events.every(event => event.utc && Number.isFinite(event.monotonic_us) && event.appBuild && event.category));
});
