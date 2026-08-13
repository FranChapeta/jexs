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

test("a node is disposed when its resolver is replaced", () => {
  const node = new DisposableNode();
  createResolver([node]);
  assert.equal(node.disposed, 0);

  createResolver([...coreNodes]);
  assert.equal(node.disposed, 1);
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

// The previous mechanism cleared its hook list after the first teardown, so in a
// process that built several resolvers only the first ever cleaned up -- a second
// resolver's timers would then run forever.
test("disposal runs for every resolver, not just the first in the process", () => {
  const a = new DisposableNode();
  const b = new DisposableNode();

  createResolver([a]);
  const second = createResolver([b]);
  second.destroy();

  assert.equal(a.disposed, 1, "first resolver's node disposed on replace");
  assert.equal(b.disposed, 1, "second resolver's node disposed on destroy");
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
  const resolver = createResolver([...coreNodes]);
  assert.doesNotThrow(() => resolver.destroy());
});

test("destroy is inert once a resolver has been superseded", () => {
  const node = new DisposableNode();
  const first = createResolver([node]);
  createResolver([...coreNodes]);
  assert.equal(node.disposed, 1);

  // The replacement already tore it down; destroying the stale handle must not
  // reach into whoever is current now.
  first.destroy();
  assert.equal(node.disposed, 1);
  assert.equal(first.isCurrent, false);
});
