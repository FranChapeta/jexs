import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, type Context } from "@jexs/core";
import { EntityNode, PhysicsNode, CollisionNode, JointNode, EntityStore, offloadWorld, type PhysicsConfig } from "../src/index.js";

const physicsResolver = () =>
  createResolver([...coreNodes(), new EntityNode(), new PhysicsNode(), new CollisionNode(), new JointNode()]);

test("an entity color given without alpha is opaque", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    await r({ "$entity-init": "#game" }, context);
    await r({ "$entity-add": "a", type: "quad", color: [1, 0.5, 0] }, context);
    assert.deepEqual(await r({ "$entity-get": "a", prop: "color" }, context), [1, 0.5, 0, 1]);
    await r({ "$entity-update": "a", color: [0, 0, 1] }, context);
    assert.deepEqual(await r({ "$entity-get": "a", prop: "color" }, context), [0, 0, 1, 1]);
  } finally {
    r.destroy();
  }
});

/** A world on `#game` with one falling body, its context, and a reader for the body's height. */
async function world(resolver: ReturnType<typeof physicsResolver>, start: boolean) {
  const context: Context = {};
  await resolver({ "$entity-init": "#game" }, context);
  await resolver({ "$physics-init": true, gravity: [0, 980], start }, context);
  await resolver({ "$entity-add": "ball", type: "quad", translation: [100, 100, 0], scale: [10, 10, 1], physics: true }, context);
  const y = async () => {
    const translation = await resolver({ "$entity-get": "ball", prop: "translation" }, context);
    return (translation as number[])[1];
  };
  return { context, y };
}

// A world belongs to the resolver that created it, so another resolver
// creating one on the same selector neither replaces nor steps it.
test("two resolvers keep separate worlds on the same selector", async () => {
  const a = physicsResolver();
  const b = physicsResolver();
  try {
    const inA = await world(a, false);
    await world(b, false);
    const before = await inA.y();
    await a({ "$physics-step": true, dt: 0.1 }, inA.context);
    assert.ok(await inA.y() > before, "A's step moved A's body");
  } finally {
    a.destroy();
    b.destroy();
  }
});

// Every offloaded world in the realm shares one physics worker, so two worlds
// on one selector need separate jobs on it.
test("two offloaded worlds on one selector get separate jobs on the shared worker", (t) => {
  const store = () => new EntityStore(undefined, true);
  if (!store().getSharedBuffers()) return t.skip("growable SharedArrayBuffer is unavailable");
  const sent: Array<{ type: string; id?: string }> = [];
  const makeWorker = () => ({ postMessage: (msg: { type: string; id?: string }) => { sent.push(msg); }, terminate() {} });
  const config: PhysicsConfig = { gravity: [0, 980], damping: 0.01, bounds: null };

  const first = offloadWorld(makeWorker, "#game", store(), config);
  const second = offloadWorld(makeWorker, "#game", store(), config);
  const registered = sent.filter(m => m.type === "register").map(m => m.id);
  assert.equal(registered.length, 2);
  assert.notEqual(registered[0], registered[1]);

  first!.worker.stop();
  assert.deepEqual(sent.filter(m => m.type === "unregister").map(m => m.id), [registered[0]]);
  second!.worker.stop();
});

// Restarting or destroying a world keeps the shared worker warm for the next
// one; destroying the resolver lets it go.
test("a threaded world started again reuses the physics worker", async (t) => {
  if (!new EntityStore(undefined, true).getSharedBuffers()) return t.skip("growable SharedArrayBuffer is unavailable");
  const made: Array<{ terminated: boolean }> = [];
  const makeWorker = () => {
    const w = { terminated: false, postMessage() {}, terminate() { w.terminated = true; } };
    made.push(w);
    return w;
  };
  const r = createResolver([...coreNodes(), new EntityNode(), new PhysicsNode(makeWorker)]);
  const context: Context = {};
  await r({ "$entity-init": "#game", shared: true }, context);

  await r({ "$physics-init": true, start: false }, context);
  await r({ "$physics-init": true, start: false }, context);
  await r({ "$physics-destroy": true }, context);
  await r({ "$physics-init": true, start: false }, context);
  assert.equal(made.length, 1);
  assert.equal(made[0].terminated, false);

  r.destroy();
  assert.equal(made[0].terminated, true);
});

test("destroying the resolver stops its worlds' loops", async () => {
  const r = physicsResolver();
  const { y } = await world(r, true);
  await new Promise(done => setTimeout(done, 60));
  const moving = await y();
  assert.ok(moving > 100, "the loop was running");

  r.destroy();
  const stopped = await y();
  await new Promise(done => setTimeout(done, 60));
  assert.equal(await y(), stopped);
});
