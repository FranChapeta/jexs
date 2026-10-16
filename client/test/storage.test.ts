import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { StorageNode } from "../src/nodes/StorageNode.js";

const window = installDom();
const resolve = createResolver([...coreNodes(), new StorageNode()]);
const run = (step: unknown) => resolve(step, {});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

test("set stores JSON for non-strings and get decodes it", async () => {
  assert.deepEqual(await run({ "$storage-set": "prefs", value: { theme: "dark" } }), { theme: "dark" });
  assert.equal(window.localStorage.getItem("prefs"), '{"theme":"dark"}');
  assert.deepEqual(await run({ "$storage-get": "prefs" }), { theme: "dark" });

  await run({ "$storage-set": "name", value: "Ada" });
  assert.equal(window.localStorage.getItem("name"), "Ada", "a string is stored as written");
  assert.equal(await run({ "$storage-get": "name" }), "Ada", "a value that is not JSON reads back raw");
  assert.equal(await run({ "$storage-get": "absent" }), null);
});

test("session: true uses sessionStorage", async () => {
  await run({ "$storage-set": "cart", value: [1, 2], session: true });
  assert.equal(window.localStorage.getItem("cart"), null);
  assert.deepEqual(await run({ "$storage-get": "cart", session: true }), [1, 2]);
});

test("keys lists the store, has finds an entry, and delete and clear empty it", async () => {
  await run({ "$storage-set": "a", value: 1 });
  await run({ "$storage-set": "b", value: null });
  assert.deepEqual((await run({ $storage: "keys" }) as string[]).sort(), ["a", "b"]);
  assert.equal(await run({ "$storage-has": "a" }), true);
  assert.equal(await run({ "$storage-has": "b" }), true, "a stored null is still an entry");
  assert.equal(await run({ "$storage-delete": "a" }), true);
  assert.equal(await run({ "$storage-delete": "a" }), false, "nothing left to delete");
  assert.equal(await run({ "$storage-has": "a" }), false);
  assert.deepEqual(await run({ $storage: "keys" }), ["b"]);
  assert.equal(await run({ $storage: "clear" }), true);
  assert.deepEqual(await run({ $storage: "keys" }), []);
});

test("set needs a value", () => {
  assert.throws(() => run({ "$storage-set": "only-key" }), /storage-set needs a `value`/);
});

// What this returns today; it is a candidate to throw instead (see the v2
// plan), so this pins the behaviour that changes.
test("an unknown bulk op returns null", async () => {
  assert.equal(await run({ $storage: "nope" }), null);
});
