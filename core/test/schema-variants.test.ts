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

// A sibling's variants select by that sibling's VALUE, the way a primary key's do.
// `kind` scopes siblings and refines the output; `on` is a boolean enum; `wrap` is
// a method variant (which beats every sibling refinement); `plainop` is a method
// variant without an output, which therefore inherits the refinements.
class FakeSibValueNode extends Node {
  static schema: JexsNodeSchema = {
    fakesv: {
      type: "string",
      output: "string",
      siblings: {
        kind: {
          type: "string",
          enum: ["plain", "gated", "flag"],
          variants: {
            gated: { siblings: { size: { type: "number", required: true, description: "Gated size." } } },
            flag: {
              output: "boolean",
              markdownDescription: "Flag mode.",
              variants: { deep: { type: "string", siblings: { depth: { type: "number" } } } },
            },
          },
        },
        on: { type: "boolean", enum: [true, false], variants: { true: { output: "array" } } },
        // No enum: presence-selected, and only alongside `mode` itself.
        mode: { type: "string", variants: { verbose: { type: "boolean", siblings: { level: { type: "number" } } } } },
        // Every enum value has a variant with an output, so the value is always one of them.
        choose: { type: "string", enum: ["n", "b"], variants: { n: { output: "number" }, b: { output: "boolean" } } },
      },
      variants: {
        wrap: { type: "boolean", output: "null", outputDescription: "Always null." },
        plainop: { type: "string" },
      },
    },
  };
  fakesv() { return null; }
}

// `verb` defaults to `get`, so an omitted `verb` selects the `get` variant: its
// output applies and `payload` (declared only for `post`) is refused. `hint` opts
// out of exclusivity, so its values only add typed siblings.
class FakeDefaultValueNode extends Node {
  static schema: JexsNodeSchema = {
    fakedv: {
      type: "string",
      output: "string",
      siblings: {
        verb: {
          type: "string",
          enum: ["get", "post", "head"],
          default: "get",
          variants: {
            head: { output: "null" },
            post: { siblings: { payload: { type: "number" } } },
          },
        },
        hint: {
          type: "string",
          enum: ["a", "b"],
          exclusive: false,
          variants: { a: { siblings: { extra: { type: "number" } } } },
        },
      },
    },
  };
  fakedv() { return null; }
}

const combined = mergePackageSchemas([
  buildPackageSchema([
    ...coreNodes(), new FakeValNode(), new FakeSibNode(), new FakeDefaultNode(), new FakeSibValueNode(),
    new FakeDefaultValueNode(),
  ]),
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

test("sibling value: a variant's siblings are typed and required under that value, refused under the others", () => {
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "gated", size: 3 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "gated", size: "big" }), false);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "gated" }), false);
  // Exclusive: `size` belongs to `gated`, so another literal value refuses it, and an
  // expression-valued `kind` (which could be `gated`) does not.
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "plain", size: 3 }), false);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: { var: "$k" }, size: 3 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "nope" }), false);
});

test("sibling value: a variant narrows the output, and an expression-valued sibling falls back", () => {
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", kind: "flag" })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", kind: "flag" })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x" })), true);
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x" })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", kind: { var: "$k" } })), true);
});

test("sibling value: a boolean enum key selects the boolean value", () => {
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", on: true })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", on: false })), true);
});

test("covered enum: an expression-valued op still resolves to one of its ops' outputs", () => {
  // `fakeval`'s ops are string and array, so an op from an expression fits a
  // string slot but not a boolean one.
  assert.equal(validAt("$defs/exprFlat", inItem({ fakeval: { var: "$op" } })), true);
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakeval: { var: "$op" } })), false);
  // The same through a sibling: `choose` is number or boolean, whatever the expression.
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", choose: { var: "$p" } })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", choose: { var: "$p" } })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", choose: "b" })), false);
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", choose: "b" })), true);
});

test("output precedence: method variant, then siblings in declaration order, then inheritance", () => {
  // `wrap` (null) beats the `kind: "flag"` refinement (boolean).
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", wrap: true, kind: "flag" })), false);
  // `kind` is declared before `on`, so it wins over `on: true` (array).
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", kind: "flag", on: true })), true);
  // `plainop` declares no output, so the sibling refinement still applies under it.
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", plainop: "y", kind: "flag" })), true);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakesv: "x", plainop: "y", kind: "flag" })), false);
  // A presence variant under a sibling value, with no output, inherits the boolean.
  assert.equal(validAt("$defs/exprFlat", inParallel({ fakesv: "x", kind: "flag", deep: "y" })), true);
});

test("default: an omitted property selects its default value's variant", () => {
  // Omitted `verb` is `get`: `payload` belongs to `post` only.
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", payload: 1 }), false);
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", verb: "get", payload: 1 }), false);
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", verb: "post", payload: 1 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", verb: "post", payload: "no" }), false);
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", verb: { var: "$v" }, payload: 1 }), true);
  // `head` resolves to null; omitted `verb` is not `head`, so the string output stands.
  assert.equal(validAt("$defs/exprFlat", inItem({ fakedv: "x", verb: "head" })), false);
  assert.equal(validAt("$defs/exprFlat", inItem({ fakedv: "x" })), true);
});

