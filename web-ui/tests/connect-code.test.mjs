import { test } from "node:test";
import assert from "node:assert/strict";
import { formatConnectionString } from "../src/lib/connectCode.ts";

test("formatConnectionString produces exact expected pairing code fixture", () => {
  const code = formatConnectionString({
    endpoint: "http://10.0.5.213:8000/",
    token: "col_live999",
  });
  assert.equal(
    code,
    "lio-connect:v1:eyJlbmRwb2ludCI6Imh0dHA6Ly8xMC4wLjUuMjEzOjgwMDAiLCJ0b2tlbiI6ImNvbF9saXZlOTk5In0"
  );
});

test("formatConnectionString rejects invalid endpoints and empty tokens", () => {
  assert.throws(() => formatConnectionString({ endpoint: "", token: "tok1" }));
  assert.throws(() => formatConnectionString({ endpoint: "http://example.com", token: "" }));
  assert.throws(() =>
    formatConnectionString({ endpoint: "http://user:pass@example.com", token: "tok1" })
  );
  assert.throws(() =>
    formatConnectionString({ endpoint: "http://example.com?query=1", token: "tok1" })
  );
  assert.throws(() =>
    formatConnectionString({ endpoint: "http://example.com#hash", token: "tok1" })
  );
});

test("card pairing code generator copies correct pairing code from collection card token", async () => {
  const cardToken = "7cgE0eUR7xrs8EeI";
  const origin = "http://10.0.5.213:8000";

  const code = formatConnectionString({ endpoint: origin, token: cardToken });
  assert.ok(code.startsWith("lio-connect:v1:"));

  // Verify that decoding the base64url payload retrieves the card's exact endpoint and token
  const payloadB64 = code.replace("lio-connect:v1:", "");
  const decodedJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  const parsed = JSON.parse(decodedJson);

  assert.equal(parsed.endpoint, "http://10.0.5.213:8000");
  assert.equal(parsed.token, "7cgE0eUR7xrs8EeI");
});
