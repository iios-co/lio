import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConnectDrafts,
  saveConnectDraftField,
  clearConnectDrafts,
  loadSettingsDrafts,
  saveSettingsDraftField,
  clearSettingsDrafts,
  formatConnectionString,
  parseConnectionString,
} from "../src/lib/drafts.ts";

function setupMockStorage() {
  const store = new Map();
  globalThis.browser = {
    storage: {
      local: {
        async get(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) store.delete(k);
        },
      },
    },
  };
  return store;
}

test("production loadConnectDrafts prioritizes draft over committed config and persists across remounts", async () => {
  const store = setupMockStorage();

  // Initially: nothing saved, returns empty drafts and suggested device name
  const init = await loadConnectDrafts(() => "My Browser");
  assert.equal(init.endpoint, "");
  assert.equal(init.token, "");
  assert.equal(init.deviceName, "My Browser");

  // Step 1: User enters endpoint into ConnectFlow
  await saveConnectDraftField("endpoint", "http://10.0.5.202:8000");

  // Step 2: User switches tabs to web app to copy token (popup closes & remounts)
  const remount1 = await loadConnectDrafts(() => "My Browser");
  assert.equal(
    remount1.endpoint,
    "http://10.0.5.202:8000",
    "Endpoint draft must survive popup unmount when switching tabs"
  );
  assert.equal(remount1.token, "");

  // Step 3: User pastes token into ConnectFlow
  await saveConnectDraftField("token", "tok_live123");

  // Step 4: Popup remounts again
  const remount2 = await loadConnectDrafts(() => "My Browser");
  assert.equal(remount2.endpoint, "http://10.0.5.202:8000");
  assert.equal(remount2.token, "tok_live123");

  // Step 5: Successful commit clears drafts
  await clearConnectDrafts();
  // Simulate committed config in storage
  store.set("endpoint", "http://10.0.5.202:8000");
  store.set("token", "tok_live123");

  const postCommit = await loadConnectDrafts(() => "My Browser");
  assert.equal(postCommit.endpoint, "http://10.0.5.202:8000");
  assert.equal(postCommit.token, "tok_live123");
  assert.equal(store.has("draft_endpoint"), false);
  assert.equal(store.has("draft_token"), false);
});

test("production loadSettingsDrafts persists and clears settings drafts", async () => {
  const store = setupMockStorage();

  const empty = await loadSettingsDrafts();
  assert.equal(empty.endpoint, undefined);
  assert.equal(empty.token, undefined);

  // User edits settings fields in popup
  await saveSettingsDraftField("endpoint", "http://new-lio:8000");
  await saveSettingsDraftField("token", "tok_new456");

  // Remount
  const loaded = await loadSettingsDrafts();
  assert.equal(loaded.endpoint, "http://new-lio:8000");
  assert.equal(loaded.token, "tok_new456");

  // Save successful -> clears drafts
  await clearSettingsDrafts();
  const cleared = await loadSettingsDrafts();
  assert.equal(cleared.endpoint, undefined);
  assert.equal(cleared.token, undefined);
  assert.equal(store.has("draft_settings_endpoint"), false);
  assert.equal(store.has("draft_settings_token"), false);
});

test("formatConnectionString and parseConnectionString round trip with Unicode", () => {
  const input = {
    endpoint: "http://10.0.5.202:8000/",
    token: "col_tok_日本語_éè_🚀",
  };
  const code = formatConnectionString(input);
  assert.match(code, /^lio-connect:v1:[A-Za-z0-9_-]+$/);

  const parsed = parseConnectionString(code);
  assert.ok(parsed);
  assert.equal(parsed.endpoint, "http://10.0.5.202:8000");
  assert.equal(parsed.token, "col_tok_日本語_éè_🚀");
});

test("parseConnectionString rejects invalid protocols, credentials, queries, and malformed strings", () => {
  // Non-http(s)
  assert.equal(parseConnectionString("javascript:alert(1)"), null);
  assert.equal(parseConnectionString("ftp://10.0.5.202:8000"), null);

  // Wrong prefix/version
  assert.equal(parseConnectionString("lio-connect:v2:abc"), null);
  assert.equal(parseConnectionString("other:v1:abc"), null);
  assert.equal(parseConnectionString(""), null);

  // Empty token or endpoint in formatConnectionString
  assert.throws(() => formatConnectionString({ endpoint: "", token: "tok123" }));
  assert.throws(() => formatConnectionString({ endpoint: "http://example.com", token: "" }));

  // Credentials in URL
  assert.throws(() => {
    formatConnectionString({
      endpoint: "http://user:pass@10.0.5.202:8000",
      token: "tok123",
    });
  });

  // Query or fragment in URL for formatConnectionString
  assert.throws(() => {
    formatConnectionString({
      endpoint: "http://10.0.5.202:8000?foo=bar",
      token: "tok123",
    });
  });
  assert.throws(() => {
    formatConnectionString({
      endpoint: "http://10.0.5.202:8000#hash",
      token: "tok123",
    });
  });

  // Direct craft with credentials
  const credBytes = new TextEncoder().encode(
    JSON.stringify({ endpoint: "http://user:pass@10.0.5.202:8000", token: "tok123" })
  );
  const b64 = Buffer.from(credBytes).toString("base64url");
  assert.equal(parseConnectionString(`lio-connect:v1:${b64}`), null);

  // Direct craft with query / hash
  const queryBytes = new TextEncoder().encode(
    JSON.stringify({ endpoint: "http://10.0.5.202:8000?foo=bar", token: "tok123" })
  );
  const b64Query = Buffer.from(queryBytes).toString("base64url");
  assert.equal(parseConnectionString(`lio-connect:v1:${b64Query}`), null);

  // Malformed base64 / invalid JSON payload
  assert.equal(parseConnectionString("lio-connect:v1:not-valid-json!"), null);
  const invalidJsonB64 = Buffer.from("{malformed:").toString("base64url");
  assert.equal(parseConnectionString(`lio-connect:v1:${invalidJsonB64}`), null);

  // Valid base path round trip
  const withPath = formatConnectionString({
    endpoint: "https://lio.example.com/sync-proxy",
    token: "tok_secure",
  });
  const parsedWithPath = parseConnectionString(withPath);
  assert.ok(parsedWithPath);
  assert.equal(parsedWithPath.endpoint, "https://lio.example.com/sync-proxy");
  assert.equal(parsedWithPath.token, "tok_secure");
});

test("pasting pairing code populates and persists both endpoint and token", async () => {
  const store = setupMockStorage();
  const code = formatConnectionString({
    endpoint: "http://10.0.5.213:8000",
    token: "col_live999",
  });

  // Simulate paste interceptor logic
  const parsed = parseConnectionString(code);
  assert.ok(parsed);
  await saveConnectDraftField("endpoint", parsed.endpoint);
  await saveConnectDraftField("token", parsed.token);

  // Remount
  const loaded = await loadConnectDrafts(() => "Laptop");
  assert.equal(loaded.endpoint, "http://10.0.5.213:8000");
  assert.equal(loaded.token, "col_live999");
});
