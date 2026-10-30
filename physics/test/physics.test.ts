import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, childContext, type Context } from "@jexs/core";
import { EntityNode, PhysicsNode, CollisionNode, JointNode, VectorNode, EntityStore, offloadWorld, type PhysicsConfig } from "../src/index.js";

const physicsResolver = () =>
  createResolver([...coreNodes(), new EntityNode(), new PhysicsNode(), new CollisionNode(), new JointNode(), new VectorNode()]);

// Vectors are arrays, as entity translations are; a 2D vector meets a 3D one
// at z = 0, and the result is 3D when either is.
test("vector ops take and return arrays", async () => {
  const r = physicsResolver();
  try {
    assert.deepEqual(await r({ "$vectorAdd": [[1, 2], [3, 4, 5]] }, {}), [4, 6, 5]);
    assert.deepEqual(await r({ "$vectorSub": [[1, 2], [3, 4]] }, {}), [-2, -2]);
    assert.deepEqual(await r({ "$vectorScale": [[1, 2, 3], 2] }, {}), [2, 4, 6]);
    assert.deepEqual(await r({ "$vectorNormalize": [3, 4] }, {}), [0.6, 0.8]);
    assert.deepEqual(await r({ "$vectorCross": [[1, 0], [0, 1]] }, {}), [0, 0, 1]);
    assert.deepEqual(await r({ "$vectorToward": [[0, 0], [10, 0], 4] }, {}), [4, 0]);
    assert.equal(await r({ "$vectorDistance": [[0, 0], [3, 4]] }, {}), 5);
    assert.equal(await r({ "$vectorDot": [[1, 2, 3], [4, 5, 6]] }, {}), 32);
    await assert.rejects(async () => r({ "$vectorNormalize": { x: 3, y: 4 } }, {}), /Expected \[x, y\] or \[x, y, z\]/);
  } finally {
    r.destroy();
  }
});

test("a raycast takes array vectors and reports where it hit as one", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    await r({ "$entityInit": "#game" }, context);
    await r({ "$entityAdd": "wall", type: "quad", translation: [10, 0, 0], scale: [2, 2, 2] }, context);
    const hits = await r({ "$physicsRaycast": true, from: [0, 1, 1], dir: [1, 0, 0] }, context);
    assert.ok(Array.isArray(hits) && hits.length === 1);
    assert.deepEqual(hits[0].point, [10, 1, 1]);
  } finally {
    r.destroy();
  }
});

// A 2D vector puts a new entity at z 0 and flat, and leaves an existing one's
// z and depth as they are.
// A page runs entityInit in one handler (a mount) and moves entities from
// others (key and click handlers), each a scope of its own under the page.
test("a store made in one handler's scope is found from another's", async () => {
  const r = physicsResolver();
  try {
    const page: Context = {};
    await r({ "$entityInit": "#game" }, childContext(page, {}));
    await r({ "$entityAdd": "player", translation: [5, 6, 0] }, childContext(page, {}));
    assert.equal(await r({ "$entityGet": "player", prop: "tx" }, childContext(page, {})), 5);
  } finally {
    r.destroy();
  }
});

test("with several stores an op names one with `store`, and with one it needs none", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    await assert.rejects(async () => r({ "$entityList": true }, context), /No entity store: entityInit or glInit makes one/);
    await r({ "$entityInit": "a" }, context);
    await r({ "$entityAdd": "p", translation: [1, 0, 0] }, context);
    await r({ "$entityInit": "b" }, context);
    await assert.rejects(async () => r({ "$entityList": true }, context), /There are 2 entity stores \(a, b\): name one with `store`/);
    await r({ "$entityAdd": "p", translation: [2, 0, 0], store: { "$var": "which" } }, { ...context, which: "b" });
    assert.equal(await r({ "$entityGet": "p", prop: "tx", store: "a" }, context), 1);
    assert.equal(await r({ "$entityGet": "p", prop: "tx", store: "b" }, context), 2);
    await assert.rejects(async () => r({ "$entityGet": "p", store: "c" }, context), /No entity store named "c"/);
    // `store` names the store; it is not kept on the entity.
    assert.equal((await r({ "$entityGet": "p", store: "b" }, context) as Record<string, unknown>).store, undefined);
  } finally {
    r.destroy();
  }
});

