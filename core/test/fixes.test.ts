import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, WorkerNode } from "../src/index.js";
import type { Context } from "../src/index.js";

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The handlers an element hands the browser, from its `data-jexs-events` attribute. */
function eventsOf(html: string): Array<Record<string, unknown>> {
  const m = /data-jexs-events="([^"]*)"/.exec(html);
  assert.ok(m, "no data-jexs-events attribute");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

test("a cron run that fails goes through the step's $catch", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = {};
  resolver({
    $cron: "start", id: "fails", every: "10ms",
    do: [{ $error: 500, message: "boom" }],
    $catch: [{ $setVars: { caught: { $var: "error.message" } }, $bubble: true }],
  }, ctx);
  await tick(40);
  resolver({ $cron: "stop", id: "fails" }, ctx);
  resolver.destroy();
  assert.equal(ctx.caught, "boom");
});

test("a thread without a worker runs inline, with params as its whole context", async () => {
  const resolver = createResolver([...coreNodes(), new WorkerNode(null)]);
  const params = { who: "inline" };
  const out = await resolver({
    $thread: "t",
    params: { $var: "p" },
    do: [{ $concat: ["hi ", { $var: "who" }, { $var: "outside" }] }],
  }, { p: params, outside: "!" });
  assert.equal(out, "hi inline");
  assert.equal(Object.getOwnPropertySymbols(params).length, 0, "the caller's params object is left untouched");
});

test("rendering an element with events leaves its def unchanged and adds no id", () => {
  const resolver = createResolver(coreNodes());
  const def = { $tag: "button", events: { click: { do: [] } } };
  const first = String(resolver(def, {}));
  const second = String(resolver(def, {}));
  assert.equal("id" in def, false);
  assert.equal(first, second);
  assert.doesNotMatch(first, /\bid="/);
});

test("events given a step resolve to the map, whose handlers stay steps", () => {
  const resolver = createResolver(coreNodes());
  const handlers = { click: { do: [{ $setVars: { clicked: true } }] }, focus: { $setVars: { focused: true } } };
  const ctx: Context = { handlers };
  const html = String(resolver({ $tag: "button", events: { $var: "handlers" } }, ctx));
  const events = eventsOf(html);
  assert.deepEqual(events.map(e => e.type), ["click", "focus"]);
  assert.deepEqual(events[0].do, [{ $setVars: { clicked: true } }]);
  assert.deepEqual(events[1].do, { $setVars: { focused: true } });
  assert.equal(ctx.clicked, undefined);
});

test("a handler's single do step is sent as one step, not wrapped", () => {
  const resolver = createResolver(coreNodes());
  const [click] = eventsOf(String(resolver({ $tag: "button", events: { click: { do: { $setVars: { a: 1 } } } } }, {})));
  assert.deepEqual(click.do, { $setVars: { a: 1 } });
});

// A `$var` that resolves to nothing must still get the option's default: the
// default belongs to the resolved value, not only to an absent key.
test("$fetch throws on a non-2xx when `throw` resolves to nothing", async () => {
  const resolver = createResolver(coreNodes());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(Promise.resolve(resolver({ $fetch: "/x", throw: { $var: "missing" } }, {})), /500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("$join's separator and $error's status and message fall back when they resolve to nothing", async () => {
  const resolver = createResolver(coreNodes());
  assert.equal(resolver({ $join: ["a", "b"], separator: { $var: "missing" } }, {}), "a,b");
  const out = resolver({
    $error: { $var: "missing" }, message: { $var: "missing" },
    $catch: [{ $concat: [{ $var: "error.status" }, "|", { $var: "error.message" }] }],
  }, {});
  assert.equal(out, "500|");
});

test("a tick whose rate resolves to nothing runs at the default 60 per second", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = { n: 0 };
  resolver({ $tick: "start", id: "t", rate: { $var: "missing" }, do: [{ $setVars: { n: { $add: [{ $var: "n" }, 1] } }, $bubble: true }] }, ctx);
  await tick(100);
  resolver({ $tick: "stop", id: "t" }, ctx);
  resolver.destroy();
  assert.ok((ctx.n as number) > 0 && (ctx.n as number) < 20, `ran ${String(ctx.n)} times in 100ms`);
});

test("$setVars' data flag may be an expression", () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = { asData: true };
  resolver({ $setVars: { kept: { $concat: ["a", "b"] } }, data: { $var: "asData" } }, ctx);
  assert.deepEqual(ctx.kept, { $concat: ["a", "b"] });
});
