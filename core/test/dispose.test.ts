import { test } from "node:test";
import assert from "node:assert/strict";
import { Node, createResolver, coreNodes } from "../src/index.js";
import type { JexsNodeSchema } from "../src/index.js";

class DisposableNode extends Node {
  static schema: JexsNodeSchema = { disposable: { output: "null" } };
  disposed = 0;
  disposable() { return null; }
  dispose() { this.disposed++; }
}

test("a node is disposed when its resolver is destroyed", () => {
  const node = new DisposableNode();
  const resolver = createResolver([node]);
  assert.equal(node.disposed, 0);

  resolver.destroy();
  assert.equal(node.disposed, 1);
  assert.equal(resolver.destroyed, true);
});

// Resolvers coexist: building one used to tear the previous one down, which made
// two live resolvers in a realm impossible. Nothing but `destroy()` disposes now.
test("creating a resolver leaves an existing one running", () => {
  const node = new DisposableNode();
  const first = createResolver([node]);

  createResolver(coreNodes());

  assert.equal(node.disposed, 0, "an unrelated resolver must not dispose this node");
  assert.equal(first.destroyed, false);
  assert.equal(first({ disposable: true }, {}), null, "and it still dispatches");
});

test("a node claiming many keys is disposed once, not per key", () => {
  class MultiKey extends Node {
    static schema: JexsNodeSchema = { alpha: {}, beta: {}, gamma: {} };
    disposed = 0;
    alpha() { return null; }
    beta() { return null; }
    gamma() { return null; }
    dispose() { this.disposed++; }
  }
  const node = new MultiKey();
  const resolver = createResolver([node]);
  resolver.destroy();
  assert.equal(node.disposed, 1);
});

// Each resolver tears down its own nodes and nobody else's, which is what lets a
// short-lived resolver be destroyed while a long-lived one keeps running.
test("destroying one resolver does not dispose another's nodes", () => {
  const a = new DisposableNode();
  const b = new DisposableNode();

  const first = createResolver([a]);
  const second = createResolver([b]);
  second.destroy();

  assert.equal(b.disposed, 1, "its own node is disposed");
  assert.equal(a.disposed, 0, "the other resolver's node is left alone");

  first.destroy();
  assert.equal(a.disposed, 1);
});

// A node whose keys were every one of them already claimed never enters the
// dispatch map, but it was still handed over and may own resources.
test("a node that lost first-wins on every key is still disposed", () => {
  const winner = new DisposableNode();
  const loser = new DisposableNode();
  const resolver = createResolver([winner, loser]);

  assert.equal(resolver.nodeFor("disposable"), winner, "first registration wins");
  resolver.destroy();
  assert.equal(loser.disposed, 1, "the shadowed node is disposed too");
});

test("a throwing dispose does not stop the rest of the teardown", () => {
  class Bad extends Node {
    static schema: JexsNodeSchema = { bad: {} };
    bad() { return null; }
    dispose() { throw new Error("boom"); }
  }
  const good = new DisposableNode();
  const resolver = createResolver([new Bad(), good]);
  resolver.destroy();
  assert.equal(good.disposed, 1);
});

test("nodes without dispose are skipped harmlessly", () => {
  const resolver = createResolver(coreNodes());
  assert.doesNotThrow(() => resolver.destroy());
});

test("destroy is idempotent, so a node is never disposed twice", () => {
  const node = new DisposableNode();
  const resolver = createResolver([node]);

  resolver.destroy();
  resolver.destroy();

  assert.equal(node.disposed, 1);
  assert.equal(resolver.destroyed, true);
});
