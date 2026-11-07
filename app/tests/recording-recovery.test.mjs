import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createRecording, listRecordings, recoverInterruptedRecordings } from "../js/recording.js";

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
