import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { Node, buildPackageSchema, mergePackageSchemas, coreNodes } from "../src/index.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

/** A package whose only contribution is these shared defs. */
function withDefs(defs: Record<string, Record<string, unknown>>) {
  class DefsNode extends Node {
    static schemaDefs = defs;
  }
  return mergePackageSchemas([buildPackageSchema(coreNodes(), "core"), buildPackageSchema([DefsNode], "defs")]);
}

function rootValidator(defs: Record<string, Record<string, unknown>>) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const kw of ["markdownDescription", "output"]) ajv.addKeyword({ keyword: kw, schemaType: ["string", "array", "object", "boolean"] });
  return ajv.compile(withDefs(defs));
}

const kinds = {
  // A file with `alpha` must be a `docA`; one with `alpha` and `beta` a `docAB`.
  docA:  { type: "object", required: ["alpha"], properties: { alpha: { type: "string" } } },
  docAB: { type: "object", required: ["alpha", "beta"], properties: { alpha: { type: "number" }, beta: { type: "number" } } },
};

test("a root document kind is enforced on a file with its required keys, most specific first", () => {
  const valid = rootValidator(kinds);
  assert.equal(valid({ alpha: "x" }), true);
  assert.equal(valid({ alpha: 1 }), false, "alpha alone selects docA, whose alpha is a string");
  assert.equal(valid({ alpha: 1, beta: 2 }), true, "both keys select docAB, whose alpha is a number");
  assert.equal(valid({ alpha: "x", beta: 2 }), false);
});

test("a file without a kind's keys is still Jexs", () => {
  const valid = rootValidator(kinds);
  assert.equal(valid([{ $var: "x" }]), true);
  assert.equal(valid({ $concat: ["a", "b"] }), true);
  assert.equal(valid({ gamma: 1 }), true);
});

test("underscored defs are shared shapes, not root kinds", () => {
  const combined = withDefs({ _shape: { type: "object" } });
  assert.deepEqual(combined.anyOf?.length, 2);
  assert.equal(combined.if, undefined);
});

test("a root kind must be recognizable by its required keys", () => {
  assert.throws(() => withDefs({ loose: { type: "object" } }), /"loose" needs a `required` list/);
  assert.throws(() => withDefs({ stepLike: { required: ["$concat"] } }), /requires "\$concat", an op key/);
  assert.throws(() => withDefs({ one: { required: ["a", "b"] }, two: { required: ["b", "a"] } }), /"one" and "two" require the same keys/);
});
