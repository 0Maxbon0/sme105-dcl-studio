/** Local ZIP and focused CSV exports. All content is built on-device. */
import { diagnosticSnapshot, recordDiagnosticEvent } from "./diagnostics.js";
import { listRecordings, recordingBlob } from "./recording.js";
import { LIVE_PIDS, LIVE2_PIDS, LIVE3_PIDS, PIDS, displayReading, formatValue } from "./pids.js";
import { sensorsForGroup } from "./live-dashboard.js";

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function samplesCsv(samples, unitSystem = "metric") {
  const columns = ["run_id", "utc", "monotonic_us", "ecu_time_s", "set", "pid", "sensor", "raw", "scaled_value", "native_unit", "display_value", "display_unit", "validity", "time_basis"];
  return [columns.join(","), ...samples.map(sample => {
    const display = displayReading(sample.name, sample.value, { unitSystem });
    return [sample.runId, sample.utc, sample.monotonic_us, sample.t_s, sample.variant, sample.pid, sample.name,
      sample.raw, sample.value, sample.unit, formatValue(display.value), display.unit, sample.validity, sample.timeBasis].map(csvCell).join(",");
  })].join("\n") + "\n";
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export async function saveOrShare(blob, fileName) {
  if (window.Capacitor?.isNativePlatform?.()) {
    const { Filesystem, Directory, Share, ExportStorage } = await import("../vendor/native-bridge.js");
    const file = await Filesystem.writeFile({ path: `diagnostics/${fileName}`, data: toBase64(await blob.arrayBuffer()), directory: Directory.Cache, recursive: true });
    const saved = await ExportStorage.save({ sourceUri: file.uri, fileName });
    await recordDiagnosticEvent("EXPORT_SAVED", { fileName, folder: saved.folder, bytes: blob.size }, "export");
    try {
      return await Share.share({ title: fileName, files: [file.uri], dialogTitle: "Saved in Downloads/SME105 DCL Studio · Share a copy" });
    } catch (error) {
      throw new Error(`File saved in ${saved.folder}; sharing failed: ${error?.message || String(error)}`);
    }
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  return { activityType: "download" };
}

export async function exportDiagnosticZip({ activeArchive = null, unitSystem = "metric" } = {}) {
  await recordDiagnosticEvent("EXPORT_STARTED", { kind: "full-diagnostic-zip" }, "export");
  try {
    if (!window.JSZip) throw new Error("Offline ZIP library is unavailable; reload the installed app before exporting.");
    const snapshot = await diagnosticSnapshot();
    const recordings = await listRecordings();
    const zip = new window.JSZip();
    const dataFiles = new Map();
    const addText = (path, content) => dataFiles.set(path, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
    const journal = snapshot.events.map(event => JSON.stringify(event)).join("\n") + (snapshot.events.length ? "\n" : "");
    addText("journal.jsonl", journal);
    addText("bridge-raw.txt", snapshot.raw.map(item => `${item.utc}\t${item.monotonic_us}\t${item.line}`).join("\n") + (snapshot.raw.length ? "\n" : ""));
    addText("all-sensors.csv", samplesCsv(snapshot.samples, unitSystem));
    addText("warnings.json", snapshot.warnings);
    addText("sensor-provenance.json", { physicalComponents: { MAF: ["0x26 raw counts, no airflow conversion"], IAT: ["0x05 IACT raw", "0x0F ACT ECU temperature"] }, observedIatLagSeconds: 26.323942, fallback: "UNVERIFIED", IEGO1: "0x08 raw counts, no verified millivolt or mixture conversion" });
    addText("operator-events.json", snapshot.events.filter(event => event.type.startsWith("KOER_")));
    addText("kline-sessions.json", snapshot.events.filter(event => event.type.startsWith("KLINE_")));
    addText("dtc-evidence.json", snapshot.events.filter(event => event.type === "SESSION_RESULT"));
    addText("app-errors.jsonl", snapshot.events.filter(event => event.category === "error" || event.type.includes("ERROR")).map(event => JSON.stringify(event)).join("\n") + "\n");

    const pidNames = list => list.map(pid => PIDS[pid]?.[0]).filter(Boolean);
    const groups = { LIVE: pidNames(LIVE_PIDS), LIVE2: pidNames(LIVE2_PIDS), LIVE3: pidNames(LIVE3_PIDS) };
    for (const [group, names] of Object.entries(groups)) addText(`groups/${group}.csv`, samplesCsv(snapshot.samples.filter(sample => names.includes(sample.name)), unitSystem));
    const names = [...new Set(snapshot.samples.map(sample => sample.name))].sort();
    for (const name of names) addText(`sensors/${name}.csv`, samplesCsv(snapshot.samples.filter(sample => sample.name === name), unitSystem));

    const allCsv = [];
    for (const recording of recordings) {
      const safeName = recording.id.replace(/[^a-z0-9._-]/gi, "_");
      const current = activeArchive?.id === recording.id ? activeArchive : null;
      const csv = current ? await current.export("csv") : await recordingBlob(recording.id, "csv");
      const raw = current ? await current.export("raw") : await recordingBlob(recording.id, "raw");
      const [csvText, rawText] = await Promise.all([csv.text(), raw.text()]);
      addText(`recordings/${safeName}.csv`, csvText);
      addText(`recordings/${safeName}.raw.txt`, rawText);
      allCsv.push(csvText);
    }
    if (snapshot.samples.length && recordings.length === 0) allCsv.push(samplesCsv(snapshot.samples, unitSystem));
    const manifest = {
      schema: "sme105-diagnostic-zip/v1", createdUtc: new Date().toISOString(), appBuild: snapshot.run?.appBuild || "unknown",
      currentRun: snapshot.run, runs: snapshot.runs, recordings,
      captureCount: recordings.length, sensorSampleCount: snapshot.samples.length, rawLineCount: snapshot.raw.length,
      journalStorage: snapshot.storage,
      sources: ["SME105 real USB captures in captures/SME105_97AB", "Ford Escort 1.6 Zetec reference notes in docs/sensor-reference-verification-2026-11-05.md"],
      testContext: "Offline local export. Sensor rows preserve ECU-relative and receive timestamps, raw value, scaled value, PID, set, and validity.",
      sha256Manifest: "sha256-manifest.txt covers every file except itself.",
    };
    addText("run-manifest.json", manifest);
    for (const [path, content] of dataFiles) zip.file(path, content);
    const checksums = [];
    for (const [path, content] of dataFiles) {
      const bytes = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      checksums.push(`${hash}  ${path}`);
    }
    zip.file("sha256-manifest.txt", checksums.join("\n") + "\n");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } });
    const verified = await window.JSZip.loadAsync(await blob.arrayBuffer());
    for (const entry of checksums) {
      const [expected, path] = entry.split(/\s+/, 2);
      const bytes = await verified.file(path).async("uint8array");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (actual !== expected) throw new Error(`ZIP integrity check failed: ${path}`);
    }
    const fileName = `sme105-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.zip`;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const zipHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    await recordDiagnosticEvent("EXPORT_CREATED", { fileName, bytes: blob.size, sha256: zipHash }, "export");
    await saveOrShare(blob, fileName);
    await recordDiagnosticEvent("EXPORT_SHARED", { fileName, bytes: blob.size, sha256: zipHash }, "export");
    return { fileName, size: blob.size, sha256: zipHash };
  } catch (error) {
    await recordDiagnosticEvent("EXPORT_FAILED", { reason: error?.message || String(error) }, "error");
    throw error;
  }
}

