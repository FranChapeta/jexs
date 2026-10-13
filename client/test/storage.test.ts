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
  assert.deepEqual(await run({ "$storage-set": ["prefs", { theme: "dark" }] }), { theme: "dark" });
  assert.equal(window.localStorage.getItem("prefs"), '{"theme":"dark"}');
  assert.deepEqual(await run({ "$storage-get": "prefs" }), { theme: "dark" });

  await run({ "$storage-set": ["name", "Ada"] });
  assert.equal(window.localStorage.getItem("name"), "Ada", "a string is stored as written");
  assert.equal(await run({ "$storage-get": "name" }), "Ada", "a value that is not JSON reads back raw");
  assert.equal(await run({ "$storage-get": "absent" }), null);
});

test("session: true uses sessionStorage", async () => {
  await run({ "$storage-set": ["cart", [1, 2]], session: true });
  assert.equal(window.localStorage.getItem("cart"), null);
  assert.deepEqual(await run({ "$storage-get": "cart", session: true }), [1, 2]);
});

test("keys lists the store, and remove and clear empty it", async () => {
  await run({ "$storage-set": ["a", 1] });
  await run({ "$storage-set": ["b", 2] });
  assert.deepEqual((await run({ $storage: "keys" }) as string[]).sort(), ["a", "b"]);
  assert.equal(await run({ "$storage-remove": "a" }), true);
  assert.deepEqual(await run({ $storage: "keys" }), ["b"]);
  assert.equal(await run({ $storage: "clear" }), true);
  assert.deepEqual(await run({ $storage: "keys" }), []);
});

// What these return today; each is a candidate to throw instead (see the v2
// plan), so these pin the behaviour that changes.
test("a short set tuple and an unknown bulk op return null", async () => {
  assert.equal(await run({ "$storage-set": ["only-key"] }), null);
  assert.equal(await run({ $storage: "nope" }), null);
});
