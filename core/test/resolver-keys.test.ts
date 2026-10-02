import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Node, ProxyNode, createResolver, coreNodes, stepFields,
} from "../src/index.js";
import type { Context, JexsNodeSchema, NodeValue } from "../src/index.js";

class LateNode extends Node {
  static schema: JexsNodeSchema = { lateop: { output: "string" } };
  lateop() { return "late"; }
}

test("keys is a live view, not a snapshot taken at createResolver", () => {
  const resolver = createResolver(coreNodes());
  assert.equal(resolver.keys.has("var"), true);
  assert.equal(resolver.keys.has("lateop"), false);

  // registerNode is a runtime API, not a boot-time one.
  resolver.registerNode(new LateNode());
  assert.equal(resolver.keys.has("lateop"), true);
  assert.ok(resolver.keys.toArray().includes("lateop"));
});

// The set is the UNION of _keyMap and _lazyMap, and the lazy path migrates
// entries between them as modules load. Reading either alone gives a wrong answer.
test("keys includes lazy keys that have no handler yet", () => {
  const resolver = createResolver(coreNodes());
  assert.equal(resolver.keys.has("lazyop"), false);

  resolver.registerLazy(["lazyop"], async () => {});
  assert.equal(resolver.keys.has("lazyop"), true);
  assert.ok(resolver.keys.size > 0);
});

test("onKeysChange fires with exactly what was added", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  resolver.onKeysChange((added) => seen.push([...added]));

  resolver.registerNode(new LateNode());
  assert.deepEqual(seen, [["lateop"]]);

  // Re-registering the same node adds nothing, so it must not announce.
  resolver.registerNode(new LateNode());
  assert.deepEqual(seen, [["lateop"]]);

  resolver.registerLazy(["lazyA", "lazyB"], async () => {});
  assert.deepEqual(seen[1], ["lazyA", "lazyB"]);
});

test("onKeysChange does not announce a lazy key the resolver already handles", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  resolver.onKeysChange((added) => seen.push([...added]));

  resolver.registerLazy(["var"], async () => {});
  assert.deepEqual(seen, []);
});

test("onKeysChange returns an unsubscribe", () => {
  const resolver = createResolver(coreNodes());
  const seen: string[][] = [];
  const off = resolver.onKeysChange((added) => seen.push([...added]));

  off();
  resolver.registerNode(new LateNode());
  assert.deepEqual(seen, []);
});

// A listener belongs to the resolver it was registered on, so work in a second
// resolver must never reach it.
test("subscribers do not leak between resolvers", () => {
  const first = createResolver(coreNodes());
  const seen: string[][] = [];
  first.onKeysChange((added) => seen.push([...added]));

  const second = createResolver(coreNodes());
  second.registerNode(new LateNode());
  assert.deepEqual(seen, []);
});

// Resolvers coexist, so each key view answers for its own dispatch map only.
test("one resolver's key view does not report another's keys", () => {
  const first = createResolver(coreNodes());
  assert.equal(first.keys.has("var"), true);
  assert.equal(first.keys.has("lateop"), false);

  const second = createResolver(coreNodes());
  second.registerNode(new LateNode());

  assert.equal(first.keys.has("lateop"), false, "must not see the other resolver");
  assert.equal(first.keys.has("var"), true, "keeps its own keys");
  assert.equal(second.keys.has("lateop"), true);
});

test("lazy keys belong to the resolver they were registered on", () => {
  const first = createResolver(coreNodes());
  const second = createResolver(coreNodes());
  second.registerLazy(["lazyonly"], async () => {});

  assert.equal(first.keys.has("lazyonly"), false);
  assert.equal(second.keys.has("lazyonly"), true);
});

test("a listener that throws does not break registration", () => {
  const resolver = createResolver(coreNodes());
  resolver.onKeysChange(() => { throw new Error("boom"); });

  resolver.registerNode(new LateNode());
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
  resolver.registerNode(proxy);

  assert.equal(resolver.keys.has("remoteop"), true);

  // `var` is a core key, so claiming it must NOT steal dispatch from core.
  proxy.addKeys(["remoteop2", "var"]);
  resolver.registerNode(proxy);
  assert.equal(resolver.keys.has("remoteop2"), true);
  assert.equal(resolver({ $var: "nothing" }, {}), undefined);
  assert.equal(calls.length, 0);
});

