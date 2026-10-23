// Tests that tab updates are strictly event-driven:
// 1. pushNow skips pushing when the tab snapshot is unchanged.
// 2. pushNow pushes when tabs change or session boundary is marked.
// 3. pushService ignores tabs_updated so other devices' tab pushes do not trigger sync loops.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_local"],
  ["deviceName", "My Browser"],
]);

let windowsMock = [
  {
    id: 1,
    type: "normal",
    focused: true,
    tabs: [
      { index: 0, title: "Tab 1", url: "https://example.com/1", favIconUrl: null, pinned: false },
      { index: 1, title: "Tab 2", url: "https://example.com/2", favIconUrl: null, pinned: false },
    ],
  },
];

let alarmsCleared = [];
globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        if (!keys) return Object.fromEntries(store);
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) store.delete(k);
      },
    },
  },
  windows: {
    async getAll() {
      return windowsMock;
    },
  },
  alarms: {
    async create() {},
    async clear(name) { alarmsCleared.push(name); return true; },
  },
};

let putSessionCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || "GET";
  if (u.endsWith("/healthz")) {
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  }
  if (u.includes("/info")) {
    return { ok: true, status: 200, json: async () => ({ id: "col_1", name: "Personal", bookmark_count: 5 }) };
  }
  if (method === "PUT" && u.includes("/tabs/")) {
    putSessionCalls.push({ url: u, body: JSON.parse(opts.body) });
    return { ok: true, status: 204, text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

// Mock WebSocket for pushService testing
class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }
  send() {}
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }
}
globalThis.WebSocket = MockWebSocket;

const { pushNow, markSessionBoundary, resetTabPushCache } = await import("../src/lib/tabs.ts");
const { pushService } = await import("../src/lib/push.ts");

test("pushNow pushes on initial call and skips when tabs are unchanged", async () => {
  resetTabPushCache();
  putSessionCalls = [];

  // First push should happen
  await pushNow();
  assert.equal(putSessionCalls.length, 1, "First pushNow should PUT to server");
  assert.equal(putSessionCalls[0].body.session_boundary, false);

  // Second push with identical tabs should be skipped
  await pushNow();
  assert.equal(putSessionCalls.length, 1, "Second pushNow with unchanged tabs must NOT PUT to server");

  // Modify local tabs
  windowsMock = [
    {
      id: 1,
      type: "normal",
      focused: true,
      tabs: [
        { index: 0, title: "Tab 1", url: "https://example.com/1", favIconUrl: null, pinned: false },
        { index: 1, title: "Tab 2", url: "https://example.com/2", favIconUrl: null, pinned: false },
        { index: 2, title: "Tab 3 New", url: "https://example.com/3", favIconUrl: null, pinned: false },
      ],
    },
  ];

  // Push after change should happen
  await pushNow();
  assert.equal(putSessionCalls.length, 2, "pushNow after tab change must PUT to server");

  // Another identical call must not push
  await pushNow();
  assert.equal(putSessionCalls.length, 2, "pushNow with unchanged tabs must NOT PUT to server");

  // When session boundary is marked, it must push even if tabs are identical
  markSessionBoundary();
  await pushNow();
  assert.equal(putSessionCalls.length, 3, "pushNow with session boundary must PUT to server");
  assert.equal(putSessionCalls[2].body.session_boundary, true);
});

test("pushService ignores tabs_updated and does not trigger onSync", async () => {
  let syncTriggeredCount = 0;
  pushService.start((event) => {
    syncTriggeredCount++;
  });

  // Wait for open
  await new Promise((r) => setTimeout(r, 20));

  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  assert.ok(ws, "WebSocket should be created");

  // Reset count from onopen 'connected' event
  syncTriggeredCount = 0;

  // Remote device updates tabs: tabs_updated should NOT trigger onSync
  ws.onmessage({
    data: JSON.stringify({
      event: "tabs_updated",
      origin: "other_device_456",
      device_id: "other_device_456",
      timestamp: Date.now(),
    }),
  });
  assert.equal(syncTriggeredCount, 0, "tabs_updated from remote device must NOT trigger onSync");

  // Remote device updates bookmarks: bookmarks_updated MUST trigger onSync
  ws.onmessage({
    data: JSON.stringify({
      event: "bookmarks_updated",
      origin: "other_device_456",
      timestamp: Date.now(),
    }),
  });
  assert.equal(syncTriggeredCount, 1, "bookmarks_updated from remote device MUST trigger onSync");

  // Own bookmark update is ignored
  ws.onmessage({
    data: JSON.stringify({
      event: "bookmarks_updated",
      origin: "dev_local",
      timestamp: Date.now(),
    }),
  });
  assert.equal(syncTriggeredCount, 1, "own bookmarks_updated must be ignored");

  pushService.stop();
});