export async function exportSensorCsv(name, { unitSystem = "metric" } = {}) {
  const snapshot = await diagnosticSnapshot();
  const samples = snapshot.samples.filter(sample => sample.name === name);
  if (!samples.length) throw new Error(`No saved readings for ${name}.`);
  const blob = new Blob([samplesCsv(samples, unitSystem)], { type: "text/csv" });
  await saveOrShare(blob, `sme105-sensor-${name}.csv`);
  await recordDiagnosticEvent("EXPORT_CREATED", { kind: "sensor-csv", sensor: name, rows: samples.length }, "export");
}

export async function exportGroupCsv(group, { unitSystem = "metric", manual = true } = {}) {
  const snapshot = await diagnosticSnapshot();
  const names = new Set((group === "overview" ? ["N", "ECT", "VBAT", "ITP", "LOAD"] : sensorsForGroup(group, { manual })).map(sensor => sensor.name));
  const samples = snapshot.samples.filter(sample => names.has(sample.name));
  if (!samples.length) throw new Error("No saved readings are available for this group.");
  const blob = new Blob([samplesCsv(samples, unitSystem)], { type: "text/csv" });
  await saveOrShare(blob, `sme105-group-${group}.csv`);
  await recordDiagnosticEvent("EXPORT_CREATED", { kind: "group-csv", group, rows: samples.length }, "export");
}
