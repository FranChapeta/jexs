import { test } from "node:test";
import assert from "node:assert/strict";
import { createValidation, getValidator, validate, validateDetailed, MAX_COMPILED } from "../src/validate.js";

const validation = createValidation();

// A route handler written as an expression hands over an equal but new schema
// object on every request; it must compile once, not once per request.
test("an equal schema object reuses the compiled validator", () => {
  const schema = () => ({ type: "object", properties: { page: { type: "integer" } } });
  const first = getValidator(validation, schema());
  for (let i = 0; i < 100; i++) assert.equal(getValidator(validation, schema()), first);
});

test("a schema with an $id can arrive again as a new object", () => {
  const schema = () => ({ $id: "jexs://test/query", type: "object", required: ["q"] });
  assert.equal(validate(validation, schema(), { q: "x" }).valid, true);
  assert.equal(validate(validation, schema(), {}).valid, false);
});

test("a schema changed in place gets a validator for what it says now", () => {
  const schema: { type: string; minimum?: number } = { type: "number" };
  assert.equal(validate(validation, schema, 1).valid, true);
  schema.minimum = 5;
  assert.equal(validate(validation, schema, 1).valid, false);
});

test("different schemas still compile separately", () => {
  assert.notEqual(getValidator(validation, { type: "string" }), getValidator(validation, { type: "number" }));
});

// Each node that validates compiles into its own Ajv, so two resolvers in one
// process can use the same `$id` for different schemas.
test("two validations keep their own compiled schemas, $ids included", () => {
  const a = createValidation();
  const b = createValidation();
  assert.equal(validate(a, { $id: "jexs://test/shared", type: "string" }, "x").valid, true);
  assert.equal(validate(b, { $id: "jexs://test/shared", type: "number" }, 1).valid, true);
});

// Schemas built per request (a document from request data, say) must not grow
// the cache without bound; the least recently used are dropped, from Ajv too, so
// an evicted schema's `$id` can be compiled again with other content.
test("a validation keeps at most MAX_COMPILED schemas, dropping the least recently used", () => {
  const own = createValidation();
  const kept = { $id: "jexs://test/kept", type: "string" };
  validate(own, kept, "x");
  validate(own, { $id: "jexs://test/evicted", type: "string" }, "x");
  for (let i = 0; i < MAX_COMPILED; i++) {
    validate(own, { type: "integer", minimum: i }, i);
    if (i % 100 === 0) validate(own, kept, "x"); // used recently, so kept
  }
  assert.equal(own.compiled.size, MAX_COMPILED);
  assert.equal(validate(own, { $id: "jexs://test/evicted", type: "number" }, 1).valid, true);
  assert.equal(validate(own, kept, 1).valid, false, "the kept schema still validates as a string");
});

// Ajv leaves the offending name out of these messages; a reader of the report
// needs it to find the mistake.
test("an error names the property it is about", () => {
  const schema = {
    type: "object",
    properties: { user: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false } },
    patternProperties: { "^\\$": false },
    propertyNames: { maxLength: 8 },
  };
  const data = { user: { name: "a", nmae: "b" }, $concta: 1, averylongname: 2 };
  assert.deepEqual(validate(validation, schema, data).errors.sort(), [
    "\"$concta\" is not allowed here",
    "\"user\" must not have property \"nmae\"",
    "property name \"averylongname\" must NOT have more than 8 characters",
    "must not have a property named \"averylongname\"",
  ].sort());
  const detailed = validateDetailed(validation, schema, data).errors.find(e => e.keyword === "additionalProperties");
  assert.deepEqual(detailed, { path: "user", message: "must not have property \"nmae\"", keyword: "additionalProperties" });
});
