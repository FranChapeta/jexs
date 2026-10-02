import { test } from "node:test";
import assert from "node:assert/strict";
import { getValidator, validate } from "../src/validate.js";

// A route handler written as an expression hands over an equal but new schema
// object on every request; it must compile once, not once per request.
test("an equal schema object reuses the compiled validator", () => {
  const schema = () => ({ type: "object", properties: { page: { type: "integer" } } });
  const first = getValidator(schema());
  for (let i = 0; i < 100; i++) assert.equal(getValidator(schema()), first);
});

test("a schema with an $id can arrive again as a new object", () => {
  const schema = () => ({ $id: "jexs://test/query", type: "object", required: ["q"] });
  assert.equal(validate(schema(), { q: "x" }).valid, true);
  assert.equal(validate(schema(), {}).valid, false);
});

test("a schema changed in place gets a validator for what it says now", () => {
  const schema: { type: string; minimum?: number } = { type: "number" };
  assert.equal(validate(schema, 1).valid, true);
  schema.minimum = 5;
  assert.equal(validate(schema, 1).valid, false);
});

test("different schemas still compile separately", () => {
  assert.notEqual(getValidator({ type: "string" }), getValidator({ type: "number" }));
});
