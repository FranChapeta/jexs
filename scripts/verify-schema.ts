#!/usr/bin/env node
/**
 * Throwaway verification script — validates a handful of sample expressions
 * against the combined schema that `jexs schema` generates for this repo
 * (.jexs/combined.schema.json) using AJV 2020.
 *
 * Run: `npm run build:schema` (builds the schema, then runs this).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

const schema = JSON.parse(
  readFileSync(resolve(".jexs/combined.schema.json"), "utf-8"),
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
  { label: "filter with renamed item sibling", schemaRef: "byKey/filter", expectValid: true,
    expr: { filter: [{ var: "$users" }, { eq: [{ var: "u.role" }, "admin"] }], item: "u" } },
  { label: "return via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { if: { var: "$x" }, then: { return: "early" } } },
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

  // Regex via /re/ detection on string ops, with per-op output narrowing in slots.
  { label: "replace with /regex/ search (string-output) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { replace: ["a1 b2", "/\\d/g", "#"] } },
  { label: "string-slot accepts replace (regex substitution, string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { foreach: [1], item: { replace: ["a1", "/\\d/g", "#"] }, do: "y" } },
  { label: "string-slot rejects match (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1], item: { match: ["a1", "/\\d/g"] }, do: "y" } },
  // Variants — value-mode (tailwind): op chosen by the primary enum value.
  { label: "tailwind build (value-mode) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tailwind: "build", data: { var: "$t" } } },
  { label: "string-slot rejects tailwind classes (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1], item: { tailwind: "classes" }, do: "y" } },

  // Value-mode variants on real nodes: per-op output narrowing in typed slots.
  { label: "string-slot accepts oauth authUrl (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { foreach: [1], item: { oauth: "authUrl", provider: "google" }, do: "y" } },
  { label: "string-slot rejects oauth providers (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1], item: { oauth: "providers" }, do: "y" } },
  { label: "string-slot rejects database tableExists (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1], item: { database: "tableExists", table: "users" }, do: "y" } },
  { label: "schema list (array-output) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { schema: "list" } },

  // QueryNode: `{ query: <op>, table, options }` value-mode shape.
  { label: "query select (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { query: "select", table: "users", options: { where: { id: { var: "$id" } }, first: true, leftJoin: [{ table: "roles", on: { "users.role_id": "roles.id" } }] } } },
  { label: "query update with increment + options.returning (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { query: "update", table: "posts", options: { where: { id: 1 }, increment: { views: 1 }, returning: ["views"] } } },
  // Root-level returning is tolerated (permissive catch-all) but does NOT trigger
  // narrowing — only `options.returning` does. So in an array slot it stays number.
  { label: "root returning doesn't narrow update to array (array-slot FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { concat: { query: "update", table: "t", returning: ["id"], options: { where: { id: 1 } } } } },
  // Dotted nested-presence narrowing: update is number, but array with options.returning.
  { label: "number-slot accepts update WITHOUT returning (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { sleep: { query: "update", table: "t", options: { where: { id: 1 } } } } },
  { label: "number-slot rejects update WITH options.returning (now array) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { sleep: { query: "update", table: "t", options: { where: { id: 1 }, returning: ["id"] } } } },
  { label: "array-slot accepts update WITH options.returning (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { concat: { query: "update", table: "t", options: { where: { id: 1 }, returning: ["id"] } } } },
  { label: "array-slot rejects update WITHOUT returning (number) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { concat: { query: "update", table: "t", options: { where: { id: 1 } } } } },
  { label: "query count with leftJoin + distinct (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { query: "count", table: "users", options: { distinct: true, columns: ["email"], leftJoin: [{ table: "orders", on: { "users.id": "orders.user_id" } }] } } },
  { label: "query upsert with merge subset (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { query: "upsert", table: "users", options: { data: { id: 1, name: "x" }, conflict: ["id"], merge: ["name"] } } },
  { label: "query insert with ignore (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { query: "insert", table: "users", options: { data: { name: "x" }, ignore: true } } },
  { label: "query cross-op option: select with data (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { query: "select", table: "users", options: { data: { name: "x" } } } },
  { label: "query option typo (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { query: "select", table: "users", options: { wheer: { id: 1 } } } },
  { label: "query invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { query: "frobnicate", table: "users" } },
  { label: "string-slot rejects query count (number-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { foreach: [1], item: { query: "count", table: "users" }, do: "y" } },

  // Keyless ops folded into the bare `cache`/`storage` key (value-mode).
  { label: "cache value-mode stats (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { cache: "stats" } },
  { label: "cache value-mode invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { cache: "wipe" } },
  { label: "cache-connect keyed (driver value) still valid (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "cache-connect": "redis", host: "localhost", port: 6379 } },
  { label: "storage value-mode keys (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { storage: "keys" } },
  { label: "storage value-mode clear + session sibling (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { storage: "clear", session: true } },
  // Sibling/handler-key collision: `session` is both a sibling (StorageNode) and a
  // handler key (SessionNode). Dispatch is gated by primary key.
  { label: "session sibling on storage-get (gated, valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "storage-get": "cart", session: true } },
  { label: "session as its OWN op still validates (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { session: { user_id: 123 } } },
  { label: "storage value-mode invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { storage: "nuke" } },
  { label: "array-slot accepts storage keys (array-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { concat: { storage: "keys" } } },
  { label: "array-slot rejects storage clear (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { concat: { storage: "clear" } } },

  // ElementNode per-tag attribute variants (value-mode, permissive: custom tags
  // and unknown attrs still pass; known attrs are type/enum-checked).
  { label: "element a with href + target (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tag: "a", href: "/x", target: "_blank", content: ["hi"] } },
  { label: "element input bad type enum (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { tag: "input", type: "notatype" } },
  { label: "element custom tag accepted (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tag: "my-widget", foo: "bar", content: [] } },
  { label: "element unknown attr on div accepted (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tag: "div", "data-x": "1", "hx-get": "/y" } },
  { label: "element if-on-tag is gated, not LogicNode if (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { tag: "div", if: { var: "$show" }, content: ["x"] } },

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
