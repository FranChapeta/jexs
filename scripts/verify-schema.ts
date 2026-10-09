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
  /** Which schema to validate against: `byKey/<methodKey>`, `$defs/exprFlat`, or
   *  `""` for the schema ROOT (what an editor applies to a whole file). */
  schemaRef: string;
  expr: unknown;
  expectValid: boolean;
}

const cases: Case[] = [
  // Should validate
  { label: "if/then/else", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $if: { $var: "active" }, then: "yes", else: "no" } },
  { label: "foreach with literal item", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1, 2, 3], do: { $var: "item" }, item: "x" } },
  { label: "foreach with expression item (now allowed since runtime resolves it)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1, 2, 3], do: { $var: "item" }, item: { $var: "varName" } } },
  { label: "switch with cases", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $switch: { $var: "role" }, cases: { admin: "full" }, default: "none" } },
  { label: "filter with renamed item sibling", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $filter: [{ $var: "users" }, { $eq: [{ $var: "u.role" }, "admin"] }], item: "u" } },
  { label: "return via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $if: { $var: "x" }, then: { $return: "early" } } },
  { label: "var", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $var: "user.name" } },
  { label: "between [3]", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $between: [10, 1, 100] } },
  { label: "as via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $if: { $var: "x" }, then: 1, else: 2, $as: "result" } },
  { label: "catch via exprFlat", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $if: { $var: "x" }, then: "ok", $catch: [{ $var: "err" }] } },
  { label: "parallel as expression (implicit boolean-or-expr)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1, 2], do: "x", parallel: { $var: "concurrent" } } },
  { label: "tag with mixed-content array of strings and elements (via exprFlat)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "p", content: ["plain text", { $tag: "b", content: ["bold"] }, "more text"] } },
  { label: "switch cases with primitive arrays (RGBA tuples)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $switch: { $random: [0, 2] }, cases: { "0": [0.4, 0.25, 0.15, 1], "1": [0.3, 0.35, 0.3, 1] } } },

  // Output-type validation: a slot declared `type: string` should reject an expression
  // whose output is `number` or `boolean`.
  { label: "string-slot accepts number-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1, 2], item: { $add: [1, 2] }, do: "x" } },
  { label: "string-slot accepts boolean-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1, 2], item: { $eq: [1, 1] }, do: "x" } },
  { label: "string-slot accepts string-output expression (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1, 2], item: { $toFixed: [3.14, 2] }, do: "x" } },
  { label: "string-slot accepts unannotated (any-output) expression (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1, 2], item: { $var: "dynamic" }, do: "x" } },

  // Regex opt-in on string ops, with per-op output narrowing in slots.
  { label: "replace with regex: true (string-output) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $replace: ["a1 b2", "\\d", "#"], regex: true } },
  { label: "string-slot accepts replace (regex substitution, string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $replace: ["a1", "\\d", "#"], regex: true }, do: "y" } },
  { label: "string-slot rejects match all (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $match: ["a1", "\\d"], all: true }, do: "y" } },
  { label: "string-slot accepts match capture (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $match: ["a1", "(\\d)"], capture: 1 }, do: "y" } },
  { label: "flags without regex: true (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $contains: ["a", "A"], flags: "i" } },
  // Variants — value-mode (tailwind): op chosen by the primary enum value.
  { label: "tailwind build (value-mode) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tailwind: "build", data: { $var: "t" } } },
  { label: "string-slot rejects tailwind classes (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $tailwind: "classes" }, do: "y" } },

  // Value-mode variants on real nodes: per-op output narrowing in typed slots.
  { label: "string-slot accepts oauth authUrl (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $oauth: "authUrl", provider: "google" }, do: "y" } },
  { label: "string-slot rejects oauth providers (array-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $oauth: "providers" }, do: "y" } },
  { label: "string-slot rejects database tableExists (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $database: "tableExists", table: "users" }, do: "y" } },
  { label: "schema list (array-output) standalone", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $schema: "list" } },

  // QueryNode: `{ $query: <op>, table, ...clauses }` value-mode shape.
  { label: "query select (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "select", table: "users", where: { id: { $var: "id" } }, first: true, leftJoin: [{ table: "roles", on: { "users.role_id": "roles.id" } }] } },
  { label: "query update with increment + returning (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "update", table: "posts", where: { id: 1 }, increment: { views: 1 }, returning: ["views"] } },
  // Presence narrowing: update is a number, but an array with returning.
  { label: "number-slot accepts update WITHOUT returning (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $sleep: { $query: "update", table: "t", where: { id: 1 } } } },
  { label: "number-slot rejects update WITH returning (now array) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $sleep: { $query: "update", table: "t", where: { id: 1 }, returning: ["id"] } } },
  { label: "array-slot accepts update WITH returning (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: { $query: "update", table: "t", where: { id: 1 }, returning: ["id"] } } },
  { label: "array-slot rejects update WITHOUT returning (number) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $concat: { $query: "update", table: "t", where: { id: 1 } } } },
  { label: "query count with leftJoin + distinct (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "count", table: "users", distinct: true, columns: ["email"], leftJoin: [{ table: "orders", on: { "users.id": "orders.user_id" } }] } },
  { label: "query upsert with merge subset (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "upsert", table: "users", data: { id: 1, name: "x" }, conflict: ["id"], merge: ["name"] } },
  { label: "query insert with ignore (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "users", data: { name: "x" }, ignore: true } },
  { label: "query cross-op option: select with data (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $query: "select", table: "users", data: { name: "x" } } },
  { label: "query invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $query: "frobnicate", table: "users" } },
  { label: "string-slot rejects query count (number-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $query: "count", table: "users" }, do: "y" } },

  // FetchNode: `full` is a sibling-mode variant, so it narrows the output from
  // the decoded body ("any") to the `{ status, ok, headers, body, url }` envelope.
  { label: "fetch with headers/type/timeout (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/me", headers: { Authorization: { $concat: ["Bearer ", { $var: "token" }] } }, type: "text", timeout: 5000 } },
  { label: "fetch invalid method (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/me", method: "FETCH" } },
  { label: "fetch invalid decode type (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/me", type: "buffer" } },
  { label: "string-slot accepts a bare fetch (any-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $fetch: "/api/name" }, do: "y" } },
  { label: "string-slot rejects fetch full (object-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $fetch: "/api/name", full: true }, do: "y" } },
  // `type` is a sibling whose VALUE narrows the output; `full` still wins over it.
  { label: "string-slot accepts fetch type text (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $fetch: "/api/name", type: "text" }, do: "y" } },
  { label: "number-slot rejects fetch type text (string-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $sleep: { $fetch: "/api/n", type: "text" } } },
  { label: "string-slot rejects fetch full + type text (full wins: object) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $fetch: "/api/name", full: true, type: "text" }, do: "y" } },

  // `method` defaults to GET; only the methods that send a body take `body`, and HEAD resolves to null.
  { label: "fetch POST with a body (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/users", method: "POST", body: { name: "x" } } },
  { label: "fetch GET with a body (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/users", method: "GET", body: { name: "x" } } },
  { label: "fetch with a body and no method, i.e. GET (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/users", body: { name: "x" } } },
  { label: "fetch with an expression method and a body (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/users", method: { $var: "m" }, body: { name: "x" } } },
  { label: "string-slot rejects fetch HEAD (null-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $fetch: "/api/name", method: "HEAD" }, do: "y" } },
  { label: "null-slot accepts fetch HEAD (PASS)", schemaRef: "$defs/exprFlat_null", expectValid: true,
    expr: { $fetch: "/api/name", method: "HEAD" } },
  { label: "string-slot rejects fetch HEAD + type text (method is declared first: null) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $fetch: "/api/name", method: "HEAD", type: "text" }, do: "y" } },

  // Date `format`: `ms` is a number, `iso`/`datetime` strings; each op defaults its own.
  { label: "number-slot accepts dateAdd (default ms) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $sleep: { $dateAdd: [0, "1d"] } } },
  { label: "string-slot rejects dateAdd (default ms: number) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $dateAdd: [0, "1d"] }, do: "y" } },
  { label: "string-slot accepts dateAdd format iso (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $dateAdd: [0, "1d"], format: "iso" }, do: "y" } },
  { label: "string-slot accepts dateFormat (default datetime) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $dateFormat: 0 }, do: "y" } },
  { label: "string-slot rejects dateFormat format ms (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $dateFormat: 0, format: "ms" }, do: "y" } },
  { label: "string-slot accepts dateStartOf with an expression format (number or string) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $dateStartOf: 0, format: { $var: "f" } }, do: "y" } },
  { label: "boolean-slot rejects dateEndOf with an expression format (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], do: "y", parallel: { $dateEndOf: 0, format: { $var: "f" } } } },

  // joint-add: each constraint type reads its own siblings; `type` defaults to distance.
  { label: "joint-add spring with stiffness (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$joint-add": "j", type: "spring", a: "x", b: "y", stiffness: 0.8, damping: 0.2 } },
  { label: "joint-add distance with stiffness (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$joint-add": "j", type: "distance", a: "x", b: "y", stiffness: 0.8 } },
  { label: "joint-add without type (distance) with stiffness (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$joint-add": "j", a: "x", b: "y", stiffness: 0.8 } },
  { label: "joint-add hinge with angle limits and anchors (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$joint-add": "j", type: "hinge", a: "x", b: "y", minAngle: -45, maxAngle: 45, anchorA: [0, 10] } },
  { label: "joint-add hinge with a restLength (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$joint-add": "j", type: "hinge", a: "x", b: "y", restLength: 10 } },

  // gl-text: `size` is the MSDF path's, typed under `msdf`.
  { label: "gl-text msdf with a non-number size (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-text": "t", text: "hi", msdf: "roboto", size: "big" } },
  { label: "gl-text msdf with a size (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$gl-text": "t", text: "hi", msdf: "roboto", size: 24 } },

  // Table documents: register's `table`, create's `schema`, and db/tables/*.json files.
  { label: "table document (valid)", schemaRef: "$defs/tableSchema", expectValid: true,
    expr: { type: "object", required: ["email"], properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      email: { type: "string", format: "email", sqlType: "varchar", length: 255, unique: true },
      password: { type: "string", computed: { sha256: "password" } },
      created: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" },
    }, table: "users", indexes: { by_email: { columns: "email" } }, validator: [{ $var: "query" }] } },
  { label: "table document with a non-string table name (FAIL)", schemaRef: "$defs/tableSchema", expectValid: false,
    expr: { properties: {}, table: 5 } },
  { label: "table document with an unknown sqlType (FAIL)", schemaRef: "$defs/tableSchema", expectValid: false,
    expr: { properties: { n: { sqlType: "varchr" } }, table: "t" } },
  { label: "table document with an unknown compute function (FAIL)", schemaRef: "$defs/tableSchema", expectValid: false,
    expr: { properties: { n: { computed: { md5: "x" } } }, table: "t" } },
  { label: "table document with a malformed foreign key (FAIL)", schemaRef: "$defs/tableSchema", expectValid: false,
    expr: { properties: {}, table: "t", foreignKeys: { fk: { column: "a" } } } },
  { label: "a table file at the root (valid)", schemaRef: "", expectValid: true,
    expr: { properties: { id: { type: "integer", primaryKey: true } }, table: "t" } },
  { label: "a broken table file at the root (FAIL)", schemaRef: "", expectValid: false,
    expr: { properties: {}, table: "t", indexes: { i: {} } } },
  { label: "plain data at the root is not a table file (valid)", schemaRef: "", expectValid: true,
    expr: { properties: { a: 1 } } },
  { label: "register with a table document (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $schema: "register", table: { properties: { id: { type: "integer" } }, table: "t" } } },
  { label: "create by name, and from a var (valid)", schemaRef: "", expectValid: true,
    expr: [{ $query: "create", schema: "users" }, { $query: "create", schema: { $var: "doc" } }] },
  { label: "create with a broken inline document (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $query: "create", schema: { properties: {}, table: 5 } } },

  // gl-camera: follow-mode offsets belong to their mode, shake tuning to `shake`.
  { label: "gl-camera tps with its distance (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$gl-camera": true, follow: "player", followMode: "tps", tpsDistance: 10, yaw: 90 } },
  { label: "gl-camera fps with a tps distance (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-camera": true, followMode: "fps", tpsDistance: 10 } },
  { label: "gl-camera shake with a non-number duration (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-camera": true, shake: 5, shakeDuration: "long" } },
  { label: "gl-camera scene settings (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$gl-camera": true, fogColor: [0.5, 0.5, 0.6], bloom: true, shadow: false, skybox: "sky" } },
  { label: "gl-init with a bad fit (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-init": "#c", fit: "fill" } },
  { label: "gl-ssao with a non-number radius (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-ssao": true, radius: "wide" } },

  // Exclusive variant siblings on other value-selected ops; Element's `tag` opts out.
  { label: "database raw refuses connect's ssl (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $database: "raw", sql: "select 1", ssl: true } },
  { label: "cache-connect memory refuses redis's tls (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$cache-connect": "memory", tls: true } },
  { label: "tag div with an anchor's href (valid, tag is not exclusive)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", href: "/x" } },

  // cache-connect: every driver inherits the method's string output, endpoint variants included.
  { label: "number-slot rejects cache-connect redis + url (string-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $sleep: { "$cache-connect": "redis", url: "redis://x" } } },
  { label: "string-slot accepts cache-connect redis + url (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { "$cache-connect": "redis", url: "redis://x" }, do: "y" } },

  // `cache`'s ops cover its whole enum and resolve to null or an object, so an op
  // from an expression is one of those: fine in a null slot, wrong in a string one.
  { label: "null-slot accepts cache with an expression op (PASS)", schemaRef: "$defs/exprFlat_null", expectValid: true,
    expr: { $cache: { $var: "op" } } },
  { label: "string-slot rejects cache with an expression op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $cache: { $var: "op" } }, do: "y" } },
  { label: "null-slot rejects cache stats (object-output) (FAIL)", schemaRef: "$defs/exprFlat_null", expectValid: false,
    expr: { $cache: "stats" } },

  // entity-add: shape-owned fields are typed under their `type` value.
  { label: "entity-add light with a non-number radius (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-add": "lamp", type: "light", radius: "far" } },
  { label: "entity-add light with a numeric radius (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-add": "lamp", type: "light", radius: 40, coneAngle: 30, dirX: 1 } },
  { label: "entity-add light cone with a non-number dirX (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-add": "lamp", type: "light", coneAngle: 30, dirX: "left" } },
  // Variant siblings are exclusive: `radius` belongs to lights only.
  { label: "entity-add quad refuses a light's radius (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-add": "box", type: "quad", radius: 40 } },
  { label: "entity-add with an expression type refuses nothing (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-add": "box", type: { $var: "shape" }, radius: 40 } },
  { label: "entity-add line with a non-number lineWidth (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-add": "wire", type: "line", vertices: [0, 0, 1, 1], lineWidth: "thick" } },
  { label: "entity-update still types every field flat (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-update": "lamp", radius: "far" } },

  // EmailNode: `list` and `icalEvent` carry shapes of their own, told apart from
  // an expression that produces one by the presence of the shape's required key.
  { label: "email list with url/comment and a plain url (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", from: "me@x.com", list: { unsubscribe: "https://x.com/u", help: { url: "mailto:h@x.com", comment: "Help" } } } },
  { label: "email list value from an expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", list: { unsubscribe: { $concat: ["https://x.com/u/", { $var: "t" }] } } } },
  // The fields inside a def are `strOrExpr` refs rather than `type: "string"`,
  // because a def is emitted verbatim: a bare type would reject the expression.
  { label: "email list url from an expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", list: { help: { url: { $var: "helpUrl" }, comment: "Help" } } } },
  { label: "email list comment typo (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $email: "a@x.com", subject: "s", list: { help: { url: "mailto:h@x.com", commnet: "Help" } } } },
  { label: "email icalEvent object (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", icalEvent: { method: "REQUEST", content: { $var: "ics" } } } },
  { label: "email icalEvent whole value from an expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", icalEvent: { $var: "invite" } } },
  { label: "email icalEvent path instead of content (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $email: "a@x.com", subject: "s", icalEvent: { method: "REQUEST", content: "BEGIN:VCALENDAR", path: "/invites/x.ics" } } },
  { label: "email invalid priority (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $email: "a@x.com", subject: "s", priority: "urgent" } },

  // CryptoNode: hmac and timingSafeEqual are 2-tuples, with enum-checked siblings.
  { label: "hmac tuple with algorithm and encoding (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $hmac: [{ $var: "body" }, { $var: "secret" }], algorithm: "sha512", encoding: "base64url" } },
  { label: "hmac invalid algorithm (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $hmac: ["body", "key"], algorithm: "md5" } },
  { label: "hmac tuple too short (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $hmac: ["body"] } },
  { label: "string-slot accepts hmac (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $hmac: ["b", "k"] }, do: "y" } },
  { label: "string-slot rejects timingSafeEqual (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $timingSafeEqual: ["a", "b"] }, do: "y" } },
  { label: "sha256 invalid encoding (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $sha256: "abc", encoding: "hex64" } },
  { label: "string-slot accepts uuid (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $uuid: true }, do: "y" } },

  // base64 in StringsNode, both directions string-output.
  { label: "toBase64 with urlSafe (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toBase64: { $var: "text" }, urlSafe: true } },
  { label: "string-slot accepts fromBase64 (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { $fromBase64: { $var: "token" } }, do: "y" } },
  // The two decoders type their input, unlike the ops around them that coerce:
  // these read text that already IS base64 or JSON.
  { label: "fromBase64 given a number-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fromBase64: { $add: [1, 2] } } },
  { label: "parseJSON given a number-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $parseJSON: { $add: [1, 2] } } },
  { label: "parseJSON given an any-output expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $parseJSON: { $var: "raw" } } },
  { label: "toBase64 still takes anything, since it stringifies (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toBase64: { $add: [1, 2] } } },

  // WsNode: ws-status is string-output, binaryType is enum-checked.
  { label: "ws-connect with name, retry and protocols (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$ws-connect": "/feed", name: "feed", retry: 3, protocols: ["v2"], binaryType: "arraybuffer" } },
  { label: "ws-connect invalid binaryType (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$ws-connect": "/feed", binaryType: "buffer" } },
  { label: "string-slot accepts ws-status (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $foreach: [1], item: { "$ws-status": true }, do: "y" } },
  { label: "ws-close with code and reason (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$ws-close": true, name: "feed", code: 4001, reason: "signed out" } },

  // WebRTCNode: signalling is a seam, so `listen` carries the sink and the
  // handshake ops it replaced are gone.
  { label: "rtc listen with handlers and iceServers (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $rtc: "listen", trickle: false, timeout: 30000,
            iceServers: [{ urls: "turn:turn.test:3478", username: "u", credential: "p" }],
            "on-signal": { "$ws-send": { $var: "rtcSignal" } },
            "on-open": { $concat: ["up"] } } },
  { label: "rtc listen without on-signal (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $rtc: "listen", timeout: 30000 } },
  { label: "rtc-signal peer must be a string, not a number-output expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$rtc-signal": { $add: [1, 2] }, data: { $var: "wsMessage.sig" } } },
  { label: "rtc-signal without data (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$rtc-signal": { $var: "wsMessage.from" } } },
  { label: "rtc value-mode holds only the peerless ops (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $rtc: "connect", id: "peer" } },
  { label: "rtc send invalid channel (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$rtc-send": "peer", data: { n: 1 }, channel: "reliable" } },
  { label: "string-slot accepts rtc connect and rtc status (string-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: [{ "$rtc-connect": "peer" }, { "$rtc-status": "peer" }] } },

  // DomNode: pointerLocked reads the live browser state rather than a context
  // var a listener used to push, so it is boolean-output.
  { label: "string-slot rejects pointerLocked (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $foreach: [1], item: { $pointerLocked: true }, do: "y" } },

  // AudioNode: restart, and bytes handed in instead of a url.
  { label: "audio-play with restart (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$audio-play": "music", loop: true, restart: true } },
  { label: "audio-load from content (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$audio-load": "theme", content: { $var: "bytes" } } },

  // Keyless ops folded into the bare `cache`/`storage` key (value-mode).
  { label: "cache value-mode stats (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $cache: "stats" } },
  { label: "cache value-mode invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $cache: "wipe" } },
  { label: "cache-connect keyed (driver value) still valid (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "redis", host: "localhost", port: 6379 } },

  // `cache-connect` nests endpoint variants under each driver, the same shape as
  // `database connect`: port/username/password/db hang off `host`, not the driver.
  { label: "cache-connect redis via url (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "redis", url: "rediss://u:p@h:6379/0", prefix: "app" } },
  { label: "cache-connect redis host + its own siblings (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "redis", host: "h", port: 6379, username: "u", password: "p", db: 2 } },
  { label: "cache-connect redis url + tls layers (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "redis", url: "rediss://h:6379", tls: { ca: "certs/redis.pem" } } },
  { label: "cache-connect redis non-numeric port under host (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$cache-connect": "redis", host: "h", port: "nope" } },
  { label: "cache-connect memcached via servers list (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "memcached", servers: ["h1:11211", "h2:11211"], username: "u" } },
  { label: "cache-connect memcached servers must be strings (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$cache-connect": "memcached", servers: [11211] } },
  { label: "cache-connect memory with its own siblings (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$cache-connect": "memory", maxSize: 500, checkPeriod: 60 } },

  // `database connect` nests sibling-mode variants for the three ways to name an
  // endpoint (url / host / filename), so port/user/password/db are scoped to
  // `host` rather than sitting flat alongside the others.
  { label: "database connect via url alone (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", connection: "main", url: "postgres://h:5432/app" } },
  // `connection` picks the connection on every `$database` op; `$query`, in
  // another node, picks it with `database`.
  { label: "database close by connection (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "close", connection: "main" } },
  { label: "query picks its database (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "select", table: "users", database: "main" } },
  { label: "session login sets values on a new id in one step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $session: { user_id: { $var: "user.id" } }, regenerate: true } },
  // A slot typed by a Node's def takes its data or a step producing it, checked
  // by the step's output type; data is still checked against the def.
  { label: "menu item from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $menu: [{ $var: "fileMenu" }, { label: "Quit", role: "quit" }] } },
  { label: "menu item from a step returning a string (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $menu: [{ $concat: ["File"] }] } },
  { label: "menu item data still checked against the def (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $menu: [{ label: 5 }] } },
  // A `$catch` for the item's `do` names no op, so the item is still data.
  { label: "menu item with its own $catch is data (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $menu: [{ label: "Boom", do: [{ $error: 500 }], $catch: [{ $log: "x" }] }] } },
  { label: "menu item with its own $catch is still checked as an item (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $menu: [{ label: 5, $catch: [{ $log: "x" }] }] } },
  { label: "email list headers from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@x.com", subject: "s", list: { $var: "listHeaders" } } },
  { label: "schema register takes a table document from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $schema: "register", table: { $file: "tables/users.json", data: true } } },
  { label: "database connect via host + its own siblings (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "pg", host: "h", port: 5432, user: "u", db: "app" } },
  { label: "database connect via filename (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "sqlite", filename: "app/data.db" } },
  // `ssl` is a common sibling: HOW to connect, not where, so it rides along with
  // any of the three.
  { label: "database connect url + ssl layers (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", url: "postgres://h/app", ssl: { ca: "certs/root.pem" } } },
  // The gating is what nesting buys: `port` is type-checked only in host's scope.
  { label: "database connect host with non-numeric port (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $database: "connect", host: "h", port: "nope" } },
  { label: "database connect port as an expression under host (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "pg", host: "h", port: { $var: "env.PGPORT" } } },
  { label: "database connect bad type enum (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $database: "connect", type: "oracle", host: "h" } },
  // `ssl` is boolean | string | object, and the enum constrains only the string
  // branch — so the editor rejects exactly what the runtime rejects.
  { label: "database connect ssl true (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "pg", host: "h", ssl: true } },
  { label: "database connect ssl string spelling (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "pg", host: "h", ssl: "require" } },
  { label: "database connect ssl object (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $database: "connect", type: "pg", host: "h", ssl: { rejectUnauthorized: false } } },
  { label: "database connect ssl arbitrary string (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $database: "connect", host: "h", ssl: "banana" } },
  { label: "database connect ssl as a bare PEM string (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $database: "connect", host: "h", ssl: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" } },
  { label: "cache-connect redis tls arbitrary string (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$cache-connect": "redis", host: "h", tls: "banana" } },
  { label: "storage value-mode keys (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $storage: "keys" } },
  { label: "storage value-mode clear + session sibling (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $storage: "clear", session: true } },
  // Sibling/handler-key collision: `session` is both a sibling (StorageNode) and a
  // handler key (SessionNode). Dispatch is gated by primary key.
  { label: "session sibling on storage-get (gated, valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$storage-get": "cart", session: true } },
  { label: "session as its OWN op still validates (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $session: { user_id: 123 } } },
  { label: "storage value-mode invalid op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $storage: "nuke" } },
  { label: "array-slot accepts storage keys (array-output) (PASS)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: { $storage: "keys" } } },
  { label: "array-slot rejects storage clear (boolean-output) (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $concat: { $storage: "clear" } } },

  // ElementNode per-tag attribute variants (value-mode, permissive: custom tags
  // and unknown attrs still pass; known attrs are type/enum-checked).
  { label: "element a with href + target (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "a", href: "/x", target: "_blank", content: ["hi"] } },
  { label: "element input bad type enum (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "input", type: "notatype" } },
  { label: "element custom tag accepted (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "my-widget", foo: "bar", content: [] } },
  { label: "element unknown attr on div accepted (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", "data-x": "1", "hx-get": "/y" } },
  { label: "element if-on-tag is gated, not LogicNode if (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", if: { $var: "show" }, content: ["x"] } },
  // A slot listing several types, `object` among them, checks a data object's
  // values and an array's items, and an object with a `$` key as a step.
  { label: "multi-type slot: style from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", style: { $var: "s" } } },
  { label: "multi-type slot: broken step inside a style object (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "div", style: { color: { $concta: 1 } } } },
  { label: "multi-type slot: broken step inside a class array (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "div", class: ["a", { $concta: 1 }] } },
  { label: "multi-type slot: class map with a step value (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", class: { active: { $var: "on" } } } },
  { label: "multi-type slot: a misspelled op in place of the value (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "div", style: { $concta: 1 } } },

  // A slot with a declared inner shape takes that shape, or a step with an object output.
  { label: "properties slot from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$window-bounds": { $var: "bounds" } } },
  { label: "properties slot from a string-output step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$window-bounds": { $upper: "x" } } },
  { label: "properties slot keeps its shape for a literal (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$window-bounds": { widht: 900 } } },
  { label: "listen sw from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $listen: 3000, client: true, sw: { $var: "swConfig" }, do: [] } },

  { label: "element events from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "button", events: { $var: "handlers" } } },
  { label: "element events from a string-output step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "button", events: { $upper: "click" } } },
  { label: "element events map still checks its handlers (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "button", events: { click: { do: [{ $concta: 1 }] } } } },

  // Map slots (`map: true`). The KEYS are names the node keeps verbatim; a key
  // without `$` is never an op, so one spelled like an op is just a name. Only
  // the VALUES are checked. The slot may also be a step resolving to an object.
  { label: "setVars: variable named `email` (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $setVars: { email: "a@b.c" } } },
  { label: "setVars: variable named `fetch` holding a number (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $setVars: { fetch: 3 } } },
  { label: "fetch: header named `email` (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/x", headers: { email: "a@b.c" } } },
  { label: "runVar: param named `query` (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $runVar: "steps", params: { query: "hi" } } },
  { label: "switch: a case key named `fetch` (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $switch: { $var: "k" }, cases: { fetch: "matched" } } },
  // Values ARE still validated as expressions — this is new coverage, since the old
  // exprFlat routing left map values unchecked (exprFlat.additionalProperties: true).
  { label: "map value is a broken expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/x", headers: { "X-Q": { $fetch: 3 } } } },
  { label: "map slot given a scalar (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/x", headers: "nope" } },
  { label: "map slot given an array (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $setVars: [{ a: 1 }] } },
  { label: "map slot from a $var (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $runVar: "steps", params: { $var: "p" } } },
  { label: "headers from a step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/x", headers: { $var: "h" } } },
  { label: "map slot from a string-output step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $runVar: "steps", params: { $upper: "x" } } },
  { label: "setVars from an object step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $setVars: { $var: "defaults" } } },
  { label: "object slot from a string-output step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $parseGLTF: { $upper: "x" } } },
  { label: "object slot from an object-output step (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $parseGLTF: { $deepMerge: [{ $var: "gltf" }, { buffers: [] }] } } },
  { label: "object slot given a string (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $parseGLTF: "up" } },
  { label: "object slot data with a broken step inside (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $parseGLTF: { json: { $concta: 1 }, buffers: [] } } },

  // Data objects: an object without a `$` key is data, and its values are checked.
  { label: "broken step inside a data object (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $concat: [{ a: { b: { $concta: 1 } } }] } },
  { label: "steps inside nested data (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $stringify: { a: { b: [{ c: { $var: "x" } }] } } } },
  { label: "broken step inside nested data in an undeclared sibling (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $var: "x", extra: { deep: [{ $upper: { $concta: 1 } }] } } },

  // One op per step.
  { label: "two ops in one step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $concat: ["a"], $upper: "x" } },
  { label: "op plus global keys (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: ["a"], $as: "x", $catch: [{ $var: "error.message" }] } },
  { label: "two hyphenated ops in one step (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$storage-get": "a", "$storage-set": ["b", 1] } },

  // `map: true, type: ["object", "array"]`: query `data` is the one slot whose
  // runtime takes a row map OR a list of them.
  { label: "query insert: row with an `email` column (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "users", data: { email: "a@b.c", name: "Bob" } } },
  { label: "query insert: many rows with `email` columns (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "users", data: [{ email: "a@b.c" }, { email: "c@d.e" }] } },
  { label: "query insert: data as a whole expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "users", data: { $var: "row" } } },
  { label: "query insert: rows must be objects, not scalars (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $query: "insert", table: "users", data: ["a", "b"] } },

  // `concat` stringifies whatever it gets, so its items are untyped. Typing them
  // `string` sent expressions to exprFlat_string, which rejects every number-output
  // op — breaking the commonest CSS idiom, `{ $concat: [<number>, "px"] }`.
  { label: "concat with a literal number (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: [1, "px"] } },
  { label: "concat with a number-output expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: [{ $max: [0, { $var: "x" }] }, "px"] } },
  { label: "concat with a string-output expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: [{ $upper: { $var: "name" } }, "!"] } },
  { label: "concat of plain strings (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $concat: ["Hello, ", { $var: "name" }] } },

  // `routes`, and every node inside it, is a literal tree or a step producing one,
  // told apart by a `$` key as the runtime's nodeAt does.
  { label: "routes as a literal tree (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $routes: { children: { users: { methods: { GET: { $file: "pages/users.json" } } } } } } },
  { label: "routes from a var expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $routes: { $var: "routes" } } },
  { label: "routes from a file expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $routes: { $file: "routes.json", data: true } } },
  { label: "routes literal tree with a bad method (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $routes: { methods: { FETCH: { $file: "x.json" } } } } },
  { label: "a route node from a var (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $routes: { children: { admin: { $var: "adminRoutes" } } } } },
  { label: "a route node from an $if (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $routes: { children: { admin: { $if: { $var: "session.admin" }, then: { $var: "adminRoutes" } } } } } },
  { label: "a route node with its own if guard (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $routes: { children: { admin: { if: { $var: "session.admin" }, methods: { GET: { $file: "a.json" } } } } } } },
  { label: "a route node with a misspelled key (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $routes: { children: { users: { method: { GET: { $file: "u.json" } } } } } } },
  // A route file is a step wrapping the tree, so it matches the root via `steps`.
  // `_routeNode` is underscored and therefore NOT a root branch.
  { label: "a route file, tree wrapped in a step (valid)", schemaRef: "", expectValid: true,
    expr: [{ $routes: { children: { email: { methods: { GET: { run: [{ response: "x" }] } } } } } }] },
  { label: "a wrapped tree with a handler-key segment name (valid)", schemaRef: "", expectValid: true,
    expr: { $routes: { children: { email: { methods: { GET: { $file: "x.json" } } } } } } },
  { label: "root no longer masks a broken step (FAIL)", schemaRef: "", expectValid: false,
    expr: { $email: { a: {} }, body: { b: {} } } },

  // `required` siblings. Reported on the step itself, at any nesting depth, and
  // never inside a map (a column/variable named `email` is a name).
  { label: "email without a subject (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $email: "a@b.c", body: "hi" } },
  { label: "email with a subject (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@b.c", subject: "Hi", body: "hi" } },
  { label: "email without a subject, nested in steps (FAIL)", schemaRef: "$defs/steps", expectValid: false,
    expr: [{ $if: { $var: "x" }, then: [{ $email: "a@b.c" }] }] },
  { label: "attachment without content (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $email: "a@b.c", subject: "Hi", attachments: [{ filename: "a.pdf" }] } },
  { label: "attachment without a filename is fine, it defaults (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $email: "a@b.c", subject: "Hi", attachments: [{ content: { $var: "pdf" } }] } },
  // The required marker must not leak into maps or data rows.
  { label: "a variable named `email` needs no subject (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $setVars: { email: "a@b.c" } } },
  { label: "a row with an `email` column needs no subject (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "users", data: [{ email: "a@b.c" }] } },

  // A listener's `sw` settings resolve at listen time; per-event steps go under `events`.
  { label: "sw config with routes and events (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $listen: 3000, client: true, do: [], sw: {
      precache: ["/offline.html"],
      routes: [
        { path: "/jexs/chunks/**", strategy: "cache-first" },
        { path: ["/", "/**"], strategy: "network-first", fallback: "/offline.html" },
      ],
      skipWaiting: true,
      claim: true,
      events: {
        push: [{ "$sw-notify": { $var: "data.title" }, actions: [{ action: "open", title: "Open" }] }],
        notificationclick: { "$sw-open": { $var: "notification.data.url" } },
      },
    } } },
  { label: "sw route with an unknown strategy (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { routes: [{ path: "/**", strategy: "fastest" }] } } },
  { label: "sw route without a strategy (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { routes: [{ path: "/**" }] } } },
  { label: "sw route without a path (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { routes: [{ strategy: "cache-first" }] } } },
  { label: "sw settings from expressions (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $listen: 3000, client: true, do: [], sw: { precache: { $var: "urls" }, routes: { $var: "routes" } } } },
  { label: "sw events from an expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $listen: 3000, client: true, do: [], sw: { events: { $file: "sw-events.json", data: true } } } },
  { label: "sw events from an unknown op (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { events: { $fiel: "sw-events.json" } } } },
  { label: "sw event name misspelled (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { events: { notifcationclick: { "$sw-open": "/" } } } } },
  { label: "sw fetch is not an event (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { events: { fetch: { "$sw-post": 1 } } } } },
  { label: "sw handlers outside events (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { push: { "$sw-notify": "Hi" } } } },
  { label: "sw event steps are checked (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $listen: 3000, client: true, do: [], sw: { events: { push: { "$sw-notify": "Hi", requireInteraction: "yes" } } } } },

  // `steps: true` takes an array of expressions OR a single one, since runSteps
  // normalizes a lone expression into a one-step sequence. Both stay type-checked;
  // an untyped slot would accept anything at all.
  { label: "steps slot: an array of expressions (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tick: "start", id: "game", do: [{ $var: "tick.dt" }, { $var: "tick.count" }] } },
  { label: "steps slot: a single expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tick: "start", id: "game", do: { $var: "tick.dt" } } },
  { label: "steps slot: a scalar is still not an expression (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tick: "start", id: "game", do: 42 } },
  { label: "steps slot: an array of scalars (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tick: "start", id: "game", do: [42] } },
  { label: "steps slot: a malformed expression is caught (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tick: "start", id: "game", do: { $concat: "not-an-array" } } },
  { label: "tick start without do (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tick: "start", id: "game", rate: 60 } },
  { label: "tick stop needs no do (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tick: "stop", id: "game" } },
  // The universal `$catch` is a steps slot too, so it takes either shape, and is
  // held to the same rule: a step is an expression, never a bare value.
  { label: "catch as a single expression (valid)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $fetch: "/api/x", $catch: { $var: "error.message" } } },
  { label: "catch as a scalar (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/x", $catch: "failed" } },
  { label: "catch as an array of scalars (FAIL)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $fetch: "/api/x", $catch: ["failed"] } },

  // A slot typed by a def with a single type takes a step returning that def,
  // its type with no declared shape, or an unknown output. One whose def lists
  // types under `anyOf` takes a step returning any of them.
  { label: "menu item from a var", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $menu: [{ $var: "item" }] } },
  { label: "menu item from an op returning an object of no declared shape", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $menu: [{ $deepMerge: [{ $var: "base" }, { label: "Quit" }] }] } },
  { label: "menu item from an op returning the body of a fetch (any)", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $menu: [{ $fetch: "/menu.json" }] } },
  { label: "query rows from an op returning an array", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $query: "insert", table: "t", data: { $map: { $var: "list" }, do: { $var: "item" } } } },
  { label: "a step may carry an empty key", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $var: "a", "": 1 } },

  // A color slot takes a hex string, a color array (whose numbers may be steps),
  // or a step returning a string, a `_color`, or an array of no declared shape.
  { label: "color as hex", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toHex: "#3366ff" } },
  { label: "color as array with a step inside", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toHex: [{ $var: "r" }, 0.4, 1] } },
  { label: "color from an op returning _color", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toHex: { $lighten: ["#3366ff", 0.2] } } },
  { label: "color from an op returning a string", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toRgb: { $concat: ["#", "fff"] } } },
  { label: "color from a var", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $mix: [{ $var: "a" }, { $toRgb: "#000" }, 0.5] } },
  { label: "color from an array of no declared shape", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $toHex: { $slice: [{ $var: "rgba" }, 0, 3] } } },

  // A vector slot takes `[x, y, z?]` (whose numbers may be steps) or a step
  // returning a `_vec`; an element slot a CSS selector or a step returning an
  // `_element`, as every DOM op that acts on one does. A render color takes a
  // `_color`, as the color ops return one.
  { label: "vector from an op returning _vec", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$v-add": [[1, 2], { "$v-normalize": { $var: "d" } }] } },
  { label: "vector with a step inside", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$v-scale": [[{ $var: "vx" }, 0, 0], 2] } },
  { label: "entity translation from a vector op", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-add": "p", translation: { "$v-add": [[1, 2], [3, 4]] } } },
  { label: "entity-move takes a translation", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-move": "p", translation: [4, 0] } },
  { label: "render color from a color op", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-add": "spark", color: { $toRgb: "#ff8800" } } },
  { label: "render color as rgb without alpha", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$entity-update": "spark", color: [1, 0.5, 0] } },
  { label: "raycast from vectors", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$physics-raycast": true, from: { $var: "p" }, dir: { "$v-direction": [{ $var: "a" }, { $var: "b" }] } } },
  { label: "element from an op returning _element", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $addClass: [{ $closest: [{ $var: "target" }, "li"] }, "open"] } },
  { label: "element ops chain", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $setText: [{ $addClass: ["#status", "busy"] }, "Saving"] } },
  { label: "element as a selector", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $focus: "#name" } },

  // A slot of several types takes a step returning any of them.
  { label: "boolean-or-string slot from a boolean-output step", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", hidden: { $not: { $var: "open" } } } },
  { label: "number-or-string slot from a number-output step", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { $tag: "div", tabindex: { $add: [1, 2] } } },
  { label: "string-or-boolean slot from a var", schemaRef: "$defs/exprFlat", expectValid: true,
    expr: { "$window-close": { $var: "w" } } },

  // A step is validated through exprFlat; its byKey entry checks the siblings
  // only, leaving the primary value to exprFlat (each value checked once).
  { label: "byKey alone leaves the primary value to exprFlat", schemaRef: "byKey/eq", expectValid: true,
    expr: { $eq: [1] } },

  // Should fail
  { label: "menu item from an op returning another object shape (_fetchResponse)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $menu: [{ $fetch: "/menu.json", full: true }] } },
  { label: "query rows from an op returning a number", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $query: "insert", table: "t", data: { $length: "abc" } } },
  { label: "color from an op returning a number", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $toHex: { $length: "abc" } } },
  { label: "color from an op returning another shape (_vec)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $toHex: { "$v-normalize": { $var: "v" } } } },
  { label: "color from an op returning an inline-shaped array", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $luminance: { $split: ["a,b", ","] } } },
  { label: "color tuple slot from an op returning a number", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $contrast: ["#000", { $length: "abc" }] } },
  { label: "color array too short", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $toHex: [1, 2] } },
  { label: "vector from an op returning another object shape (_fetchResponse)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$v-normalize": { $fetch: "/v", full: true } } },
  { label: "vector with one component", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$v-add": [[1], [0, 0]] } },
  { label: "vector as an object", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$v-normalize": { x: 1, y: 0 } } },
  { label: "render color from an op returning a _vec", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$gl-particle": true, color: { "$v-normalize": { $var: "v" } } } },
  { label: "entity translation from an op returning a _color", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-update": "p", translation: { $toRgb: "#ffffff" } } },
  { label: "impulse from an op returning a _color", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$physics-apply": "p", impulse: { $lighten: ["#000000", 0.1] } } },
  { label: "render color as a hex string", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$entity-add": "spark", color: "#ff8800" } },
  { label: "element from an op returning a _vec", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $addClass: [{ "$v-normalize": { $var: "v" } }, "x"] } },
  { label: "element from an op returning a number", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $focus: { $length: "abc" } } },
  { label: "boolean-or-string slot from an array-output step", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "div", hidden: { $keys: { $var: "o" } } } },
  { label: "number-or-string slot from a boolean-output step", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $tag: "div", tabindex: { $eq: [1, 1] } } },
  { label: "string-or-boolean slot from a number-output step", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { "$window-close": { $length: "abc" } } },
  { label: "eq tuple too short", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $eq: [1] } },
  { label: "between tuple too short", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $between: [10, 1] } },
  { label: "as must be string (exprFlat)", schemaRef: "$defs/exprFlat", expectValid: false,
    expr: { $if: { $var: "x" }, $as: 42 } },
];

// Register the full schema so $ref into $defs (for nested expressions) resolves.
ajv.addSchema(schema, "jexs://combined");

let pass = 0, fail = 0;
for (const c of cases) {
  // Validate via $ref into the registered schema, so $defs/anyVal etc. resolve.
  // An empty schemaRef means the document root (`#`, not `#/`, which would point
  // at a property named ""), i.e. what an editor applies to a whole file.
  const validate = ajv.compile({
    $ref: c.schemaRef === "" ? "jexs://combined#" : `jexs://combined#/${c.schemaRef}`,
  });
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