// z orders flat entities for drawing; it never keeps two of them from colliding.
test("a flat body lands on a flat static at another z", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    await r({ "$entityInit": "#game", width: 1600, height: 600 }, context);
    await r({ "$entityAdd": "floor", translation: [0, 570, 0], scale: [1600, 30], physics: true, mass: 0, group: "ground" }, context);
    await r({ "$entityAdd": "player", translation: [120, 410, 5], scale: [28, 38], physics: true, mass: 1, group: "player", mask: ["ground"] }, context);
    await r({ "$physicsInit": true, gravity: [0, 900], bounds: "canvas", start: false }, context);
    for (let i = 0; i < 120; i++) await r({ "$physicsStep": true }, context);
    assert.ok(Math.abs(Number(await r({ "$entityGet": "player", prop: "ty" }, context)) - 532) < 1);
  } finally {
    r.destroy();
  }
});

test("a 2D translation or scale leaves z as it is", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    const get = (prop: string) => r({ "$entityGet": "a", prop }, context);
    await r({ "$entityInit": "#game" }, context);
    await r({ "$entityAdd": "a", type: "quad", translation: [1, 2], scale: [3, 4] }, context);
    assert.deepEqual(await get("translation"), [1, 2, 0]);
    assert.deepEqual(await get("scale"), [3, 4, 0]);
    await r({ "$entityUpdate": "a", translation: [0, 0, 5], scale: [1, 1, 2] }, context);
    await r({ "$entityUpdate": "a", translation: [7, 8], scale: [9, 9] }, context);
    assert.deepEqual(await get("translation"), [7, 8, 5]);
    assert.deepEqual(await get("scale"), [9, 9, 2]);
    await r({ "$entityMove": "a", translation: [1, 1] }, context);
    assert.deepEqual(await get("translation"), [1, 1, 5]);
  } finally {
    r.destroy();
  }
});

test("an entity color given without alpha is opaque", async () => {
  const r = physicsResolver();
  try {
    const context: Context = {};
    await r({ "$entityInit": "#game" }, context);
    await r({ "$entityAdd": "a", type: "quad", color: [1, 0.5, 0] }, context);
    assert.deepEqual(await r({ "$entityGet": "a", prop: "color" }, context), [1, 0.5, 0, 1]);
    await r({ "$entityUpdate": "a", color: [0, 0, 1] }, context);
    assert.deepEqual(await r({ "$entityGet": "a", prop: "color" }, context), [0, 0, 1, 1]);
  } finally {
    r.destroy();
  }
});

/** A world on `#game` with one falling body, its context, and a reader for the body's height. */
async function world(resolver: ReturnType<typeof physicsResolver>, start: boolean) {
  const context: Context = {};
  await resolver({ "$entityInit": "#game" }, context);
  await resolver({ "$physicsInit": true, gravity: [0, 980], start }, context);
  await resolver({ "$entityAdd": "ball", type: "quad", translation: [100, 100, 0], scale: [10, 10, 1], physics: true }, context);
  const y = async () => {
    const translation = await resolver({ "$entityGet": "ball", prop: "translation" }, context);
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
    await a({ "$physicsStep": true, dt: 0.1 }, inA.context);
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
  await r({ "$entityInit": "#game", shared: true }, context);

  await r({ "$physicsInit": true, start: false }, context);
  await r({ "$physicsInit": true, start: false }, context);
  await r({ "$physicsDestroy": true }, context);
  await r({ "$physicsInit": true, start: false }, context);
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
