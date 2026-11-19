import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, toVec, SPACE_DIMS } from "../src/index.js";

const resolve = createResolver(coreNodes());

// Vectors are arrays, as entity translations are; a 2D one meets a 3D one at
// z = 0, and the result is 3D.
test("vector ops take and return arrays", () => {
  assert.deepEqual(resolve({ $vectorAdd: [[1, 2], [3, 4, 5]] }, {}), [4, 6, 5]);
  assert.deepEqual(resolve({ $vectorSub: [[1, 2], [3, 4]] }, {}), [-2, -2]);
  assert.deepEqual(resolve({ $vectorScale: [[1, 2, 3], 2] }, {}), [2, 4, 6]);
  assert.deepEqual(resolve({ $vectorNormalize: [3, 4] }, {}), [0.6, 0.8]);
  assert.deepEqual(resolve({ $vectorCross: [[1, 0], [0, 1]] }, {}), [0, 0, 1]);
  assert.deepEqual(resolve({ $vectorToward: [[0, 0], [10, 0], 4] }, {}), [4, 0]);
  assert.deepEqual(resolve({ $vectorLerp: [[0, 0], [10, 20], 0.5] }, {}), [5, 10]);
  assert.deepEqual(resolve({ $vectorDirection: [[0, 0], [0, 5]] }, {}), [0, 1]);
  assert.equal(resolve({ $vectorDistance: [[0, 0], [3, 4]] }, {}), 5);
  assert.equal(resolve({ $vectorDot: [[1, 2, 3], [4, 5, 6]] }, {}), 32);
  assert.throws(() => resolve({ $vectorNormalize: { x: 3, y: 4 } }, {}), /Expected a vector of numbers/);
});

test("vector ops take vectors of any length", () => {
  assert.equal(resolve({ $vectorDot: [[1, 2, 3, 4], [4, 5, 6, 7]] }, {}), 60);
  assert.deepEqual(resolve({ $vectorNormalize: [1, 1, 1, 1] }, {}), [0.5, 0.5, 0.5, 0.5]);
  assert.equal(resolve({ $vectorDistance: [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]] }, {}), Math.sqrt(5));
  assert.deepEqual(resolve({ $vectorNormalize: [0, 0, 0, 0] }, {}), [0, 0, 0, 0]);
});

test("two vectors of different lengths throw, but a 2D and a 3D one", () => {
  const a = Array.from({ length: 1536 }, () => 0.1), b = Array.from({ length: 3072 }, () => 0.1);
  assert.throws(() => resolve({ $vectorDot: [{ $var: "a" }, { $var: "b" }] }, { a, b }), /Expected vectors of one length, got 1536 and 3072/);
  assert.throws(() => resolve({ $vectorAdd: [[1], [1, 1, 1, 1]] }, {}), /got 1 and 4/);
  assert.throws(() => resolve({ $vectorDistance: [[1, 2, 3, 4], [1, 2, 3]] }, {}), /got 4 and 3/);
  assert.equal(resolve({ $vectorDot: [[1, 2], [3, 4, 5]] }, {}), 11);
  assert.equal(resolve({ $vectorDistance: [[0, 0], [0, 0, 2]] }, {}), 2);
  assert.deepEqual(resolve({ $vectorLerp: [[0, 0], [0, 0, 10], 0.5] }, {}), [0, 0, 5]);
});

test("vectorToward stops at the target, and vectorDirection between one point is zero", () => {
  assert.deepEqual(resolve({ $vectorToward: [[0, 0], [3, 4], 10] }, {}), [3, 4]);
  assert.deepEqual(resolve({ $vectorToward: [[1, 1], [1, 1], -1] }, {}), [1, 1]);
  assert.deepEqual(resolve({ $vectorDirection: [[1, 1], [1, 1]] }, {}), [0, 0]);
});

