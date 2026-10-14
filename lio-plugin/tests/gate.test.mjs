// Tests the sync GATE decision tree. Run:  node --test tests/gate.test.mjs
//
//   reachable? no  -> "unreachable"   (stop everything, retry later)
//   reachable? yes -> collection? no  -> "invalid-token" (stop, show message)
//                     collection? yes -> "ok"            (do everything)

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- mock browser.storage.local -------------------------------------------
const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_1"],
]);
globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    },
  },
};

// ---- controllable fetch ----------------------------------------------------
let mode = "ok";
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (mode === "down") throw new Error("connection refused");
  if (u.endsWith("/healthz")) {
    if (mode === "health500") return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  }
  if (u.includes("/info")) {
    if (mode === "badtoken") return { ok: false, status: 404 };
    if (mode === "server500") return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => ({ id: "col_1", name: "Personal", bookmark_count: 7 }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { checkGate, resetGate, isGateOpen, lastGate } = await import("../src/lib/gate.ts");

test("server unreachable -> stop everything", async () => {
  resetGate(); mode = "down";
  const g = await checkGate(true);
  assert.equal(g.state, "unreachable");
  assert.equal(isGateOpen(), false);
  assert.match(g.detail, /reach|refused/i);
});

test("unhealthy server is also unreachable, and the token is never probed", async () => {
  resetGate(); mode = "health500"; calls.length = 0;
  const g = await checkGate(true);
  assert.equal(g.state, "unreachable");
  assert.ok(!calls.some((u) => u.includes("/info")), "must not probe the token when the API is down");
});

test("reachable but token unknown -> invalid-token, gate closed", async () => {
  resetGate(); mode = "badtoken";
  const g = await checkGate(true);
  assert.equal(g.state, "invalid-token");
  assert.equal(isGateOpen(), false);
  assert.match(g.detail, /does not recognise/i);
});

test("reachable and token valid -> ok, with collection identity", async () => {
  resetGate(); mode = "ok";
  const g = await checkGate(true);
  assert.equal(g.state, "ok");
  assert.equal(isGateOpen(), true);
  assert.equal(g.collectionName, "Personal");
  assert.equal(g.serverBookmarkCount, 7);
});

test("5xx on the collection is treated as unreachable, not a bad token", async () => {
  resetGate(); mode = "server500";
  const g = await checkGate(true);
  assert.equal(g.state, "unreachable");
});

test("a fresh verdict is reused instead of re-probing every call", async () => {
  resetGate(); mode = "ok";
  await checkGate(true);
  calls.length = 0;
  await checkGate();          // cached
  await checkGate();          // cached
  assert.equal(calls.length, 0, "cached verdict must not hit the network");
  await checkGate(true);      // forced
  assert.ok(calls.length > 0, "forced check must re-probe");
});

test("recovery is observable: closed -> open", async () => {
  resetGate(); mode = "down";
  assert.equal((await checkGate(true)).state, "unreachable");
  mode = "ok";
  assert.equal((await checkGate(true)).state, "ok");
  assert.equal(lastGate().state, "ok");
});
