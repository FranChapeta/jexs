import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, randomString } from "../src/index.js";

const resolve = createResolver(coreNodes());

// It names OAuth `state` values and the like, so it must not be predictable:
// the characters come from the platform's crypto source, never Math.random.
test("randomString draws from crypto, not Math.random", (t) => {
  t.mock.method(Math, "random", () => { throw new Error("Math.random used"); });
  const value = randomString(64);
  assert.equal(value.length, 64);
  assert.match(value, /^[A-Za-z0-9]{64}$/);
});

test("randomString defaults to 32 characters and differs between calls", () => {
  const a = randomString();
  assert.equal(a.length, 32);
  assert.notEqual(a, randomString());
});

test("$randomString gives that many letters and digits, 32 by default, and ignores the seed", () => {
  assert.match(String(resolve({ $randomString: 16 }, {})), /^[A-Za-z0-9]{16}$/);
  assert.equal(String(resolve({ $randomString: { $var: "missing" } }, {})).length, 32);
  resolve({ $randomSeed: 1 }, {});
  const a = resolve({ $randomString: 24 }, {});
  resolve({ $randomSeed: 1 }, {});
  assert.notEqual(resolve({ $randomString: 24 }, {}), a);
  resolve({ $randomSeed: null }, {});
});

test("$randomString draws only from `chars`, every one of them in time", () => {
  const out = String(resolve({ $randomString: 400, chars: "ab01" }, {}));
  assert.match(out, /^[ab01]{400}$/);
  assert.deepEqual([...new Set(out)].sort(), ["0", "1", "a", "b"]);
  assert.match(String(resolve({ $randomString: 5, chars: "🙂x" }, {})), /^(🙂|x){5}$/u);
});

test("$randomString refuses chars that are not 1 to 256 characters of a string", () => {
  assert.throws(() => resolve({ $randomString: 4, chars: "" }, {}), /from 1 to 256 characters, got 0/);
  assert.throws(() => resolve({ $randomString: 4, chars: "x".repeat(257) }, {}), /got 257/);
  assert.throws(() => resolve({ $randomString: 4, chars: ["a", "b"] }, {}), /chars must be a string/);
});

test("$randomString refuses a length that is not a whole number", () => {
  for (const bad of [-1, 2.5, "8", null]) {
    assert.throws(() => resolve({ $randomString: bad }, {}), /\$randomString takes a length/, JSON.stringify(bad));
  }
});
