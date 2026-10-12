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
