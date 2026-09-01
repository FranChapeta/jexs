import { test } from "node:test";
import assert from "node:assert/strict";
import { Node, createResolver, coreNodes, resolve, runSteps } from "../src/index.js";
import type { Context, JexsNodeSchema } from "../src/index.js";

/**
 * Two resolvers, live at the same time, in one realm.
 *
 * The resolver used to be a module-scope singleton that `createResolver` replaced,
 * so these were all impossible. It is now found on the CONTEXT — stamped at a
 * resolver.s entry points (or given at construction), and inherited by every
 * derived scope through the spread —
 * which is what lets these coexist.
 */

/** A node whose op returns a fixed marker, so we can tell resolvers apart. */
function markerNode(mark: string) {
  return new (class extends Node {
    static schema: JexsNodeSchema = { op: { output: "string" } };
    op() { return mark; }
  })();
}

const tick = () => new Promise(r => setTimeout(r, 30));

test("each resolver dispatches only its own keys", () => {
  const a = createResolver([...coreNodes(), markerNode("A")]);
  const b = createResolver(coreNodes());

  assert.equal(a({ op: 1 }, {}), "A");
  // b has no `op` handler, so the object is walked as plain data, not dispatched.
  assert.deepEqual(b({ op: 1 }, {}), { op: 1 });
  assert.equal(a.keys.has("op"), true);
  assert.equal(b.keys.has("op"), false);
});

// The inner `{op:1}` is resolved by the nested machinery, not by the entry call,
// so this is what proves dispatch follows the context rather than a global.
test("nested dispatch stays with the resolver the flow started in", async () => {
  const a = createResolver([...coreNodes(), markerNode("A")]);
  const b = createResolver([...coreNodes(), markerNode("B")]);

  assert.equal(await a({ concat: ["x:", { op: 1 }] }, {}), "x:A");
  assert.equal(await b({ concat: ["x:", { op: 1 }] }, {}), "x:B");
});

test("a child scope inherits its resolver, and a worker-style clone does not", () => {
  const ctx: Context = { n: 1 };
  const a = createResolver([...coreNodes(), markerNode("A")], { context: ctx });

  // Spread and childContext both carry the resolver: the key is an enumerable symbol.
  assert.equal(resolve({ op: 1 }, { ...ctx }), "A");
  // structuredClone drops symbols, which is what keeps a context crossing to a
  // worker from dragging a main-thread resolver with it.
  assert.throws(() => resolve({ op: 1 }, structuredClone(ctx) as Context), /No resolver/);
});

test("a context that never crossed a resolver is a named error, not a silent no-op", () => {
  createResolver(coreNodes());
  assert.throws(() => resolve({ concat: ["a"] }, {}), /No resolver for this context/);
  assert.throws(() => runSteps([{ concat: ["a"] }], {}), /No resolver for this context/);
});

test("handing one live context to a second resolver is refused", () => {
  const ctx: Context = {};
  const a = createResolver(coreNodes(), { context: ctx });
  const b = createResolver(coreNodes());

  assert.throws(() => b.resolve({ concat: ["x"] }, ctx), /already running in another resolver/);
  // Re-entering the SAME resolver is fine, so repeated entry calls work.
  assert.doesNotThrow(() => a.resolve({ concat: ["x"] }, ctx));
});

// `then` defers the work to a microtask and runs its continuation later. The old
// singleton was re-read at settle time, so a resolver created in between would
// capture the continuation; pinning it at call time is what fixes that.
test("a fire-and-forget continuation stays with its own resolver", async () => {
  const ctx: Context = {};
  const a = createResolver([...coreNodes(), markerNode("A")], { context: ctx });

  const out = await a.runSteps([
    { sleep: 10, then: [{ setVars: { landed: { op: 1 } }, bubble: true }] },
    { concat: ["next"] },
  ], ctx);
  assert.equal(out, "next");

  // A second resolver appears while the deferred work is still pending.
  createResolver(coreNodes());

  await tick();
  assert.equal(ctx.landed, "A", "the continuation resolved `op` in the resolver it started in");
});

test("destroying one resolver leaves the other dispatching", () => {
  const a = createResolver([...coreNodes(), markerNode("A")]);
  const b = createResolver([...coreNodes(), markerNode("B")]);

  a.destroy();

  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, false);
  assert.equal(b({ op: 1 }, {}), "B");
  assert.equal(b.keys.has("op"), true);
});

test("lazy keys and their loaders are per resolver", async () => {
  const loaded: string[] = [];
  const make = (mark: string) => (r: import("../src/index.js").Resolver) => {
    loaded.push(mark);
    r.registerNode(markerNode(mark));
  };

  const a = createResolver(coreNodes());
  const b = createResolver(coreNodes());
  a.registerLazy(["op"], make("A"));
  b.registerLazy(["op"], make("B"));

  assert.equal(await a({ op: 1 }, {}), "A");
  assert.deepEqual(loaded, ["A"], "only the resolver that was used loaded its module");
  assert.equal(a.nodeFor("op") !== undefined, true);
  assert.equal(b.nodeFor("op"), undefined, "the other resolver still has it only as lazy");

  assert.equal(await b({ op: 1 }, {}), "B");
});

// TimerNode keys its registries by a template-supplied id, so two resolvers
// running the same app would otherwise collide, and either teardown would stop
// both. The registries are instance fields, and instances are per resolver.
test("timers belong to their own resolver and survive another's teardown", async () => {
  const ctxA: Context = { hits: 0 };
  const ctxB: Context = { hits: 0 };
  const a = createResolver(coreNodes(), { context: ctxA });
  const b = createResolver(coreNodes(), { context: ctxB });

  const start = { tick: "start", id: "shared", rate: 60, do: [{ setVars: { hits: { add: [{ var: "$hits" }, 1] } }, bubble: true }] };
  a.resolve(start, ctxA);
  b.resolve(start, ctxB);

  await tick();
  assert.ok((ctxA.hits as number) > 0, "A's timer ran");
  assert.ok((ctxB.hits as number) > 0, "B's timer ran under the same id");

  a.destroy();
  const afterA = ctxA.hits as number;
  const atDestroy = ctxB.hits as number;
  await tick();

  assert.equal(ctxA.hits, afterA, "A's timer stopped with A");
  assert.ok((ctxB.hits as number) > atDestroy, "B's timer is untouched by A's teardown");
  b.destroy();
});

// `randomSeed` exists to make a run reproducible, which a stream shared with
// another resolver defeats.
test("a random seed set in one resolver does not reach the other", () => {
  const a = createResolver(coreNodes());
  const b = createResolver(coreNodes());

  a({ randomSeed: 42 }, {});
  const first = a({ random: 1000000 }, {});

  // Re-seed A, then draw from B before drawing from A again. B's draw is the
  // discriminator: on a shared stream it advances the seed and A's next value
  // moves. Asserting only that A alone is reproducible would pass either way.
  a({ randomSeed: 42 }, {});
  b({ random: 1000000 }, {});
  const again = a({ random: 1000000 }, {});

  assert.equal(again, first, "B's draw must not advance A's seeded stream");
});
