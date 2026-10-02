import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import pluginModule from "../dist/plugin.js";

const { plugin } = pluginModule;
const TOKEN = "secret-token-value";
const OUTLINE_OK = JSON.stringify({ ok: true, data: { id: "doc-1" } });

let requests;
let originalFetch;
let originalAllowlist;

beforeEach(() => {
  requests = [];
  originalFetch = globalThis.fetch;
  originalAllowlist = process.env.OUTLINE_ALLOWED_API_BASES;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(OUTLINE_OK, { status: 200, headers: { "Content-Type": "application/json" } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAllowlist === undefined) delete process.env.OUTLINE_ALLOWED_API_BASES;
  else process.env.OUTLINE_ALLOWED_API_BASES = originalAllowlist;
});

function readDocument(apiBase) {
  const action = plugin.actions.find((candidate) => candidate.id === "get_document");
  const auth = apiBase === undefined ? { accessToken: TOKEN } : { accessToken: TOKEN, apiBase };
  return action.execute({ actionId: "get_document", input: { id: "doc-1" }, auth });
}

async function assertRefused(apiBase) {
  await assert.rejects(readDocument(apiBase), (error) => !String(error.message).includes(TOKEN));
  assert.deepEqual(requests, [], "a refused destination must not be contacted and must not receive the token");
}

describe("Outline destination allowlist", () => {
  it("refuses a self-hosted API URL that is not listed", async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = "https://wiki.example.com/api";
    await assert.rejects(readDocument("https://other.example.com/api"), /OUTLINE_ALLOWED_API_BASES/);
    assert.deepEqual(requests, []);
  });

  it("refuses every self-hosted API URL when the allowlist is empty or unset", async () => {
    delete process.env.OUTLINE_ALLOWED_API_BASES;
    await assertRefused("https://wiki.example.com/api");
    process.env.OUTLINE_ALLOWED_API_BASES = " , ";
    await assertRefused("https://wiki.example.com/api");
  });

  it("refuses another path on a listed host", async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = "https://wiki.example.com/api";
    await assertRefused("https://wiki.example.com/other");
  });

  it("reads a listed API URL once at the exact method endpoint without following redirects", async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = "https://first.example.com/api, https://wiki.example.com/api/";
    const result = await readDocument("https://wiki.example.com/api/");
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://wiki.example.com/api/documents.info");
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it("reads hosted Outline without listing it, because that is the default destination", async () => {
    delete process.env.OUTLINE_ALLOWED_API_BASES;
    const result = await readDocument(undefined);
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://app.getoutline.com/api/documents.info");
  });

  for (const [label, apiBase] of [
    ["plain http", "http://wiki.example.com/api"],
    ["embedded credentials", "https://user:pass@wiki.example.com/api"],
    ["a query string", "https://wiki.example.com/api?debug=1"],
    ["a fragment", "https://wiki.example.com/api#top"],
  ]) {
    it(`refuses a listed host when the API URL uses ${label}`, async () => {
      process.env.OUTLINE_ALLOWED_API_BASES = "https://wiki.example.com/api";
      await assertRefused(apiBase);
    });
  }

  it("refuses an allowlist entry that is not a safe HTTPS URL", async () => {
    process.env.OUTLINE_ALLOWED_API_BASES = "http://wiki.example.com/api";
    await assertRefused("https://wiki.example.com/api");
  });
});