test("vectorScale checks its vector and its operands", () => {
  assert.throws(() => resolve({ $vectorScale: [[1, 2, 3, 4], 2], dims: [2, 3] }, {}), /Expected a vector of 2 or 3 numbers, got one of 4/);
  assert.throws(() => resolve({ $vectorScale: [[1, 2]] }, {}), /\$vectorScale takes 2 operands, got 1/);
});

test("a vector op missing an operand throws", () => {
  assert.throws(() => resolve({ $vectorAdd: [[1, 2]] }, {}), /\$vectorAdd takes 2 operands, got 1/);
  assert.throws(() => resolve({ $vectorDot: [[1, 2]] }, {}), /\$vectorDot takes 2 operands, got 1/);
  assert.throws(() => resolve({ $vectorLerp: [[0, 0], [1, 1]] }, {}), /\$vectorLerp takes 3 operands, got 2/);
  assert.throws(() => resolve({ $vectorCross: [{ $var: "missing" }, [0, 1]] }, {}), /Expected a vector of numbers, got undefined/);
});

test("vectorDot of unit embeddings is their cosine similarity", () => {
  const dims = 1536;
  const unit = (seed: number) => {
    const v = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)));
    return resolve({ $vectorNormalize: { $var: "v" } }, { v }) as number[];
  };
  const a = unit(1), b = unit(2);
  assert.ok(Math.abs((resolve({ $vectorDot: [{ $var: "a" }, { $var: "a" }], dims }, { a }) as number) - 1) < 1e-9);
  const cos = resolve({ $vectorDot: [{ $var: "a" }, { $var: "b" }], dims }, { a, b }) as number;
  assert.ok(cos > -1 && cos < 1);
});

test("dims limits the lengths a vector may have", () => {
  assert.equal(resolve({ $vectorDot: [[1, 2], [3, 4]], dims: 2 }, {}), 11);
  assert.throws(() => resolve({ $vectorDot: [[1, 2], [3, 4, 5]], dims: 2 }, {}), /Expected a vector of 2 numbers, got one of 3/);
  assert.deepEqual(resolve({ $vectorAdd: [[1, 2], [3, 4, 5]], dims: [2, 3] }, {}), [4, 6, 5]);
  assert.throws(() => resolve({ $vectorNormalize: [1, 2, 3, 4], dims: [2, 3] }, {}), /Expected a vector of 2 or 3 numbers, got one of 4/);
  assert.equal(resolve({ $vectorDot: [[1, 2], [3, 4]], dims: { $var: "n" } }, { n: 2 }), 11);
  for (const dims of [0, -1, 1.5, "2", [], [2, "3"]]) {
    assert.throws(() => resolve({ $vectorDot: [[1, 2], [3, 4]], dims }, {}), /dims takes a vector length or a list of them/);
  }
});

test("vectorCross has a cross product only for 2D and 3D vectors", () => {
  assert.deepEqual(resolve({ $vectorCross: [[1, 0, 0], [0, 1, 0]] }, {}), [0, 0, 1]);
  assert.throws(() => resolve({ $vectorCross: [[1, 0, 0, 0], [0, 1, 0, 0]] }, {}), /2D or 3D/);
});

test("toVec takes a vector of the lengths given, and shortens what it shows of a bad one", () => {
  assert.deepEqual(toVec([1, 2], SPACE_DIMS), [1, 2]);
  assert.deepEqual(toVec([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.throws(() => toVec([1, 2, 3, 4], SPACE_DIMS), /Expected a vector of 2 or 3 numbers, got one of 4/);
  assert.throws(() => toVec([1], [2, 3, 4]), /Expected a vector of 2, 3 or 4 numbers, got one of 1/);
  assert.throws(() => toVec([]), /Expected a vector of numbers/);
  assert.throws(() => toVec([1, "2"]), /Expected a vector of numbers/);
  assert.throws(() => toVec("x".repeat(200)), (error: Error) => error.message.length < 140);
});
