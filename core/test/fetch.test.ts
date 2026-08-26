import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Capture the request the node builds, and answer with a JSON body. */
function stubFetch(): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{\"ok\":true}", {
      headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;
  return { calls };
}

/** Headers the node passed, lowercased by the Headers object itself. */
function sentHeaders(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

test("fetch: sends literal and expression headers", async () => {
  const { calls } = stubFetch();
  const out = await resolve(
    {
      fetch: "/api/me",
      headers: {
        Authorization: { concat: ["Bearer ", { var: "$token" }] },
        Accept: "application/json",
      },
    },
    { token: "abc123" },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(sentHeaders(calls[0].init), {
    authorization: "Bearer abc123",
    accept: "application/json",
  });
});

test("fetch: an author Content-Type replaces the JSON default, whatever its casing", async () => {
  const { calls } = stubFetch();
  await resolve(
    {
      fetch: "/api/form",
      method: "POST",
      body: "a=1&b=2",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    {},
  );
  assert.equal(sentHeaders(calls[0].init)["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].init.body, "a=1&b=2");
});

test("fetch: an object body still defaults to JSON", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/users", method: "POST", body: { name: { var: "$name" } } }, { name: "Ada" });
  assert.equal(sentHeaders(calls[0].init)["content-type"], "application/json");
  assert.equal(calls[0].init.body, "{\"name\":\"Ada\"}");
});

test("fetch: headers named after a handler key are not dispatched as nodes", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/me", headers: { var: "$notAPath", if: "cond" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { var: "$notAPath", if: "cond" });
});

test("fetch: null/undefined header values are dropped", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/me", headers: { Authorization: { var: "$missing" }, Accept: "text/plain" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { accept: "text/plain" });
});