// A proxied call must behave exactly like a local one, or the bridge is not
// transparent: the step sequence has to WAIT for the remote value, and `as` has
// to bind it. `resolve` chains its continuation with `r.then(cont)` when a
// handler returns a Promise, and `runSteps` threads each step through that
// continuation -- so this holds for any remote, in either direction.
test("a proxied step blocks the next one and binds its value via as", async () => {
  const order: string[] = [];
  const resolver = createResolver(coreNodes());
  resolver.registerNode(new ProxyNode(["remoteslow"], async () => {
    order.push("remote-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("remote-end");
    return "VALUE";
  }));

  const out = await resolver([
    { $remoteslow: "x", $as: "got" },
    { $concat: ["got=", { $var: "got" }] },
  ], {});

  order.push("done");
  assert.equal(out, "got=VALUE");
  assert.deepEqual(order, ["remote-start", "remote-end", "done"]);
});

// The one case that IS fire-and-forget is the global `then` sibling, and it is
// the resolver -- not the proxy -- that intercepts it. So it behaves the same
// whether the op is local or remote.
test("a `then` sibling makes a proxied step fire-and-forget, as it would locally", async () => {
  const resolver = createResolver(coreNodes());
  let settled = false;
  resolver.registerNode(new ProxyNode(["remotebg"], async () => {
    await new Promise((r) => setTimeout(r, 20));
    settled = true;
    return "V";
  }));

  const out = await resolver([
    { $remotebg: "x", $then: [{ $concat: ["ignored"] }] },
    { $concat: ["next"] },
  ], {});

  assert.equal(out, "next");
  assert.equal(settled, false, "the sequence must not have waited for the remote");
});

test("ProxyNode forwards resolved siblings and receives the context", () => {
  const resolver = createResolver(coreNodes());
  const seen: { call: Record<string, unknown>; context: Context }[] = [];
  resolver.registerNode(new ProxyNode(["remotecall"], (call, context) => {
    seen.push({ call, context });
    return "ok";
  }));

  const ctx: Context = { who: "main", windowName: "editor" };
  const out = resolver({ $remotecall: "x", arg: { $var: "who" } }, ctx);
  return Promise.resolve(out).then((value) => {
    assert.equal(value, "ok");
    assert.equal(seen.length, 1);
    // Siblings arrive resolved, and `as`/`$catch` are stripped by the proxy.
    assert.deepEqual(seen[0].call, { $remotecall: "x", arg: "main" });
    assert.equal(seen[0].context.windowName, "editor");
  });
});

// Fields holding steps the remote op runs go over unresolved, so the steps run
// on the side that owns the op, when it runs them, not in the caller at call time.
test("a proxied op's steps field is forwarded unresolved, a single step included", async () => {
  const resolver = createResolver(coreNodes());
  const sent: Record<string, unknown>[] = [];
  resolver.registerNode(new ProxyNode(["shortcut"], call => { sent.push(call); return true; }, { shortcut: { do: "steps" } }));
  const ctx: Context = { key: "Ctrl+S" };

  await resolver({ $shortcut: { $var: "key" }, do: [{ $setVars: { ran: true } }] }, ctx);
  await resolver({ $shortcut: "Ctrl+O", do: { $setVars: { ran: true } } }, ctx);

  assert.equal(ctx.ran, undefined, "the steps did not run in the caller");
  assert.deepEqual(sent[0], { $shortcut: "Ctrl+S", do: [{ $setVars: { ran: true } }] });
  assert.deepEqual(sent[1], { $shortcut: "Ctrl+O", do: { $setVars: { ran: true } } });
});

test("a field with nested steps is forwarded as written, unless a step produces it", async () => {
  const resolver = createResolver(coreNodes());
  const sent: Record<string, unknown>[] = [];
  resolver.registerNode(new ProxyNode(["menu"], call => { sent.push(call); return true; }, { menu: { $menu: "nested" } }));
  const items = [{ label: "Open", do: [{ $setVars: { opened: true } }] }];
  const ctx: Context = { items };

  await resolver({ $menu: [{ label: "Open", do: [{ $setVars: { opened: true } }] }] }, ctx);
  await resolver({ $menu: { $var: "items" } }, ctx);

  assert.equal(ctx.opened, undefined);
  assert.deepEqual(sent[0], { $menu: items });
  assert.deepEqual(sent[1], { $menu: items }, "a step producing the items resolves here, to the items as data");
});

test("addKeys adopts a key's step fields with it", async () => {
  const resolver = createResolver(coreNodes());
  const sent: Record<string, unknown>[] = [];
  const proxy = new ProxyNode([], call => { sent.push(call); return true; });
  proxy.addKeys(["notify"], { notify: { do: "steps" } });
  resolver.registerNode(proxy);
  const ctx: Context = {};
  await resolver({ $notify: "Hi", do: [{ $setVars: { clicked: true } }] }, ctx);
  assert.equal(ctx.clicked, undefined);
  assert.deepEqual(sent[0], { $notify: "Hi", do: [{ $setVars: { clicked: true } }] });
});

// A page announces an op it loads lazily before the module is in, so the op's
// step fields reach the host only when loading it reports the key as added.
test("loading a lazy module reports its keys, whose step fields are then readable", async () => {
  class Lazy extends Node {
    static schema: JexsNodeSchema = { later: { siblings: { do: { steps: true } } } };
    later(): NodeValue { return "loaded"; }
  }
  const resolver = createResolver(coreNodes());
  resolver.registerLazy(["later"], r => r.registerNode(new Lazy()));
  assert.deepEqual(stepFields([resolver.nodeFor("later")].filter((n): n is Node => n !== undefined)), {});

  const added: string[][] = [];
  resolver.onKeysChange(keys => added.push([...keys]));
  assert.equal(await resolver({ $later: true }, {}), "loaded");

  assert.deepEqual(added, [["later"]]);
  assert.deepEqual(stepFields([resolver.nodeFor("later")!]), { later: { do: "steps" } });
});
