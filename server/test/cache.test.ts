import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { CacheNode, cacheFor } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";

const resolverWithCache = () => {
  const context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  return { resolver, context };
};

// A resolver's cache is its own: what one sets, connects or clears never
// reaches another resolver in the process, sessions included.
test("two resolvers keep separate caches", async () => {
  const a = resolverWithCache();
  const b = resolverWithCache();
  try {
    await a.resolver({ "$cache-set": "greeting", value: "hi" }, {});
    assert.equal(await a.resolver({ "$cache-get": "greeting" }, {}), "hi");
    assert.equal(await b.resolver({ "$cache-get": "greeting" }, {}), undefined);

    await b.resolver({ $cache: "clear" }, {});
    assert.equal(await a.resolver({ "$cache-get": "greeting" }, {}), "hi");
    assert.notEqual(cacheFor(a.context), cacheFor(b.context));
  } finally {
    a.resolver.destroy();
    b.resolver.destroy();
  }
});

test("a session started in one resolver is not loaded by another", async () => {
  const a = resolverWithCache();
  const b = resolverWithCache();
  try {
    const started: Record<string, unknown> = { request: { cookies: {} }, _cookies: [] };
    await a.resolver({ $session: { user: "ada" } }, started);
    const sid = (started._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1];
    assert.ok(sid, "a session cookie was set");

    const inA: Record<string, unknown> = { request: { cookies: { sid } }, _cookies: [] };
    await a.resolver({ $session: "load" }, inA);
    assert.equal((inA.session as Record<string, unknown>).user, "ada");

    const inB: Record<string, unknown> = { request: { cookies: { sid } }, _cookies: [] };
    await b.resolver({ $session: "load" }, inB);
    assert.equal((inB.session as Record<string, unknown> | undefined)?.user, undefined);
  } finally {
    a.resolver.destroy();
    b.resolver.destroy();
  }
});
