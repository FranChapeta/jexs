import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { Node, coreNodes } from "../src/index.js";
import { buildPackageSchema, mergePackageSchemas } from "../src/schema-gen.js";
import type { JexsNodeSchema } from "../src/schema.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

// An enum on a slot of several literal types limits the types it has a value
// of, and leaves the others open.
class EnumNode extends Node {
  static schema: JexsNodeSchema = {
    fakeSide: { type: ["boolean", "string"], enum: [true, "left", "right"] },
    fakeNamed: { type: ["boolean", "string"], enum: ["left", "right"] },
    fakeSized: { type: ["number", "string", "null"], enum: [1, 2, "auto"] },
  };
  fakeSide() { return null; }
  fakeNamed() { return null; }
  fakeSized() { return null; }
}

const combined = mergePackageSchemas([buildPackageSchema([...coreNodes(), new EnumNode()])]);
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(combined, "jexs://combined");
const valid = (expr: unknown) => ajv.compile({ $ref: "jexs://combined#/$defs/exprFlat" })(expr);

test("true among the values limits the booleans to it", () => {
  assert.equal(valid({ $fakeSide: true }), true);
  assert.equal(valid({ $fakeSide: "left" }), true);
  assert.equal(valid({ $fakeSide: false }), false);
  assert.equal(valid({ $fakeSide: "up" }), false);
});

test("a type with no value in the enum is left open", () => {
  assert.equal(valid({ $fakeNamed: false }), true);
  assert.equal(valid({ $fakeNamed: "up" }), false);
  assert.equal(valid({ $fakeSized: null }), true);
});

test("numbers among the values limit the numbers to them", () => {
  assert.equal(valid({ $fakeSized: 2 }), true);
  assert.equal(valid({ $fakeSized: 3 }), false);
  assert.equal(valid({ $fakeSized: "auto" }), true);
});

test("an expression in the slot is not held to the enum", () => {
  assert.equal(valid({ $fakeSide: { $var: "side" } }), true);
});
