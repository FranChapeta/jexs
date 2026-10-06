import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { CacheNode, cacheFor } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";
import { TranslationNode } from "../src/nodes/Translation.js";
import { sha256 } from "../src/nodes/Crypto.js";

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

// Named caches work like named database connections: the first one opened is
// the default, and `connection` picks another; other nodes' ops pick one with
// `cache`.
test("named caches keep separate values, and the first connected is the default", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cache-connect": "memory", connection: "app" }, {});
    await resolver({ "$cache-connect": "memory", connection: "scratch" }, {});
    await resolver({ "$cache-set": "k", value: "in scratch", connection: "scratch" }, {});
    await resolver({ "$cache-set": "k", value: "in app" }, {});

    assert.equal(await resolver({ "$cache-get": "k", connection: "scratch" }, {}), "in scratch");
    assert.equal(await resolver({ "$cache-get": "k", connection: "app" }, {}), "in app");
    assert.equal(await resolver({ "$cache-has": "k", connection: "scratch" }, {}), true);
    assert.equal(await resolver({ "$cache-delete": "k", connection: "scratch" }, {}), true);
    assert.equal(await resolver({ "$cache-get": "k" }, {}), "in app");
  } finally {
    resolver.destroy();
  }
});

test("a cache name that was never connected is an error", async () => {
  const { resolver } = resolverWithCache();
  try {
    await assert.rejects(
      async () => resolver({ "$cache-get": "k", connection: "nowhere" }, {}),
      /Cache "nowhere" is not connected/,
    );
  } finally {
    resolver.destroy();
  }
});

test("closing one cache leaves the others, and the default falls back to memory", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cache-connect": "memory", connection: "app" }, {});
    await resolver({ "$cache-connect": "memory", connection: "scratch" }, {});
    await resolver({ "$cache-set": "k", value: "kept", connection: "scratch" }, {});
    await resolver({ "$cache-set": "k", value: "gone" }, {});

    await resolver({ $cache: "close", connection: "app" }, {});
    assert.equal(await resolver({ "$cache-get": "k", connection: "scratch" }, {}), "kept");
    await assert.rejects(async () => resolver({ "$cache-get": "k", connection: "app" }, {}), /not connected/);
    assert.equal(await resolver({ "$cache-get": "k" }, {}), undefined);
  } finally {
    resolver.destroy();
  }
});

test("reconnecting a name replaces its cache", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cache-connect": "memory", connection: "app" }, {});
    await resolver({ "$cache-set": "k", value: "old" }, {});
    await resolver({ "$cache-connect": "memory", connection: "app" }, {});
    assert.equal(await resolver({ "$cache-get": "k", connection: "app" }, {}), undefined);
  } finally {
    resolver.destroy();
  }
});

test("a session kept in a named cache stays there for the rest of the request", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cache-connect": "memory" }, {});
    await resolver({ "$cache-connect": "memory", connection: "sessions" }, {});
    const request: Record<string, unknown> = { request: { method: "GET", cookies: {} }, _cookies: [] };
    await resolver([{ $session: "load", cache: "sessions" }, { $session: { user: "ada" } }], request);
    const sid = (request._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1];

    const stored = await resolver({ "$cache-get": `session:${sid}`, connection: "sessions" }, {});
    assert.equal((stored as { data: Record<string, unknown> }).data.user, "ada");
    assert.equal(await resolver({ "$cache-has": `session:${sid}` }, {}), false);
  } finally {
    resolver.destroy();
  }
});

test("translations are looked up in the named cache", async () => {
  const context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new TranslationNode()], { context });
  try {
    await resolver({ "$cache-connect": "memory" }, {});
    await resolver({ "$cache-connect": "memory", connection: "words" }, {});
    await resolver({ "$cache-set": `t:es:${sha256("Hello")}`, value: "Hola", connection: "words" }, {});
    await resolver({ "$cache-set": `t:es:${sha256("Hello")}`, value: "not from words" }, {});

    const request: Record<string, unknown> = {};
    await resolver({ $translate: "es", cache: "words" }, request);
    assert.equal(await TranslationNode.translateText("Hello", request), "Hola");
  } finally {
    resolver.destroy();
  }
});
