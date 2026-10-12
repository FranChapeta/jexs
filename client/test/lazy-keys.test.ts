import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, type Node } from "@jexs/core";
import { EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode, MeshNode } from "@jexs/physics";
import { GlNode } from "@jexs/gl";
import { registerComputeLazy, registerDomLazy } from "../src/registerNodes.js";
import { TreeNode } from "../src/nodes/TreeNode.js";
import { ListNode } from "../src/nodes/ListNode.js";
import { WsNode } from "../src/nodes/WsNode.js";
import { PushNode } from "../src/nodes/PushNode.js";
import { WebRTCNode } from "../src/nodes/WebRTCNode.js";

type NodeClass = { name: string; schema: Record<string, unknown> } & (abstract new (...args: never[]) => Node);

/** Every op a lazily loaded node declares must be a lazy key, or the first call to
 *  it finds no handler: the module only loads once one of its keys is seen. */
function assertLazy(register: (r: ReturnType<typeof createResolver>) => void, classes: NodeClass[]): void {
  const resolver = createResolver([]);
  register(resolver);
  for (const cls of classes) {
    const missing = Object.keys(cls.schema).filter(k => !resolver.keys.has(k));
    assert.deepEqual(missing, [], `${cls.name} ops missing from the lazy keys`);
  }
}

test("every op of a worker-safe lazy node is a lazy key", () => {
  assertLazy(registerComputeLazy, [EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode, MeshNode]);
});

test("every op of a DOM lazy node is a lazy key", () => {
  assertLazy(registerDomLazy, [TreeNode, ListNode, WsNode, PushNode, WebRTCNode, GlNode]);
});
