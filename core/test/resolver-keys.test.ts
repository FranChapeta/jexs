import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Node, ProxyNode, createResolver, coreNodes, registerNode, registerLazy, runSteps,
} from "../src/index.js";
import type { Context, JexsNodeSchema } from "../src/index.js";

class LateNode extends Node {
  static schema: JexsNodeSchema = { lateop: { output: "string" } };
  lateop() { return "late"; }
}

test("keys is a live view, not a snapshot taken at createResolver", () => {
  const resolver = createResolver(coreNodes());
  assert.equal(resolver.keys.has("var"), true);
  assert.equal(resolver.keys.has("lateop"), false);

  // registerNode is a runtime API, not a boot-time one.
  registerNode(new LateNode());
  assert.equal(resolver.keys.has("lateop"), true);
  assert.ok(resolver.keys.toArray().includes("lateop"));
});

// The set is the UNION of _keyMap and _lazyMap, and the lazy path migrates
// entries between them as modules load. Reading either alone gives a wrong answer.
test("keys includes lazy keys that have no handler yet", () => {
  const resolver = createResolver(coreNodes());
  assert.equal(resolver.keys.has("lazyop"), false);

  registerLazy(["lazyop"], async () => {});
  assert.equal(resolver.keys.has("lazyop"), true);
  assert.ok(resolver.keys.size > 0);
});

test("onKeysChange fires with exactly what was added", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  resolver.onKeysChange((added) => seen.push([...added]));

  registerNode(new LateNode());
  assert.deepEqual(seen, [["lateop"]]);

  // Re-registering the same node adds nothing, so it must not announce.
  registerNode(new LateNode());
  assert.deepEqual(seen, [["lateop"]]);

  registerLazy(["lazyA", "lazyB"], async () => {});
  assert.deepEqual(seen[1], ["lazyA", "lazyB"]);
});

test("onKeysChange does not announce a lazy key the resolver already handles", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  resolver.onKeysChange((added) => seen.push([...added]));

  registerLazy(["var"], async () => {});
  assert.deepEqual(seen, []);
});

test("onKeysChange returns an unsubscribe", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  const off = resolver.onKeysChange((added) => seen.push([...added]));

  off();
  registerNode(new LateNode());
  assert.deepEqual(seen, []);
});

// createResolver tears down the previous resolver, and a listener surviving that
// would fire for a resolver its owner no longer holds.
test("subscribers do not leak across resolver rebuilds", () => {
  const first = createResolver(coreNodes());
  const seen: string[][] = [];
  first.onKeysChange((added) => seen.push([...added]));

  createResolver(coreNodes());
  registerNode(new LateNode());
  assert.deepEqual(seen, []);
});

// The resolver is a module-scope singleton by design -- handlers get only
// (def, context), so resolve() must be reachable without a handle. The key view
// is still bound to the map it was built for, so a superseded resolver reports
// its own keys rather than silently mirroring whoever is current.
test("a superseded resolver's key view does not report the live resolver's keys", () => {
  const first = createResolver(coreNodes());
  assert.equal(first.keys.has("var"), true);
  assert.equal(first.keys.has("lateop"), false);

  createResolver(coreNodes());
  registerNode(new LateNode());

  assert.equal(first.keys.has("lateop"), false, "stale view must not see the new resolver");
  assert.equal(first.keys.has("var"), true, "stale view keeps its own keys");
});

test("a superseded resolver stops counting lazy keys, which belong to the current one", () => {
  const first = createResolver(coreNodes());
  createResolver(coreNodes());
  registerLazy(["lazyonly"], async () => {});

  assert.equal(first.keys.has("lazyonly"), false);
});

test("a listener that throws does not break registration", () => {
  const resolver = createResolver(coreNodes());
  resolver.onKeysChange(() => { throw new Error("boom"); });

  registerNode(new LateNode());
  assert.equal(resolver.keys.has("lateop"), true);
});

// --- ProxyNode -------------------------------------------------------------

test("ProxyNode adopts keys at runtime and reports which were new", () => {
  const proxy = new ProxyNode(["alpha"], () => null);
  assert.deepEqual([...proxy.handlerKeys], ["alpha"]);

  assert.deepEqual(proxy.addKeys(["beta", "alpha", "gamma"]), ["beta", "gamma"]);
  assert.deepEqual([...proxy.handlerKeys].sort(), ["alpha", "beta", "gamma"]);
  assert.equal(proxy.claims("beta"), true);
  assert.equal(proxy.claims("delta"), false);
});

test("registering a grown proxy installs the new keys and keeps first-wins", () => {
  const resolver = createResolver(coreNodes());
  const calls: Record<string, unknown>[] = [];
  const proxy = new ProxyNode(["remoteop"], (call) => { calls.push(call); return "forwarded"; });
  registerNode(proxy);

  assert.equal(resolver.keys.has("remoteop"), true);

  // `var` is a core key, so claiming it must NOT steal dispatch from core.
  proxy.addKeys(["remoteop2", "var"]);
  registerNode(proxy);
  assert.equal(resolver.keys.has("remoteop2"), true);
  assert.equal(resolver({ var: "$nothing" }, {}), undefined);
  assert.equal(calls.length, 0);
});

// A proxied call must behave exactly like a local one, or the bridge is not
// transparent: the step sequence has to WAIT for the remote value, and `as` has
// to bind it. `resolve` chains its continuation with `r.then(cont)` when a
// handler returns a Promise, and `runSteps` threads each step through that
// continuation -- so this holds for any remote, in either direction.
test("a proxied step blocks the next one and binds its value via as", async () => {
  const order: string[] = [];
  createResolver(coreNodes());
  registerNode(new ProxyNode(["remoteslow"], async () => {
    order.push("remote-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("remote-end");
    return "VALUE";
  }));

  const out = await runSteps([
    { remoteslow: "x", as: "got" },
    { concat: ["got=", { var: "$got" }] },
  ], {});

  order.push("done");
  assert.equal(out, "got=VALUE");
  assert.deepEqual(order, ["remote-start", "remote-end", "done"]);
});

// The one case that IS fire-and-forget is the global `then` sibling, and it is
// the resolver -- not the proxy -- that intercepts it. So it behaves the same
// whether the op is local or remote.
test("a `then` sibling makes a proxied step fire-and-forget, as it would locally", async () => {
  createResolver(coreNodes());
  let settled = false;
  registerNode(new ProxyNode(["remotebg"], async () => {
    await new Promise((r) => setTimeout(r, 20));
    settled = true;
    return "V";
  }));

  const out = await runSteps([
    { remotebg: "x", then: [{ concat: ["ignored"] }] },
    { concat: ["next"] },
  ], {});

  assert.equal(out, "next");
  assert.equal(settled, false, "the sequence must not have waited for the remote");
});

test("ProxyNode forwards resolved siblings and receives the context", () => {
  const resolver = createResolver(coreNodes());
  const seen: { call: Record<string, unknown>; context: Context }[] = [];
  registerNode(new ProxyNode(["remotecall"], (call, context) => {
    seen.push({ call, context });
    return "ok";
  }));

  const ctx: Context = { who: "main", windowName: "editor" };
  const out = resolver({ remotecall: "x", arg: { var: "$who" } }, ctx);
  return Promise.resolve(out).then((value) => {
    assert.equal(value, "ok");
    assert.equal(seen.length, 1);
    // Siblings arrive resolved, and `as`/`catch` are stripped by the proxy.
    assert.deepEqual(seen[0].call, { remotecall: "x", arg: "main" });
    assert.equal(seen[0].context.windowName, "editor");
  });
});
