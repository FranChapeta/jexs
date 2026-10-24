import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { COOKIES } from "../src/context.js";
import { CacheNode } from "../src/nodes/Cache.js";
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
    await a.resolver({ "$cacheSet": "greeting", value: "hi" }, {});
    assert.equal(await a.resolver({ "$cacheGet": "greeting" }, {}), "hi");
    assert.equal(await b.resolver({ "$cacheGet": "greeting" }, {}), undefined);

    await b.resolver({ $cache: "clear" }, {});
    assert.equal(await a.resolver({ "$cacheGet": "greeting" }, {}), "hi");
    assert.notEqual(CacheNode.cacheFor(a.context), CacheNode.cacheFor(b.context));
  } finally {
    a.resolver.destroy();
    b.resolver.destroy();
  }
});

test("a session started in one resolver is not loaded by another", async () => {
  const a = resolverWithCache();
  const b = resolverWithCache();
  try {
    const setCookies: string[] = [];
    await a.resolver({ $session: { user: "ada" } }, { request: { cookies: {} }, [COOKIES]: setCookies });
    const sid = setCookies.join(";").match(/sid=([^;]+)/)?.[1];
    assert.ok(sid, "a session cookie was set");

    const inA: Record<string, unknown> = { request: { cookies: { sid } } };
    await a.resolver({ $session: "load" }, inA);
    assert.equal((inA.session as Record<string, unknown>).user, "ada");

    const inB: Record<string, unknown> = { request: { cookies: { sid } } };
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
    await resolver({ "$cacheConnect": "memory", connection: "app" }, {});
    await resolver({ "$cacheConnect": "memory", connection: "scratch" }, {});
    await resolver({ "$cacheSet": "k", value: "in scratch", connection: "scratch" }, {});
    await resolver({ "$cacheSet": "k", value: "in app" }, {});

    assert.equal(await resolver({ "$cacheGet": "k", connection: "scratch" }, {}), "in scratch");
    assert.equal(await resolver({ "$cacheGet": "k", connection: "app" }, {}), "in app");
    assert.equal(await resolver({ "$cacheHas": "k", connection: "scratch" }, {}), true);
    assert.equal(await resolver({ "$cacheDelete": "k", connection: "scratch" }, {}), true);
    assert.equal(await resolver({ "$cacheGet": "k" }, {}), "in app");
  } finally {
    resolver.destroy();
  }
});

test("connecting a cache says so through the resolver's logger", async () => {
  const lines: string[] = [];
  const log = (message: string) => { lines.push(message); };
  const resolver = createResolver([...coreNodes(), new CacheNode()], { logger: { info: log, warn: log, error: log } });
  try {
    await resolver({ "$cacheConnect": "memory", connection: "app" }, {});
    assert.deepEqual(lines, ['[CacheNode] Connected to cache "app" (memory)']);
  } finally {
    resolver.destroy();
  }
});

test("a cache name that was never connected is an error", async () => {
  const { resolver } = resolverWithCache();
  try {
    await assert.rejects(
      async () => resolver({ "$cacheGet": "k", connection: "nowhere" }, {}),
      /Cache "nowhere" is not connected/,
    );
  } finally {
    resolver.destroy();
  }
});

test("closing one cache leaves the others, and the default falls back to memory", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cacheConnect": "memory", connection: "app" }, {});
    await resolver({ "$cacheConnect": "memory", connection: "scratch" }, {});
    await resolver({ "$cacheSet": "k", value: "kept", connection: "scratch" }, {});
    await resolver({ "$cacheSet": "k", value: "gone" }, {});

    await resolver({ $cache: "close", connection: "app" }, {});
    assert.equal(await resolver({ "$cacheGet": "k", connection: "scratch" }, {}), "kept");
    await assert.rejects(async () => resolver({ "$cacheGet": "k", connection: "app" }, {}), /not connected/);
    assert.equal(await resolver({ "$cacheGet": "k" }, {}), undefined);
  } finally {
    resolver.destroy();
  }
});

test("reconnecting a name replaces its cache", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cacheConnect": "memory", connection: "app" }, {});
    await resolver({ "$cacheSet": "k", value: "old" }, {});
    await resolver({ "$cacheConnect": "memory", connection: "app" }, {});
    assert.equal(await resolver({ "$cacheGet": "k", connection: "app" }, {}), undefined);
  } finally {
    resolver.destroy();
  }
});

test("a session kept in a named cache stays there for the rest of the request", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cacheConnect": "memory" }, {});
    await resolver({ "$cacheConnect": "memory", connection: "sessions" }, {});
    const setCookies: string[] = [];
    const request = { request: { method: "GET", cookies: {} }, [COOKIES]: setCookies };
    await resolver([{ $session: "load", cache: "sessions" }, { $session: { user: "ada" } }], request);
    const sid = setCookies.join(";").match(/sid=([^;]+)/)?.[1];

    const stored = await resolver({ "$cacheGet": `session:${sid}`, connection: "sessions" }, {});
    assert.equal((stored as { data: Record<string, unknown> }).data.user, "ada");
    assert.equal(await resolver({ "$cacheHas": `session:${sid}` }, {}), false);
  } finally {
    resolver.destroy();
  }
});

test("cacheSet needs a value and returns it, and a mistake in a step is no HTTP error", async () => {
  const { resolver } = resolverWithCache();
  try {
    await resolver({ "$cacheConnect": "memory" }, {});
    assert.deepEqual(await resolver({ "$cacheSet": "user", value: { id: 1 } }, {}), { id: 1 });
    assert.deepEqual(await resolver({ "$cacheGet": "user" }, {}), { id: 1 });
    await assert.rejects(async () => resolver({ "$cacheSet": "user" }, {}), /\$cacheSet needs a `value` to store/);

    const plain = (message: RegExp) => (e: Error & { status?: number }) => e.status === undefined && message.test(e.message);
    await assert.rejects(async () => resolver({ $cache: "dump" }, {}), plain(/unknown operation "dump"/));
    await assert.rejects(async () => resolver({ "$cacheConnect": "mongo" }, {}), plain(/Unknown cache driver "mongo"/));
  } finally {
    resolver.destroy();
  }
});

test("translations are looked up in the named cache", async () => {
  const context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new TranslationNode()], { context });
  try {
    await resolver({ "$cacheConnect": "memory" }, {});
    await resolver({ "$cacheConnect": "memory", connection: "words" }, {});
    await resolver({ "$cacheSet": `t:es:${sha256("Hello")}`, value: "Hola", connection: "words" }, {});
    await resolver({ "$cacheSet": `t:es:${sha256("Hello")}`, value: "not from words" }, {});

    const html = await resolver([{ $translate: "es", cache: "words" }, { $tag: "p", content: "Hello" }], {});
    assert.equal(html, "<p>Hola</p>");
  } finally {
    resolver.destroy();
  }
});
