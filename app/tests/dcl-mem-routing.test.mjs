import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { MEM_EXPERIMENTS } from "../js/protocol.js";
import { listRecordings } from "../js/recording.js";

const waitFor = async predicate => {
  for (let index = 0; index < 300; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the Engineering Lab action");
};

test("Command Explorer routes all MEM profiles through one confirmed MEM run and records comparison results", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const demoTranscript = await readFile(new URL("../demo/read-0e.txt", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/?view=lab" });
  const oldGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const oldNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  globalThis.requestAnimationFrame = callback => { queueMicrotask(callback); return 1; };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.fetch = async () => ({ ok: true, text: async () => demoTranscript });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }), persist: async () => true } },
  });

  try {
    localStorage.setItem("eeciv-demo", "1");
    await import("../js/app.js");
    await waitFor(() => document.getElementById("demo-toggle").checked);
    document.getElementById("connect-btn").click();
    await waitFor(() => document.getElementById("dcl-run-action").disabled === false);

    let confirmationCount = 0;
    let candidateDispatchCount = 0;
    document.addEventListener("dcl:run-candidate", () => { candidateDispatchCount += 1; });
    for (const experiment of MEM_EXPERIMENTS) {
      const candidateId = experiment.id === "MEM" ? "MEMORY_READ" : experiment.id;
      const search = document.getElementById("dcl-command-search");
      search.value = candidateId;
      search.dispatchEvent(new window.Event("input"));
      const card = document.querySelector("#dcl-command-list .dcl-command-card");
      assert.ok(card, `${candidateId} must be listed in Command Explorer`);
      card.click();
      const runAction = document.getElementById("dcl-run-action");
      assert.equal(runAction.disabled, false, `${candidateId} must be runnable through the canonical action`);
      runAction.click();
      await waitFor(() => !document.getElementById("modal").hidden);
      confirmationCount += 1;
      assert.equal(document.getElementById("modal-title").textContent, `Run MEM experiment ${experiment.id}`, "MEM uses its authoritative specialized confirmation");
      document.getElementById("modal-ok").click();
      await waitFor(() => document.querySelector(`#mem-cards-container [data-experiment-id="${experiment.id}"] .mem-status-badge`)?.textContent === "SIMULATED");

      const row = [...document.querySelectorAll("#mem-matrix-body tr")].find(item => item.cells[0].textContent === experiment.id);
      assert.equal(row?.cells[6].textContent, "SIMULATED", `${experiment.id} is shown in the comparison table`);
      assert.equal(document.querySelector(`#mem-cards-container [data-experiment-id="${experiment.id}"] .mem-status-badge`).textContent, "SIMULATED");
      const matchingRecordings = (await listRecordings()).filter(item => item.memExperimentId === experiment.id);
      assert.equal(matchingRecordings.length, 1, `${experiment.id} creates one evidence recording`);
    }
    assert.equal(confirmationCount, MEM_EXPERIMENTS.length, "Each individual MEM run prompts exactly once");
    assert.equal(candidateDispatchCount, MEM_EXPERIMENTS.length, "Each Explorer click dispatches one candidate event");
    assert.equal(document.getElementById("dcl-experiment-export").disabled, false, "MEM evidence keeps the experiment ZIP export available");

    const beforeGenericBatch = await listRecordings();
    document.dispatchEvent(new window.CustomEvent("dcl:run-selected", {
      detail: { candidateIds: ["MEMORY_READ", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY"] },
    }));
    await waitFor(() => document.getElementById("message").textContent.includes("cannot be run in generic batches"));
    assert.equal((await listRecordings()).length, beforeGenericBatch.length, "Generic MEM batch input creates no duplicate recordings");

    document.getElementById("dcl-toggle-multiselect").click();
    const search = document.getElementById("dcl-command-search");
    search.value = "PIDMAP_ALT";
    search.dispatchEvent(new window.Event("input"));
    document.querySelector("#dcl-command-list .dcl-command-card").click();
    const batchDispatches = [];
    document.addEventListener("dcl:run-selected", event => batchDispatches.push(event.detail.candidateIds));
    document.getElementById("dcl-run-action").click();
    assert.deepEqual(batchDispatches, [["PIDMAP_ALT"]]);
    document.getElementById("dcl-stop-selected").click();
    await waitFor(() => document.getElementById("dcl-batch-status").textContent.startsWith("STOPPED"));
    assert.equal(document.getElementById("dcl-stop-selected").disabled, true, "STOP closes the running batch control");
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(oldGlobals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (oldNavigatorDescriptor) Object.defineProperty(globalThis, "navigator", oldNavigatorDescriptor);
    else delete globalThis.navigator;
  }
});
