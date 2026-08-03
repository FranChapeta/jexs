import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { Node, buildPackageSchema, mergePackageSchemas, coreNodes } from "../src/index.js";
import type { JexsNodeSchema } from "../src/schema.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

// Synthetic nodes exercise both discriminator modes without depending on a
// real consumer: value-mode (op = primary enum value) and sibling-mode (op =
// which sibling is present).
class FakeValNode extends Node {
  static schema: JexsNodeSchema = {
    fakeval: {
      type: "string",
      enum: ["toStr", "toArr"],
      variants: {
        toStr: { output: "string" },
        toArr: { output: "array" },
      },
    },
  };
  fakeval() { return null; }
}

class FakeSibNode extends Node {
  static schema: JexsNodeSchema = {
    fakesib: {
      type: "string",
      variants: {
        toBool: { type: "string", output: "boolean" },
        toArr2: { type: "string", output: "array" },
      },
    },
  };
  fakesib() { return null; }
}

// A method-level `output` is the fallback when no variant matches (FileNode `file`).
class FakeDefaultNode extends Node {
  static schema: JexsNodeSchema = {
    fakedef: {
      type: "string",
      output: "any",
      variants: {
        flag: { output: "boolean" },
      },
    },
  };
  fakedef() { return null; }
}

const combined = mergePackageSchemas([
  buildPackageSchema([...coreNodes, new FakeValNode(), new FakeSibNode(), new FakeDefaultNode()]),
]);

const ajv = new Ajv({ strict: false, allErrors: true });
for (const kw of ["markdownDescription", "output"]) {
  ajv.addKeyword({ keyword: kw, schemaType: ["string", "array", "object", "boolean"] });
}
ajv.addSchema(combined, "jexs://combined");

function validAt(ref: string, expr: unknown): boolean {
  return ajv.compile({ $ref: `jexs://combined#/${ref}` })(expr);
}

// `foreach.item` is a string slot → routes nested expressions to exprFlat_string;
// `foreach.parallel` is a boolean slot → exprFlat_boolean.
const inItem = (e: unknown) => ({ foreach: [1], item: e, do: "y" });
const inParallel = (e: unknown) => ({ foreach: [1], do: "y", parallel: e });

test("sibling-mode: op resolves and validates as a plain expression", () => {
  assert.equal(validAt("$defs/exprFlat", { fakesib: "x", toBool: "y" }), true);
  assert.equal(validAt("$defs/exprFlat", { fakesib: "x", toArr2: "y" }), true);
});

test("sibling-mode: boolean slot accepts the boolean variant but rejects the array one", () => {
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesib: "x", toBool: "y" })), true);
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesib: "x", toArr2: "y" })), false);
});

test("string ops carry regex via /re/: replace (string-output) accepted, match (array) rejected in a string slot", () => {
  assert.equal(validAt("$defs/exprFlat", inItem({ replace: ["a1", "/\\d/g", "#"] })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ match: ["a1", "/\\d/g"] })), false);
});

test("value-mode: string slot accepts the string variant value, rejects the array one", () => {
  assert.equal(validAt("$defs/exprFlat", inItem({ fakeval: "toStr" })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakeval: "toArr" })), false);
});

test("fallback output: method `output` applies when no variant matches (FileNode `file` pattern)", () => {
  // No trigger sibling -> fallback `any` -> accepted in any typed slot.
  assert.equal(validAt("$defs/exprFlat", inItem({ fakedef: "x" })), true);
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakedef: "x" })), true);
  // `flag` present -> boolean variant -> accepted in a boolean slot, rejected in a string slot.
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakedef: "x", flag: "y" })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakedef: "x", flag: "y" })), false);
});

test("flat-output methods are unaffected (string slot still rejects boolean output)", () => {
  assert.equal(validAt("$defs/exprFlat", inItem({ eq: [1, 1] })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ var: "$dynamic" })), true);
});

// The runtime (`buildEventsAttr`) wraps a non-array `do` into a one-step array,
// so a handler's `do` accepts either a step array OR a single expression.
const withDo = (d: unknown) => ({ tag: "button", events: { click: { do: d } } });

test("event handler `do` accepts a step array", () => {
  assert.equal(validAt("$defs/_eventHandler", { do: [{ var: "$x" }] }), true);
  assert.equal(validAt("$defs/exprFlat", withDo([{ var: "$x" }])), true);
});

test("event handler `do` accepts a single expression", () => {
  assert.equal(validAt("$defs/_eventHandler", { do: { var: "$x" } }), true);
  assert.equal(validAt("$defs/exprFlat", withDo({ var: "$x" })), true);
});

test("event handler `do` rejects a bare primitive (a no-op step)", () => {
  assert.equal(validAt("$defs/_eventHandler", { do: 5 }), false);
  assert.equal(validAt("$defs/exprFlat", withDo("noop")), false);
});

test("then: fire-and-forget (no `if`) is rejected in a typed value slot but valid as a step/expression", () => {
  const fireAndForget = { concat: ["a"], then: [{ var: "$result" }] };
  // Nested in a string-typed slot: a `then` node resolves to null -> rejected.
  assert.equal(validAt("$defs/exprFlat", inItem(fireAndForget)), false);
  // As a plain step/expression position (untyped): allowed.
  assert.equal(validAt("$defs/exprFlat", fireAndForget), true);
  // `if/then/else` (the branch form, not fire-and-forget) is still allowed nested.
  assert.equal(validAt("$defs/exprFlat", inItem({ if: true, then: "yes", else: "no" })), true);
});

test("then: a standalone continuation must be a step array", () => {
  assert.equal(validAt("$defs/exprFlat", { concat: ["a"], then: [{ var: "$result" }] }), true);
  assert.equal(validAt("$defs/exprFlat", { concat: ["a"], then: "nope" }), false);
});

test("`bubble` is only valid alongside `as` or `setVars`", () => {
  // valid: modifies a write
  assert.equal(validAt("$defs/exprFlat", { var: "$x", as: "x", bubble: true }), true);
  assert.equal(validAt("$defs/exprFlat", { setVars: { x: 1 }, bubble: true }), true);
  // invalid: nothing to bubble
  assert.equal(validAt("$defs/exprFlat", { concat: ["a"], bubble: true }), false);
  assert.equal(validAt("$defs/exprFlat", { bubble: true }), false);
});
