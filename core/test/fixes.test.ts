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

test("an interval run that fails goes through the step's $catch", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = {};
  resolver({
    $interval: "start", id: "fails", every: "10ms",
    do: [{ $error: 500, message: "boom" }],
    $catch: [{ $setVars: { caught: { $var: "error.message" } }, $bubble: true }],
  }, ctx);
  await tick(40);
  resolver({ $interval: "stop", id: "fails" }, ctx);
  resolver.destroy();
  assert.equal(ctx.caught, "boom");
});

test("an interval's steps read count and elapsed", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = {};
  resolver({
    $interval: "start", id: "counts", every: "10ms",
    do: { $setVars: { seen: { $var: "count" }, elapsed: { $var: "elapsed" } }, $bubble: true },
  }, ctx);
  await tick(45);
  resolver({ $interval: "stop", id: "counts" }, ctx);
  resolver.destroy();
  assert.ok(Number(ctx.seen) >= 2, `seen ${ctx.seen}`);
  assert.equal(typeof ctx.elapsed, "number");
});

test("each interval run has a scope of its own, with its timings in milliseconds", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = { kept: 0 };
  const before = Date.now();
  resolver({
    $interval: "start", id: "scoped", every: "10ms",
    do: [
      { $setVars: { local: { $add: [{ $var: "local" }, 1] } } },
      {
        $setVars: {
          kept: { $add: [{ $var: "kept" }, 1] },
          last: { dt: { $var: "dt" }, elapsed: { $var: "elapsed" }, lastRun: { $var: "lastRun" } },
        },
        $bubble: true,
      },
    ],
  }, ctx);
  await tick(45);
  resolver({ $interval: "stop", id: "scoped" }, ctx);
  resolver.destroy();
  assert.equal(ctx.dt, undefined, "the caller's context gets none of a run's timings");
  assert.equal(ctx.local, undefined, "a write without $bubble stays in its run");
  assert.ok(Number(ctx.kept) >= 2, `a bubbled write reaches the caller: ${String(ctx.kept)}`);
  const last = ctx.last as { dt: number; elapsed: number; lastRun: number };
  assert.ok(last.dt >= 5 && last.dt < 1000, `dt is in ms: ${last.dt}`);
  assert.ok(last.elapsed >= last.dt, `elapsed is in ms: ${last.elapsed}`);
  assert.ok(last.lastRun >= before && last.lastRun <= Date.now(), "lastRun is a Unix ms timestamp");
});

test("every interval op needs an id, and a start needs exactly one of every and rate", () => {
  const resolver = createResolver(coreNodes());
  try {
    assert.throws(() => resolver({ $interval: "start", every: "1s", do: [] }, {}), /interval needs an `id`/);
    assert.throws(() => resolver({ $interval: "stop" }, {}), /interval needs an `id`/);
    assert.throws(() => resolver({ $interval: "start", id: "x", do: [] }, {}), /interval needs `every` or `rate`/);
    assert.throws(() => resolver({ $interval: "start", id: "x", every: "1s", rate: 60, do: [] }, {}), /not both/);
    assert.throws(() => resolver({ $interval: "start", id: "x", rate: 0, do: [] }, {}), /positive number of milliseconds/);
  } finally {
    resolver.destroy();
  }
});

test("a run waits for the last one's steps unless detach is set", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = { started: 0 };
  // Each run takes ~100ms against a 10ms period, so in 250ms waiting runs start
  // about 3 times; detached ones start every period (timer granularity aside).
  const slowRun = [{ $setVars: { started: { $add: [{ $var: "started" }, 1] } }, $bubble: true }, { $sleep: 100 }];
  resolver({ $interval: "start", id: "waits", rate: 10, do: slowRun }, ctx);
  await tick(250);
  resolver({ $interval: "stop", id: "waits" }, ctx);
  const waited = ctx.started as number;
  ctx.started = 0;
  resolver({ $interval: "start", id: "overlaps", rate: 10, detach: true, do: slowRun }, ctx);
  await tick(250);
  resolver({ $interval: "stop", id: "overlaps" }, ctx);
  resolver.destroy();
  assert.ok(waited >= 1 && waited <= 3, `waiting runs started ${waited} times`);
  assert.ok((ctx.started as number) >= 2 * waited + 2, `detached runs started ${String(ctx.started)} times, waiting ${waited}`);
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

test("an interval whose period resolves to nothing has none, so it does not start", () => {
  const resolver = createResolver(coreNodes());
  assert.throws(() => resolver({ $interval: "start", id: "t", rate: { $var: "missing" }, do: [{ $var: "x" }] }, {}), /interval needs `every` or `rate`/);
  resolver.destroy();
});

test("$setVars' data flag may be an expression", () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = { asData: true };
  resolver({ $setVars: { kept: { $concat: ["a", "b"] } }, data: { $var: "asData" } }, ctx);
  assert.deepEqual(ctx.kept, { $concat: ["a", "b"] });
});
