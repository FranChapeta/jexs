#!/usr/bin/env node
/**
 * Throwaway verification script — validates a handful of sample expressions
 * against the generated combined.schema.json using AJV 2020.
 *
 * Run: tsx scripts/verify-schema.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

const schema = JSON.parse(
  readFileSync(resolve("create/dist/combined.schema.json"), "utf-8"),
);

const ajv = new Ajv({ strict: false, allErrors: true });
// AJV doesn't know these author-time fields; mark them as no-ops so it doesn't warn.
for (const kw of ["markdownDescription", "output"]) {
  ajv.addKeyword({ keyword: kw, schemaType: ["string", "array", "object", "boolean"] });
}

interface Case {
  label: string;
  /** Which schema to validate against. "byKey/<methodKey>" or "exprFlat". */
  schemaRef: string;
  expr: unknown;
  expectValid: boolean;
}

const cases: Case[] = [
  // Should validate
  { label: "if/then/else", schemaRef: "byKey/if", expectValid: true,
    expr: { if: { var: "$active" }, then: "yes", else: "no" } },
  { label: "foreach with literal item", schemaRef: "byKey/foreach", expectValid: true,
    expr: { foreach: [1, 2, 3], do: { var: "$item" }, item: "x" } },
  { label: "foreach with expression item (now allowed since runtime resolves it)", schemaRef: "byKey/foreach", expectValid: true,
    expr: { foreach: [1, 2, 3], do: { var: "$item" }, item: { var: "$varName" } } },
  { label: "switch with cases", schemaRef: "byKey/switch", expectValid: true,
    expr: { switch: { var: "$role" }, cases: { admin: "full" }, default: "none" } },
  { label: "var", schemaRef: "byKey/var", expectValid: true,
    expr: { var: "$user.name" } },
  { label: "between [3]", schemaRef: "byKey/between", expectValid: true,
    expr: { between: [10, 1, 100] } },
  { label: "as via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { if: { var: "$x" }, then: 1, else: 2, as: "result" } },
  { label: "catch via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { if: { var: "$x" }, then: "ok", catch: [{ var: "$err" }] } },
  { label: "parallel as expression (implicit boolean-or-expr)", schemaRef: "byKey/foreach", expectValid: true,
    expr: { foreach: [1, 2], do: "x", parallel: { var: "$concurrent" } } },
  { label: "tag with mixed-content array of strings and elements (via exprFlat)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tag: "p", content: ["plain text", { tag: "b", content: ["bold"] }, "more text"] } },
  { label: "switch cases with primitive arrays (RGBA tuples)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { switch: { random: [0, 2] }, cases: { "0": [0.4, 0.25, 0.15, 1], "1": [0.3, 0.35, 0.3, 1] } } },

  // Output-type validation: a slot declared `type: string` should reject an expression
  // whose output is `number` or `boolean`.
  { label: "string-slot accepts number-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1, 2], item: { add: [1, 2] }, do: "x" } },
  { label: "string-slot accepts boolean-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1, 2], item: { eq: [1, 1] }, do: "x" } },
  { label: "string-slot accepts string-output expression (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { foreach: [1, 2], item: { toFixed: [3.14, 2] }, do: "x" } },
  { label: "string-slot accepts unannotated (any-output) expression (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { foreach: [1, 2], item: { var: "$dynamic" }, do: "x" } },

  // Should fail
  { label: "eq tuple too short", schemaRef: "byKey/eq", expectValid: false,
    expr: { eq: [1] } },
  { label: "between tuple too short", schemaRef: "byKey/between", expectValid: false,
    expr: { between: [10, 1] } },
  { label: "as must be string (exprFlat)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { if: { var: "$x" }, as: 42 } },
];

// Register the full schema so $ref into $defs (for nested expressions) resolves.
ajv.addSchema(schema, "jexs://combined");

let pass = 0, fail = 0;
for (const c of cases) {
  // Validate via $ref into the registered schema, so $defs/anyVal etc. resolve.
  const validate = ajv.compile({ $ref: `jexs://combined#/${c.schemaRef}` });
  const ok = validate(c.expr);
  const expectedLabel = c.expectValid ? "valid" : "invalid";
  const actualLabel = ok ? "valid" : "invalid";
  const passed = ok === c.expectValid;
  if (passed) {
    console.log(`PASS   ${c.label}: ${actualLabel}`);
    pass++;
  } else {
    console.log(`FAIL   ${c.label}: expected ${expectedLabel}, got ${actualLabel}`);
    if (validate.errors) {
      for (const e of validate.errors) console.log(`         ${e.instancePath || "/"}: ${e.message}`);
    }
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
