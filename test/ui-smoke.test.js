"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function runVerifier(queue) {
  const requested = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        textContent: "",
        className: "",
        innerHTML: "",
        classList: { toggle() {} },
        addEventListener() {},
        closest() { return null; },
      });
    }
    return elements.get(id);
  };
  const context = {
    document: { getElementById: element },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, json: async () => ({ queue }) };
    },
    setInterval() { return 1; },
    alert() {},
    console,
  };
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "verifier", "app.js"), "utf8");
  assert.doesNotThrow(() => vm.runInNewContext(script, context, { filename: "public/verifier/app.js" }));
  await new Promise((resolve) => setImmediate(resolve));
  return { requested, element };
}

test("the verifier console initializes and requests its empty queue without a synchronous browser error", async () => {
  const { requested, element } = await runVerifier([]);
  assert.deepEqual(requested, ["/api/verifier/queue"]);
  assert.equal(element("conn").textContent, "connected");
  assert.match(element("queue").innerHTML, /queue is empty/i);
});

test("the verifier console renders a finalized row after its learner-written content was deleted", async () => {
  const { element } = await runVerifier([{
    id: "review-1",
    status: "expired",
    title: "Library conversation",
    handle: "0x1234567890abcdef",
    at: "2026-08-28T12:00:00.000Z",
    missed: ["required_phrase"],
    configuredReward: 100,
    awarded: 0,
    criteria: [{ met: false, label: "Ask about the group" }],
    choices: [{ id: "choice", prompt: "Choose one", choices: ["A", "B"] }],
  }]);
  assert.equal(element("conn").textContent, "connected");
  assert.match(element("queue").innerHTML, /content removed after review/i);
  assert.match(element("queue").innerHTML, /expired/i);
});
