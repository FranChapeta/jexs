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
