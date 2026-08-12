import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { buildPackageSchema, mergePackageSchemas, coreNodes } from "@jexs/core";
import { AppNode, DialogNode, WindowNode } from "../src/index.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

const electronNodeClasses = [WindowNode, DialogNode, AppNode];

const combined = mergePackageSchemas([
  buildPackageSchema([...coreNodes], "@jexs/core"),
  buildPackageSchema(electronNodeClasses.map((C) => new C()), "@jexs/electron"),
]);

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(combined, "jexs://combined");

function validAt(ref: string, expr: unknown): boolean {
  return ajv.compile({ $ref: `jexs://combined#/${ref}` })(expr);
}

test("every electron op is present in byKey", () => {
  const byKey = (combined as unknown as { byKey: Record<string, unknown> }).byKey;
  assert.ok(byKey && Object.keys(byKey).length > 0, "combined schema has no byKey");
  for (const op of ["window", "dialog-open", "dialog-message", "app-quit", "app-path"]) {
    assert.ok(op in byKey, `${op} missing from byKey`);
  }
});

// Each op documents itself with `examples`; if an example does not validate, either
// the example or the schema is wrong. This is the cheapest guard against a schema
// that drifts from the handler it describes.
test("every declared example validates against the combined schema", () => {
  for (const NodeClass of electronNodeClasses) {
    const schema = NodeClass.schema as Record<string, { examples?: unknown[] }>;
    for (const [op, method] of Object.entries(schema)) {
      for (const raw of method.examples ?? []) {
        const expr = JSON.parse(String(raw));
        assert.ok(
          validAt("$defs/exprFlat", expr),
          `${NodeClass.name}.${op} example failed: ${String(raw)}\n${ajv.errorsText()}`,
        );
      }
    }
  }
});

test("window accepts its declared siblings and expressions in them", () => {
  assert.equal(validAt("$defs/exprFlat", { window: "settings.json" }), true);
  assert.equal(
    validAt("$defs/exprFlat", { window: "settings.json", width: 480, height: 320, title: "S" }),
    true,
  );
  // Siblings are resolved now, so an expression in one must validate.
  assert.equal(
    validAt("$defs/exprFlat", { window: "settings.json", width: { var: "$w" } }),
    true,
  );
});

test("dialog-open constrains properties to the known enum", () => {
  assert.equal(
    validAt("$defs/exprFlat", { "dialog-open": "Open", properties: ["openFile"] }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { "dialog-open": "Open", properties: ["notAProperty"] }),
    false,
  );
});

test("dialog-message constrains type to the known enum", () => {
  assert.equal(validAt("$defs/exprFlat", { "dialog-message": "Hi", type: "question" }), true);
  assert.equal(validAt("$defs/exprFlat", { "dialog-message": "Hi", type: "banana" }), false);
});

test("no electron key collides with a core key", () => {
  const coreKeys = new Set(
    coreNodes.flatMap((n) => [...(n.handlerKeys ?? [])]),
  );
  for (const NodeClass of electronNodeClasses) {
    for (const op of Object.keys(NodeClass.schema)) {
      assert.ok(!coreKeys.has(op), `electron op "${op}" shadows a core key`);
    }
  }
});
