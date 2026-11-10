import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createRecording, listRecordings, recoverInterruptedRecordings, takeoverRecording } from "../js/recording.js";
import { restoreCaptureHistory } from "../js/app.js";
import { createController } from "../js/controller.js";

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
  estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }), persist: async () => true,
} } });

async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("eeciv-recordings", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCapture(id) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction("captures").objectStore("captures").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateCapture(id, update) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("captures", "readwrite");
    const store = tx.objectStore("captures");
    const request = store.get(id);
    request.onsuccess = () => store.put({ ...request.result, ...update });
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

async function chunkCount(id) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const request = database.transaction("chunks").objectStore("chunks").getAll();
    request.onsuccess = () => resolve(request.result.filter(chunk => chunk.id === id).length);
    request.onerror = () => reject(request.error);
  });
}

function installFakeClock() {
  const timers = [];
  let now = Date.now();
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  Date.now = () => now;
  globalThis.setInterval = (callback, delay) => {
    const timer = { callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = timer => { if (timer) timer.active = false; };
  return {
    timers,
    advance: milliseconds => { now += milliseconds; },
    tick: delay => timers.filter(timer => timer.active && timer.delay === delay)
      .forEach(timer => timer.callback()),
    restore() {
      Date.now = originalNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

function holdNextChunkFlushCompletion() {
  const original = fake.IDBDatabase.prototype.transaction;
  let release;
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = original.call(this, stores, mode, ...args);
    if (Array.isArray(stores) && stores.includes("captures") && stores.includes("chunks") && mode === "readwrite") {
      let oncomplete = tx.oncomplete;
      Object.defineProperty(tx, "oncomplete", {
        configurable: true,
        get: () => oncomplete,
        set: callback => {
          oncomplete = callback ? function(event) {
            release = () => callback.call(this, event);
            ready();
          } : null;
        },
      });
    }
    return tx;
  };
  return {
    ready: waiting,
    release() { release?.(); },
    restore() { fake.IDBDatabase.prototype.transaction = original; },
  };
}

function nextDatabaseTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test("fresh leases from this tab and another tab are not recovered", async () => {
  const sameTab = await createRecording("LIVE");
  const db = await openDb();
  const otherTabId = "other-tab-active-capture";
  await new Promise((resolve, reject) => {
    const tx = db.transaction("captures", "readwrite");
    tx.objectStore("captures").add({
      id: otherTabId, variant: "ALL", started: Date.now(), writerToken: "writer-other-tab",
      writerHeartbeat: Date.now(), fencingGen: 7,
    });
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  assert.equal(await recoverInterruptedRecordings(), 0);
  assert.equal((await readCapture(sameTab.id)).ended, undefined);
  assert.equal((await readCapture(otherTabId)).ended, undefined);
  await sameTab.finish({ valid: false, status: "INCOMPLETE" });
  await updateCapture(otherTabId, { ended: Date.now(), verdict: { valid: false, status: "INCOMPLETE" } });
});

test("an expired writer lease is atomically recovered as incomplete", async () => {
  const recording = await createRecording("DMRMAP");
  await updateCapture(recording.id, { writerHeartbeat: Date.now() - 16000 });
  assert.equal(await recoverInterruptedRecordings(), 1);
  const recovered = await readCapture(recording.id);
  assert.equal(recovered.recovered, true);
  assert.ok(recovered.ended);
  assert.equal(recovered.writerToken, null);
  assert.equal(recovered.writerHeartbeat, null);
  assert.equal(recovered.fencingGen, 2);
  assert.equal(recovered.verdict.status, "INCOMPLETE");
  assert.equal(recovered.verdict.valid, false);
  await assert.rejects(recording.finish({ valid: true, status: "VALID" }), /fenced/);
});

test("a fenced writer cannot append chunks or overwrite recovered metadata", async () => {
  const recording = await createRecording("PIDMAP");
  await updateCapture(recording.id, { writerHeartbeat: Date.now() - 16000 });
  await recoverInterruptedRecordings();
  recording.line("RX t_us=10 byte=AA");
  await recording.export("raw");
  assert.equal(await chunkCount(recording.id), 0);
  await assert.rejects(recording.finish({ valid: true, status: "VALID" }), /fenced/);
  const recovered = await readCapture(recording.id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.verdict.status, "INCOMPLETE");
  assert.equal(recovered.fencingGen, 2);
});

test("concurrent recovery transactions fence an expired capture once", async () => {
  const recording = await createRecording("DMR");
  await updateCapture(recording.id, { writerHeartbeat: Date.now() - 16000 });
  const counts = await Promise.all([recoverInterruptedRecordings(), recoverInterruptedRecordings()]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
  const recovered = await readCapture(recording.id);
  assert.equal(recovered.fencingGen, 2);
  assert.equal(recovered.recovered, true);
  await assert.rejects(recording.finish({ valid: true, status: "VALID" }), /fenced/);
});

test("normal finish releases writer ownership without recovery", async () => {
  const clock = installFakeClock();
  try {
    const recording = await createRecording("ECU_STATUS");
    const initial = await readCapture(recording.id);
    assert.equal(initial.writerToken, recording.writerToken);
    assert.equal(initial.fencingGen, 1);
    await recording.finish({ valid: true, status: "VALID" });
    const saved = await readCapture(recording.id);
    assert.ok(saved.ended);
    assert.equal(saved.writerToken, null);
    assert.equal(saved.writerHeartbeat, null);
    assert.equal(saved.fencingGen, 1);
    assert.equal(saved.verdict.status, "VALID");
    assert.equal(await recoverInterruptedRecordings(), 0);
    assert.ok((await listRecordings()).some(item => item.id === recording.id));
    assert.equal(clock.timers.find(timer => timer.delay === 5000).active, false);
  } finally {
    clock.restore();
  }
});

test("a takeover request in the owning WebView reuses its active writer", async () => {
  const recording = await createRecording("LIVE");
  const adopted = await takeoverRecording(recording.id);
  assert.equal(adopted, recording);
  assert.equal((await readCapture(recording.id)).fencingGen, 1);
  await adopted.finish({ valid: false, status: "INCOMPLETE", reasons: ["test cleanup"] });
});

test("a recreated WebView atomically takes over the writer and preserves an incomplete verdict", async () => {
  const original = await createRecording("LIVE");
  original.line("EVENT session=READ_CANDIDATE epoch=9 boot_id=77 session_id=31");
  await original.export("raw");

  const reopenedModule = await import(`../js/recording.js?webview=${crypto.randomUUID()}`);
  const recovered = await reopenedModule.takeoverRecording(original.id);
  const active = await readCapture(original.id);
  assert.equal(active.fencingGen, 2);
  assert.equal(active.writerTakeovers, 1);
  assert.notEqual(active.writerToken, original.writerToken);

  recovered.recordGap(2, 41, 42);
  recovered.line("RX t_us=120 byte=AC seq=43");
  await assert.rejects(original.finish({ valid: true, status: "VALID" }), /fenced/);
  await recovered.finish({ valid: true, status: "INCOMPLETE", reasons: ["resume was denied"] });

  const saved = await readCapture(original.id);
  assert.equal(saved.verdict.valid, false);
  assert.equal(saved.verdict.status, "INCOMPLETE");
  assert.deepEqual(saved.sequenceGaps.map(({ lost, from, to }) => ({ lost, from, to })), [{ lost: 2, from: 41, to: 42 }]);
  assert.equal(saved.sequenceGapCount, 2);
  assert.equal(saved.writerToken, null);
  const raw = await (await import("../js/recording.js")).recordingBlob(original.id, "raw").then(blob => blob.text());
  assert.match(raw, /EVENT session=READ_CANDIDATE/);
  assert.match(raw, /EVENT sequence_gap lost=2 from=41 to=42/);
  assert.match(raw, /RX t_us=120 byte=AC seq=43/);
  assert.doesNotMatch(raw, /^END /m);
});

test("heartbeat protects a writer through a delayed final flush beyond the lease", async () => {
  const clock = installFakeClock();
  const gate = holdNextChunkFlushCompletion();
  try {
    const recording = await createRecording("LIVE");
    recording.line("END reason=16");
    const finishing = recording.finish({ valid: true, status: "VALID" });
    await gate.ready;
    assert.equal(recording.closed, true);

    // Four deterministic heartbeat intervals extend beyond the 15 second lease.
    for (let index = 0; index < 4; index++) {
      clock.advance(5000);
      clock.tick(5000);
      await nextDatabaseTurn();
    }
    const live = await readCapture(recording.id);
    assert.ok(Date.now() - live.writerHeartbeat < 15000);
    assert.deepEqual(await Promise.all([
      recoverInterruptedRecordings(),
      recoverInterruptedRecordings(),
    ]), [0, 0]);
    assert.equal((await readCapture(recording.id)).ended, undefined);

    gate.release();
    await finishing;
    const saved = await readCapture(recording.id);
    assert.equal(saved.verdict.status, "VALID");
    assert.ok(saved.ended);
    assert.equal(saved.writerHeartbeat, null);
    assert.equal(clock.timers.find(timer => timer.delay === 5000).active, false);
  } finally {
    gate.restore();
    clock.restore();
  }
});

test("recovery wins a stale finalization race without conflicting metadata", async () => {
  const clock = installFakeClock();
  const gate = holdNextChunkFlushCompletion();
  try {
    const recording = await createRecording("PIDMAP");
    recording.line("RX t_us=1 byte=AA");
    await updateCapture(recording.id, { writerHeartbeat: Date.now() - 16000 });
    const finishing = recording.finish({ valid: true, status: "VALID" });
    await gate.ready;

    assert.equal(await recoverInterruptedRecordings(), 1);
    const recovered = await readCapture(recording.id);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.verdict.status, "INCOMPLETE");
    const recoveredEnd = recovered.ended;

    gate.release();
    await assert.rejects(finishing, /fenced/);
    const saved = await readCapture(recording.id);
    assert.equal(saved.recovered, true);
    assert.equal(saved.ended, recoveredEnd);
    assert.equal(saved.fencingGen, 2);
    assert.equal(saved.verdict.status, "INCOMPLETE");
    assert.equal(saved.writerToken, null);
    assert.equal(clock.timers.find(timer => timer.delay === 5000).active, false);
  } finally {
    gate.restore();
    clock.restore();
  }
});

test("a storage failure is finalized as incomplete and releases the heartbeat", async () => {
  const clock = installFakeClock();
  const original = fake.IDBDatabase.prototype.transaction;
  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = original.call(this, stores, mode, ...args);
    if ((stores === "chunks" || stores.includes?.("chunks")) && mode === "readwrite")
      queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    const recording = await createRecording("LIVE");
    recording.line("END reason=19");
    await recording.finish({ valid: true, status: "VALID", reasons: [] });
    const saved = await readCapture(recording.id);
    assert.equal(saved.verdict.valid, false);
    assert.equal(saved.verdict.status, "INCOMPLETE");
    assert.deepEqual(saved.verdict.reasons, ["Recording chunk write failed"]);
    assert.equal(saved.outcome, "STORAGE_FAILURE");
    assert.equal(saved.error, "Recording chunk write failed");
    assert.equal(clock.timers.find(timer => timer.delay === 5000).active, false);
  } finally {
    fake.IDBDatabase.prototype.transaction = original;
    clock.restore();
  }
});

test("a heartbeat transaction in flight when finalization starts settles cleanly without false fencing", async () => {
  const clock = installFakeClock();
  let reportedError = null;
  const recording = await createRecording("LIVE", err => { reportedError = err; });

  const originalTx = fake.IDBDatabase.prototype.transaction;
  let releaseHeartbeat;
  let heartbeatRunning;
  const heartbeatTriggered = new Promise(resolve => { heartbeatRunning = resolve; });
  let holdHeartbeat = true;

  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = originalTx.call(this, stores, mode, ...args);
    if (holdHeartbeat && stores === "captures" && mode === "readwrite") {
      holdHeartbeat = false;
      let oncomplete = tx.oncomplete;
      Object.defineProperty(tx, "oncomplete", {
        configurable: true,
        get: () => oncomplete,
        set: callback => {
          oncomplete = callback ? function(event) {
            releaseHeartbeat = () => callback.call(this, event);
            heartbeatRunning();
          } : null;
        },
      });
    }
    return tx;
  };

  try {
    clock.advance(5000);
    clock.tick(5000);
    await heartbeatTriggered;

    const finishing = recording.finish({ valid: true, status: "VALID" });
    await nextDatabaseTurn();

    const preCapture = await readCapture(recording.id);
    assert.equal(preCapture.ended, undefined, "final metadata must not be committed before in-flight heartbeat settles");

    releaseHeartbeat();
    await finishing;

    assert.equal(reportedError, null, "onError must never be invoked by an in-flight heartbeat during finalization");
    const saved = await readCapture(recording.id);
    assert.equal(saved.verdict.status, "VALID");
    assert.equal(saved.verdict.valid, true);
    assert.ok(saved.ended, "ended timestamp must be set");
    assert.equal(saved.writerToken, null);
    assert.equal(saved.writerHeartbeat, null);
    assert.equal(clock.timers.find(timer => timer.delay === 5000).active, false, "heartbeat timer must be inactive");
  } finally {
    fake.IDBDatabase.prototype.transaction = originalTx;
    clock.restore();
  }
});

test("heartbeat callback arriving after finalization does not resurrect capture or call onError", async () => {
  const clock = installFakeClock();
  let reportedError = null;
  const recording = await createRecording("LIVE", err => { reportedError = err; });

  const originalTx = fake.IDBDatabase.prototype.transaction;
  let delayedSuccess;
  let getIntercepted = false;

  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = originalTx.call(this, stores, mode, ...args);
    if (!getIntercepted && stores === "captures" && mode === "readwrite") {
      const originalStore = tx.objectStore.bind(tx);
      tx.objectStore = function(name) {
        const store = originalStore(name);
        if (name === "captures" && !getIntercepted) {
          const origGet = store.get.bind(store);
          store.get = function(key) {
            const req = origGet(key);
            if (!getIntercepted) {
              getIntercepted = true;
              let onsuccess = req.onsuccess;
              Object.defineProperty(req, "onsuccess", {
                configurable: true,
                get: () => onsuccess,
                set: callback => {
                  onsuccess = callback ? function(event) {
                    delayedSuccess = () => callback.call(this, event);
                  } : null;
                },
              });
            }
            return req;
          };
        }
        return store;
      };
    }
    return tx;
  };

  try {
    clock.advance(5000);
    clock.tick(5000);
    await nextDatabaseTurn();

    // Now finalization occurs while the heartbeat's get request callback is still held
    await recording.finish({ valid: true, status: "VALID" });
    const saved = await readCapture(recording.id);
    assert.equal(saved.verdict.status, "VALID");

    // Release the delayed heartbeat callback now (which sees ended=true in DB)
    if (delayedSuccess) delayedSuccess();
    await nextDatabaseTurn();

    // Verify onError was NOT called and verdict was NOT changed
    assert.equal(reportedError, null, "delayed heartbeat must not trigger onError or report writer fenced");
    const recheck = await readCapture(recording.id);
    assert.equal(recheck.verdict.status, "VALID");
    assert.equal(recheck.error, "");
  } finally {
    fake.IDBDatabase.prototype.transaction = originalTx;
    clock.restore();
  }
});

test("restoreCaptureHistory uses durable archive cursor instead of optimistic snapshot, replays uncommitted data, and creates no premature gap", async () => {
  const recording = await createRecording("LIVE");
  recording.line("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1\n");
  recording.line("EVENT session=READ_CANDIDATE epoch=9 boot_id=12345678 session_id=87654321\n");
  recording.line("RX t_us=100 byte=3A seq=50\n");
  recording.line("RX t_us=200 byte=41 seq=51\n");
  await recording.export("raw");

  // Optimistic in-memory snapshot was ahead at seq 55 before the crash
  const snapshot = {
    recordingId: recording.id,
    variant: "LIVE",
    bootId: "12345678",
    sessionId: "87654321",
    lastSeq: 55,
    savedAt: Date.now(),
    operatorStop: false,
  };

  const { session, cart } = await restoreCaptureHistory(recording, snapshot);

  // 1. Persisted sequence 51 must be used, NOT the optimistic 55
  assert.equal(session.lastSeq, 51, "Session cursor must be restored strictly from durable archive");
  assert.equal(session.bootId, "12345678");
  assert.equal(session.sessionId, "87654321");

  // 2. No premature gap must be fabricated
  assert.equal(session.sequenceGaps.length, 0, "No premature gap should be fabricated before replay");

  // 3. Connect controller with restored state to verify RESUME cursor and replay of uncommitted data
  const sent = [];
  const ctrl = createController({
    now: () => 10000,
    send: (cmd) => sent.push(cmd),
  });

  ctrl.state.archive = recording;
  ctrl.state.cart = cart;
  ctrl.state.op = {
    variant: "LIVE",
    kind: "live",
    source: "bridge",
    startedAt: Date.now(),
    operatorStop: false,
    forceStatus: null,
    forceReason: "",
    session,
  };
  ctrl.state.link = "reconnecting";
  ctrl.state.phase = "read";
  ctrl.state.transport = "wifi";
  ctrl.state.resuming = false;

  // On reconnect, controller must issue RESUME using durable seq 51 (not 55)
  ctrl.onConnected("TestBridge", "wifi", { reconnected: true });
  ctrl.handleLine("AUTH OK retained=1");
  const resumeCmd = sent.find(cmd => cmd.startsWith("RESUME"));
  assert.equal(resumeCmd, "RESUME 12345678 87654321 51", "RESUME wire command must resume from durable archive sequence");

  // Firmware acknowledges resume and indicates no ring gap
  ctrl.handleLine("RESUME OK boot=12345678 session=87654321 gap=0 from=0 to=0 replaying=1");

  // Retained uncommitted records (52, 53) are replayed and accepted
  ctrl.handleLine("RX t_us=300000 byte=52 seq=52");
  assert.equal(ctrl.state.op.session.lastSeq, 52);

  ctrl.handleLine("RX t_us=400000 byte=53 seq=53");
  assert.equal(ctrl.state.op.session.lastSeq, 53);

  // Duplicate delivery of seq 51 must be dropped
  ctrl.handleLine("RX t_us=200000 byte=41 seq=51");
  assert.equal(ctrl.state.op.session.lastSeq, 53);

  // Final check: exactly 4 records ingested (50, 51 from archive + 52, 53 replayed)
  assert.equal(ctrl.state.op.session.rx, 4);
  assert.equal(ctrl.state.op.session.sequenceGaps.length, 0, "No false gap should exist");

  await recording.finish({ valid: true, status: "VALID", reasons: [] });
});
