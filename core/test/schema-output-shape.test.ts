import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { Node, buildPackageSchema, mergePackageSchemas, coreNodes } from "../src/index.js";
import type { JexsNodeSchema } from "../src/schema.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

// An `output` may be a schema: a `$ref` to one of the Node's defs, or inline.
// It routes into typed slots by its type, and is kept for readers as the shape.
class ShapeNode extends Node {
  static schema: JexsNodeSchema = {
    fakepoint: { output: { $ref: "#/$defs/_point" } },
    fakelist: { output: { type: "array", items: { type: "number" } } },
    fakeop: {
      type: "string",
      enum: ["make", "name"],
      variants: {
        make: { output: { $ref: "#/$defs/_point" } },
        name: { output: "string" },
      },
    },
  };
  static schemaDefs = {
    _point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
  };
  fakepoint() { return null; }
  fakelist() { return null; }
  fakeop() { return null; }
}

const pkg = buildPackageSchema([...coreNodes(), new ShapeNode()]);
const combined = mergePackageSchemas([pkg]);
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(combined, "jexs://combined");
const valid = (expr: unknown) => ajv.compile({ $ref: "jexs://combined#/$defs/exprFlat" })(expr);

// `foreach.item` is a string slot; `$join`'s value is an array slot.
const inString = (e: unknown) => ({ $foreach: [1], item: e, do: "y" });
const inArray = (e: unknown) => ({ $join: e, separator: "," });

test("an output schema routes by its type, a $ref by its def's", () => {
  assert.equal(valid(inString({ $fakepoint: true })), false);
  assert.equal(valid(inArray({ $fakepoint: true })), false);
  assert.equal(valid(inArray({ $fakelist: true })), true);
  assert.equal(valid(inString({ $fakelist: true })), false);
  assert.equal(valid(inString({ $fakeop: "name" })), true);
  assert.equal(valid(inString({ $fakeop: "make" })), false);
});

test("the shape is kept for readers, and left out of the validating schema", () => {
  assert.equal(pkg.byKey.fakepoint.output, "object");
  assert.deepEqual(pkg.byKey.fakepoint.outputSchema, { $ref: "#/$defs/_point" });
  assert.deepEqual(pkg.byKey.fakelist.outputSchema, { type: "array", items: { type: "number" } });
  assert.deepEqual(pkg.byKey.fakeop.variantDocs, [
    { value: "make", output: "object", outputSchema: { $ref: "#/$defs/_point" } },
    { value: "name", output: "string" },
  ]);
  assert.match(JSON.stringify(combined.$defs), /"_point"/, "the def itself is in the combined schema");
  assert.doesNotMatch(JSON.stringify(combined), /"outputSchema"/);
});

test("hovers name the shape: a def, a list of it, or an object's fields", () => {
  const hover = (key: string) => String((combined.vp as Record<string, { markdownDescription?: string }>)[key]?.markdownDescription);
  assert.match(hover("fakepoint"), /\*\*Returns:\*\* `_point`/);
  assert.match(hover("fakelist"), /\*\*Returns:\*\* `number\[\]`/);
  assert.match(hover("fakeop"), /`make` → `_point`/);
});

test("an output schema the build cannot type is rejected", () => {
  const build = (schema: JexsNodeSchema) => () => buildPackageSchema([class extends Node { static schema = schema; }]);
  assert.throws(build({ bad: { output: { $ref: "#/$defs/_missing" } } }), /must name one of this Node's schemaDefs/);
  assert.throws(build({ bad: { output: { properties: { x: { type: "number" } } } } }), /needs a single `type`/);
});