test("exclusive: false keeps a property's variant siblings open", () => {
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", hint: "b", extra: 1 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakedv: "x", hint: "a", extra: "no" }), false);
});

test("a default outside the enum is rejected", () => {
  class Bad extends Node {
    static schema: JexsNodeSchema = { bad: { siblings: { m: { type: "string", enum: ["a"], default: "z" } } } };
  }
  assert.throws(() => buildPackageSchema([Bad]), /not one of the enum values/);
});

test("presence variants nest under a sibling value", () => {
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "flag", deep: "y", depth: 2 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "flag", deep: "y", depth: "no" }), false);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", kind: "plain", deep: "y", depth: 2 }), false);
});

test("a sibling's presence-selected variants apply only alongside that sibling", () => {
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", mode: "m", verbose: true, level: 2 }), true);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", mode: "m", verbose: true, level: "hi" }), false);
  assert.equal(validAt("$defs/exprFlat", { fakesv: "x", verbose: true, level: "hi" }), true);
  const docs = buildPackageSchema([new FakeSibValueNode()]).siblingDocs?.fakesv ?? [];
  assert.deepEqual(docs.find(d => d.name === "verbose")?.when, [{ key: "mode" }]);
  assert.deepEqual(docs.find(d => d.name === "level")?.when, [{ key: "mode" }, { key: "verbose" }]);
});

test("sibling docs carry the structured condition, the values, and each trigger's output", () => {
  const pkg = buildPackageSchema([new FakeSibValueNode(), new FakeValNode()]);
  const docs = pkg.siblingDocs?.fakesv ?? [];
  const find = (name: string) => docs.filter(d => d.name === name);

  assert.deepEqual(find("size"), [{ name: "size", description: "Gated size.", required: true, when: [{ key: "kind", value: "gated" }] }]);
  assert.deepEqual(find("depth")[0]?.when, [{ key: "kind", value: "flag" }, { key: "deep" }]);
  assert.deepEqual(find("kind")[0]?.values, [
    { value: "gated" },
    { value: "flag", output: "boolean", description: "Flag mode." },
  ]);
  assert.deepEqual(find("on")[0]?.values, [{ value: true, output: "array" }]);

  // A presence-selected operation is documented once, on its sibling.
  assert.deepEqual(find("wrap"), [{ name: "wrap", output: "null", outputDescription: "Always null." }]);
  assert.equal(pkg.byKey.fakesv.variantDocs, undefined);
  // Value-selected operations are the primary key's values.
  assert.deepEqual(pkg.byKey.fakeval.variantDocs, [{ value: "toStr", output: "string" }, { value: "toArr", output: "array" }]);
});

test("variants the build cannot select are rejected", () => {
  const build = (schema: JexsNodeSchema, commonSiblings?: JexsNodeSchema[string]["siblings"]) => {
    class Bad extends Node {
      static schema = schema;
      static commonSiblings = commonSiblings;
    }
    return () => buildPackageSchema([Bad]);
  };
  // A value-mode key that is not one of the enum values.
  assert.throws(build({ bad: { type: "string", enum: ["a"], variants: { b: {} } } }), /not one of its enum values/);
  // Value-mode variants nested under a value, which has no property to test.
  assert.throws(build({ bad: { type: "string", enum: ["a"], variants: { a: { enum: ["x"], variants: { x: {} } } } } }), /is itself a value/);
  // Inside a nested object, which no step key selects through.
  assert.throws(build({ bad: { siblings: { opts: { properties: { mode: { enum: ["x"], variants: { x: {} } } } } } } }), /not on a nested property/);
  // On a Node's shared siblings, which gate no single method.
  assert.throws(build({ bad: {} }, { mode: { enum: ["x"], variants: { x: {} } } }), /commonSiblings/);
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

test("mergePackageSchemas leaves the package schemas it is given intact", () => {
  const pkg = buildPackageSchema([...coreNodes()], "@jexs/core", { onCollision: "skip" });
  const before = structuredClone(pkg);

  mergePackageSchemas([pkg], { onCollision: "skip" });

  // The vp hoist used to swap each primary property for a `#/vp/<key>` ref and
  // the catch-all pass used to stamp `additionalProperties` — both on the
  // caller's own objects, leaving `pkg` full of refs into a document it does
  // not contain. A second consumer of the same array (`jexs schema` writes
  // .jexs/schema.json from it) saw the gutted version.
  assert.deepEqual(pkg, before);
  const primary = pkg.byKey.concat?.properties?.concat;
  assert.ok(primary && !("$ref" in primary && Object.keys(primary).length === 1),
    "primary property should still carry its own schema, not a bare $ref");
});

test("mergePackageSchemas is unaffected by merging the same schema twice", () => {
  const pkg = buildPackageSchema([...coreNodes()], "@jexs/core", { onCollision: "skip" });
  const first = mergePackageSchemas([pkg], { onCollision: "skip" });
  const second = mergePackageSchemas([pkg], { onCollision: "skip" });
  assert.deepEqual(second, first);
});
