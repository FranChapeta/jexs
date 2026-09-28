/**
 * Codemod for the `$` prefix: every key the resolver owns (the op a step
 * dispatches on, and the global step keys `as`, `then`, `catch`, `return`,
 * `bubble`) gains a leading `$`, and a literal `var` path loses its now
 * meaningless leading `$`.
 *
 * Which key an object dispatches on is decided exactly as the resolver did
 * before the prefix: the first key, in the object's own order, that is a handler
 * key. Where a value is an expression and where it is data (a map of names, a
 * route tree, an event map) comes from the pre-migration combined schema,
 * snapshotted beside this file, so the codemod keeps working on templates after
 * the source has moved on.
 *
 * Usage: tsx scripts/migrate-dollar/migrate.ts [--dry] <file|dir>...
 *   .json files  migrated as templates (a whole file is one step or a step list)
 *   .ts/.mjs     expression literals, and JSON inside `examples` strings and
 *                backtick code spans in strings
 *   .md          ```json blocks and inline code spans
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown> | boolean | undefined;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(path.join(HERE, "pre-dollar.combined.schema.json"), "utf8")) as {
  $defs: Record<string, Schema>; vp: Record<string, Schema>; byKey: Record<string, Record<string, unknown>>;
};
const HANDLERS = new Set(Object.keys(C.byKey));
const GLOBALS = new Set(["as", "then", "catch", "return", "bubble"]);
const ROOT: Schema = { anyOf: [{ $ref: "#/$defs/steps" }, { $ref: "#/$defs/exprFlat" }] };

// ── Values ──────────────────────────────────────────────────────────────────

interface Edit { start: number; end: number; text: string }
type Val =
  | { k: "obj"; props: Prop[] }
  | { k: "arr"; items: Val[] }
  | { k: "str"; value: string; start: number; end: number; quote: string }
  | { k: "lit"; type: "number" | "boolean" | "null"; value: unknown }
  | { k: "opaque" };
/** `shorthand`: a JS `{ routes }`, whose key is also the variable it reads. */
interface Prop { key: string; keyStart: number; keyEnd: number; keyQuoted: boolean; value: Val; shorthand?: boolean }

// ── Tolerant parser: JSON, and the JSON-like subset of JS object literals ───

class Parser {
  i: number;
  /** Spans skipped as opaque JS (calls, identifiers, ...); literals inside them are roots of their own. */
  opaques: Array<[number, number]> = [];
  constructor(readonly s: string, start = 0, readonly js = false) { this.i = start; }
  ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
      if (this.js && this.s.startsWith("//", this.i)) { const n = this.s.indexOf("\n", this.i); this.i = n < 0 ? this.s.length : n; continue; }
      if (this.js && this.s.startsWith("/*", this.i)) { const n = this.s.indexOf("*/", this.i); this.i = n < 0 ? this.s.length : n + 2; continue; }
      return;
    }
  }
  fail(): never { throw new Error(`parse error at ${this.i}`); }
  string(): { value: string; start: number; end: number; quote: string } {
    const q = this.s[this.i];
    const start = this.i;
    let j = this.i + 1, value = "";
    while (j < this.s.length && this.s[j] !== q) {
      if (this.s[j] === "\\") {
        const c = this.s[j + 1];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\", "/": "/", '"': '"', "'": "'", "`": "`" };
        if (c === "u") { value += String.fromCharCode(parseInt(this.s.slice(j + 2, j + 6), 16)); j += 6; continue; }
        value += map[c] ?? c; j += 2; continue;
      }
      if (q === "`" && this.s.startsWith("${", j)) this.fail();
      value += this.s[j++];
    }
    if (j >= this.s.length) this.fail();
    this.i = j + 1;
    return { value, start, end: this.i, quote: q };
  }
  /** A JS value we do not model (identifier, call, arrow, ...): skip to the next `,` or closer at depth 0. */
  opaque(): Val {
    let depth = 0;
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"' || c === "'" || c === "`") { try { this.string(); } catch { this.i++; } continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
      this.i++;
    }
    if (this.i === start) this.fail();
    this.opaques.push([start, this.i]);
    return { k: "opaque" };
  }
  value(): Val {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || (this.js && (c === "'" || c === "`"))) {
      if (c === "`" && this.s.slice(this.i).match(/^`[^`]*\$\{/)) return this.opaque();
      const t = this.string(); return { k: "str", ...t };
    }
    if (this.s.startsWith("...", this.i)) { this.i += 3; if (this.js) { this.ws(); if (this.s[this.i] !== "," && this.s[this.i] !== "]" && this.s[this.i] !== "}") this.opaque(); } return { k: "opaque" }; }
    const m = /^-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return { k: "lit", type: "number", value: Number(m[0]) }; }
    for (const [w, v, t] of [["true", true, "boolean"], ["false", false, "boolean"], ["null", null, "null"]] as const) {
      if (this.s.startsWith(w, this.i) && !/[\w$]/.test(this.s[this.i + w.length] ?? "")) { this.i += w.length; return { k: "lit", type: t, value: v }; }
    }
    if (/[A-Za-z_$<]/.test(c ?? "")) return this.opaque();
    if (this.js) return this.opaque();
    this.fail();
  }
  object(): Val {
    this.i++;
    const props: Prop[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") { this.i++; return { k: "obj", props }; }
      if (this.s.startsWith("...", this.i)) {
        // `{...}`, a placeholder in docs, or a JS spread `...x`.
        this.i += 3; this.ws();
        if (this.s[this.i] !== "," && this.s[this.i] !== "}") this.value();
      }
      else {
        let key: string, keyStart: number, keyEnd: number, keyQuoted: boolean;
        const c = this.s[this.i];
        if (c === '"' || (this.js && c === "'")) {
          const t = this.string(); key = t.value; keyStart = t.start + 1; keyEnd = t.end - 1; keyQuoted = true;
        } else {
          const m = (this.js ? /^[A-Za-z_$][\w$]*/ : /^[A-Za-z_$][\w$-]*/).exec(this.s.slice(this.i));
          if (!m) this.fail();
          key = m[0]; keyStart = this.i; keyEnd = this.i + key.length; keyQuoted = false; this.i = keyEnd;
        }
        this.ws();
        let value: Val;
        let shorthand = false;
        if (this.s[this.i] === ":") { this.i++; value = this.value(); }
        else if (this.js) { value = { k: "opaque" }; shorthand = !keyQuoted; } // shorthand property or method
        else this.fail();
        props.push({ key, keyStart, keyEnd, keyQuoted, value, shorthand });
      }
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "}") { this.i++; return { k: "obj", props }; }
      if (this.js) { this.opaque(); this.ws(); if (this.s[this.i] === ",") { this.i++; continue; } if (this.s[this.i] === "}") { this.i++; return { k: "obj", props }; } }
      this.fail();
    }
  }
  array(): Val {
    this.i++;
    const items: Val[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") { this.i++; return { k: "arr", items }; }
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "]") { this.i++; return { k: "arr", items }; }
      if (this.js) { this.opaque(); this.ws(); if (this.s[this.i] === ",") { this.i++; continue; } if (this.s[this.i] === "]") { this.i++; return { k: "arr", items }; } }
      this.fail();
    }
  }
}

// ── Schema-guided walk ──────────────────────────────────────────────────────

function deref(ref: string): Schema {
  const [, area, name] = /^#\/(\$defs|vp|byKey)\/(.+)$/.exec(ref) ?? [];
  if (area === "$defs") return C.$defs[name];
  if (area === "vp") return C.vp[name];
  if (area === "byKey") return C.byKey[name];
  return undefined;
}
const isExprRef = (ref: string) => /^#\/\$defs\/exprFlat(_\w+)?$/.test(ref);

function kindOf(v: Val): string | undefined {
  if (v.k === "obj") return "object";
  if (v.k === "arr") return "array";
  if (v.k === "str") return "string";
  if (v.k === "lit") return v.type;
  return undefined;
}

/** true / false / undefined (unknown) for the `if` of an if/then/else. */
function test(schema: Schema, v: Val): boolean | undefined {
  if (!schema || typeof schema !== "object") return schema === true ? true : undefined;
  let result: boolean | undefined = true;
  const and = (r: boolean | undefined) => { if (r === false) result = false; else if (r === undefined && result !== false) result = undefined; };
  if ("type" in schema) {
    const k = kindOf(v);
    const types = ([] as unknown[]).concat(schema.type);
    and(k === undefined ? undefined : types.includes(k) || (k === "number" && types.includes("integer")));
  }
  if (Array.isArray(schema.required)) {
    and(v.k === "obj" ? (schema.required as string[]).every(r => v.props.some(p => p.key === r)) : v.k === "opaque" ? undefined : false);
  }
  if (schema.not) { const r = test(schema.not as Schema, v); and(r === undefined ? undefined : !r); }
  return result;
}

const edits = new Map<number, Edit>();
const add = (e: Edit) => { edits.set(e.start, e); };
// A shorthand keeps reading its variable: `{ routes }` becomes `{ $routes: routes }`.
const renameKey = (p: Prop) => add({ start: p.keyStart, end: p.keyEnd, text: p.shorthand ? `$${p.key}: ${p.key}` : "$" + p.key });

let depth = 0;
function walk(schema: Schema, v: Val): void {
  if (!schema || typeof schema !== "object" || v.k === "opaque" || v.k === "lit" || v.k === "str") return;
  if (++depth > 200) { depth--; return; }
  try {
    if (typeof schema.$ref === "string") {
      if (isExprRef(schema.$ref)) return walkExpr(v);
      // A route leaf is resolved as a FileNode step, so its `file` is an op key;
      // `run` is the router's step list, and `queryParams`/`body` hold JSON Schema,
      // whose keywords (`not`, `if`) must not be read as ops.
      if (schema.$ref === "#/$defs/_routeHandler" && v.k === "obj") {
        for (const p of v.props) {
          if (p.key === "file") { renameKey(p); walk({ $ref: "#/$defs/strOrExpr" }, p.value); }
          else if (p.key === "run") walk(STEPS, p.value);
        }
        return;
      }
      walk(deref(schema.$ref), v);
    }
    if (schema.if) {
      const r = test(schema.if as Schema, v);
      if (r !== false) walk(schema.then as Schema, v);
      if (r !== true) walk(schema.else as Schema, v);
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      for (const b of (schema[key] as Schema[] | undefined) ?? []) walk(b, v);
    }
    if (v.k === "obj") {
      const props = schema.properties as Record<string, Schema> | undefined;
      const patterns = schema.patternProperties as Record<string, Schema> | undefined;
      const extra = schema.additionalProperties;
      if (props || patterns || typeof extra === "object") {
        for (const p of v.props) {
          const byPattern = patterns && Object.entries(patterns).find(([re]) => new RegExp(re).test(p.key))?.[1];
          walk(props?.[p.key] ?? byPattern ?? (typeof extra === "object" ? extra as Schema : undefined), p.value);
        }
      }
    }
    if (v.k === "arr") {
      const prefix = schema.prefixItems as Schema[] | undefined;
      v.items.forEach((it, i) => walk(prefix?.[i] ?? (schema.items as Schema), it));
    }
    // A schema that says nothing about what is inside (`{}`, `{ type: "array" }`)
    // leaves it to the op, and ops resolve their arguments: walk them as values.
    const guides = ["$ref", "if", "allOf", "anyOf", "oneOf", "properties", "patternProperties", "additionalProperties", "items", "prefixItems"];
    if (!guides.some(g => g in schema)) walk(ANY, v);
    // An object where only an array is described (a tuple slot given a single
    // expression, which the op resolves): walk it as a value.
    else if (v.k === "obj" && !("properties" in schema) && !("additionalProperties" in schema) && ("items" in schema || "prefixItems" in schema)) walk(ANY, v);
  } finally { depth--; }
}

const ANY: Schema = { $ref: "#/$defs/anyVal" };
const STEPS: Schema = { $ref: "#/$defs/steps" };

/** The schema of `key` as a sibling of op `op`, as the pre-migration byKey had it. */
function siblingSchema(op: string, key: string): Schema {
  const m = C.byKey[op];
  const props = m.properties as Record<string, Record<string, unknown>> | undefined;
  let s: Schema = props?.[key];
  const isStub = (x: Schema) => !x || (typeof x === "object" && Object.keys(x).every(k => k === "description" || k === "markdownDescription"));
  if (isStub(s)) {
    for (const branch of (m.allOf as Array<Record<string, unknown>> | undefined) ?? []) {
      const then = branch.then as Record<string, unknown> | undefined;
      const t = (then?.properties as Record<string, Schema> | undefined)?.[key];
      if (t && !isStub(t)) { s = t; break; }
    }
  }
  if (isStub(s) && typeof m.$ref === "string") s = ((deref(m.$ref) as Record<string, unknown>)?.properties as Record<string, Schema> | undefined)?.[key] ?? s;
  if (isStub(s)) s = (m.additionalProperties as Schema) ?? ANY;
  return s;
}

/** Objects that dispatch on a key other than their first: data that happens to hold an op name, or a real step written out of order. Reported for review. */
const suspicious: Array<{ first: string; op: string; at: number }> = [];

/**
 * A context path (a `var` or a tree op's value) no longer takes a leading `$`,
 * and nothing strips one any more. Covers a literal path and one built with
 * `concat` whose first piece carries the `$` (`["$byKey.", { "$var": "op" }]`).
 */
function stripPathDollar(v: Val): void {
  if (v.k === "str") {
    if (!v.value.startsWith("$")) return;
    const q = v.quote;
    const body = JSON.stringify(v.value.slice(1)).slice(1, -1);
    add({ start: v.start, end: v.end, text: q === '"' ? `"${body}"` : `${q}${body.replace(new RegExp(q, "g"), "\\" + q)}${q}` });
    return;
  }
  if (v.k !== "obj") return;
  const concat = v.props.find(p => p.key === "concat" || p.key === "$concat");
  if (concat?.value.k === "arr" && concat.value.items[0]) stripPathDollar(concat.value.items[0]);
}

function walkExpr(v: Val): void {
  if (v.k === "arr") { for (const it of v.items) walk(ANY, it); return; }
  if (v.k !== "obj") return;
  // Already migrated (a `$op` key, or only `$` globals): walk it the same way, renaming nothing.
  const migratedOp = v.props.find(p => p.key.startsWith("$") && HANDLERS.has(p.key.slice(1)))?.key.slice(1);
  const migrated = migratedOp !== undefined || v.props.some(p => p.key.startsWith("$") && GLOBALS.has(p.key.slice(1)));
  const bare = (p: Prop) => (migrated && p.key.startsWith("$") ? p.key.slice(1) : p.key);
  const op = migrated ? migratedOp : v.props.find(p => HANDLERS.has(p.key))?.key;
  const first = v.props.find(p => !GLOBALS.has(bare(p)));
  if (!migrated && op && first && first.key !== op) suspicious.push({ first: first.key, op, at: first.keyStart });
  const rawValues = op === "setVars" && v.props.some(p => p.key === "raw" && p.value.k === "lit" && p.value.value === true);
  for (const p of v.props) {
    const key = bare(p);
    const global = migrated ? p.key.startsWith("$") && GLOBALS.has(key) : GLOBALS.has(key) && !(key === "then" && op === "if");
    if (global) {
      if (!migrated) renameKey(p);
      if (key === "then" || key === "catch") walk(STEPS, p.value);
      else if (key === "return" || key === "bubble") walk(ANY, p.value);
      continue;
    }
    if (op === undefined) { walk(ANY, p.value); continue; }
    if (key === op && (!migrated || p.key.startsWith("$"))) {
      if (!migrated) renameKey(p);
      if (op === "var" || op.startsWith("tree-")) stripPathDollar(p.value);
      if (!rawValues) walk(C.vp[op] ?? siblingSchema(op, op), p.value);
      continue;
    }
    walk(siblingSchema(op, p.key), p.value);
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

function applyEdits(text: string, list: Edit[]): string {
  let out = text;
  for (const e of [...list].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function takeEdits(): Edit[] { const l = [...edits.values()]; edits.clear(); return l; }

/** Migrate every JSON value in `text` (a sequence of values; stray text between them is skipped). */
function migrateJsonText(text: string): string {
  const p = new Parser(text);
  let any = false;
  while (p.i < text.length) {
    p.ws();
    if (p.i >= text.length) break;
    const c = text[p.i];
    if (c !== "{" && c !== "[") { p.i++; continue; }
    const save = p.i;
    try { walk(ROOT, p.value()); any = true; } catch { p.i = save + 1; }
  }
  return any ? applyEdits(text, takeEdits()) : text;
}

/** Backtick code spans (and ```json blocks) whose content is JSON. */
function migrateCodeSpans(text: string): string {
  return text
    .replace(/```json(\r?\n)([\s\S]*?)```/g, (_m, nl: string, body: string) => "```json" + nl + migrateJsonText(body) + "```")
    .replace(/(?<!`)`([^`\n]+)`(?!`)/g, (m, body: string) => (/^\s*[{[]/.test(body) ? "`" + migrateJsonText(body) + "`" : m));
}

function quoteLike(original: string, value: string): string {
  const q = original[0];
  if (q === "`") return "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
  if (q === "'") return "'" + JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
  return JSON.stringify(value);
}

const SCHEMA_WORDS = new Set(["schema", "commonSiblings", "schemaDefs", "siblings", "variants", "properties", "prefixItems", "items", "additionalProperties"]);
/** Calls whose arguments are not steps: assertions (expected values are results,
 *  i.e. data) and schema builders (their arguments are node schemas). */
const DATA_CALLS = /(^|\.)(assert\w*|deepEqual|equal|strictEqual|notEqual|match|doesNotMatch|throws|rejects|ok|build\w*Schema\w*|mergePackageSchemas|build)$/;

/** The callee of the call whose argument list encloses `at`, e.g. `assert.deepEqual`. */
function enclosingCall(text: string, at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) { depth--; continue; }
      if (c !== "(") return null;
      const m = /([\w$.]+)\s*$/.exec(text.slice(Math.max(0, i - 80), i));
      return m ? m[1] : null;
    } else if (c === ";" && depth === 0) return null;
  }
  return null;
}
const LITERAL_START = /(?:[([,:=?]|&&|\|\||\?\?|=>\s*\(|\breturn|\bexpr)\s*$/;

function migrateSource(text: string, { literals }: { literals: boolean }): string {
  const out: Edit[] = [];
  // 1. Strings: one that is JSON (an `examples` entry) is migrated whole; any other
  //    string gets the JSON in its backtick code spans migrated.
  const strRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (const m of text.matchAll(strRe)) {
    if (m[0].startsWith("`") && m[0].includes("${")) continue;
    const start = m.index!;
    let value: string;
    try { value = new Parser(m[0], 0, true).string().value; } catch { continue; }
    if (!/[{[`]/.test(value)) continue;
    const next = /^\s*[{[]/.test(value) ? migrateJsonText(value) : migrateCodeSpans(value);
    if (next !== value) out.push({ start, end: start + m[0].length, text: quoteLike(m[0], next) });
  }
  // 2. Expression literals in code. A literal is migrated as a whole; the scan then
  //    resumes after it, looking only inside its opaque parts (calls, identifiers)
  //    for literals of their own, so a map inside a step is never read as a step.
  const scan = (from: number, to: number): void => {
    let i = from;
    while (i < to) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") { const m = /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(text.slice(i)); i += m ? m[0].length : 1; continue; }
      if (text.startsWith("//", i)) { const n = text.indexOf("\n", i); i = n < 0 ? to : n; continue; }
      if (text.startsWith("/*", i)) { const n = text.indexOf("*/", i); i = n < 0 ? to : n + 2; continue; }
      if ((c === "{" || c === "[") && LITERAL_START.test(text.slice(Math.max(0, i - 40), i))) {
        const before = text.slice(Math.max(0, i - 120), i);
        const owner = /(\w+)\s*(?::\s*[\w<>[\], |]+)?\s*[:=]\s*$/.exec(before)?.[1];
        const schemaTyped = /Jexs\w*Schema[\w<>[\]]*\s*=\s*$/.test(before);
        const p = new Parser(text, i, true);
        let v: Val | null = null;
        try { v = p.value(); } catch { takeEdits(); }
        if (v) {
          const callee = enclosingCall(text, i);
          if (!(owner && SCHEMA_WORDS.has(owner)) && !schemaTyped && !(callee && DATA_CALLS.test(callee))) walk(ROOT, v);
          out.push(...takeEdits());
          for (const [s, e] of p.opaques) scan(s, e);
          i = p.i;
          continue;
        }
      }
      i++;
    }
  };
  if (literals) scan(0, text.length);
  // 3. Comments: examples written as JSON (quoted keys) in `//` and `/* */`
  //    comments. Found by a scan that skips string literals, so `"/assets/*"` does
  //    not open a comment.
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const m = /^("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(text.slice(i));
      if (m) i += m[0].length - 1;
      continue;
    }
    if (c !== "/" || (text[i + 1] !== "/" && text[i + 1] !== "*")) continue;
    const end = text[i + 1] === "/" ? (text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i)) : (text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2);
    const comment = text.slice(i, end);
    const next = migrateJsonText(comment);
    if (next !== comment) out.push({ start: i, end, text: next });
    i = end - 1;
  }
  // Nested roots can re-emit edits their enclosing root already made; keep one per position.
  const unique = new Map<number, Edit>();
  for (const e of out) {
    const clash = [...unique.values()].find(x => e.start < x.end && x.start < e.end && !(x.start === e.start && x.end === e.end));
    if (clash) {
      // A string replacement contains key renames found again by the literal pass; the string one wins.
      if (e.end - e.start > clash.end - clash.start) { unique.delete(clash.start); unique.set(e.start, e); }
      continue;
    }
    unique.set(e.start, e);
  }
  return applyEdits(text, [...unique.values()]);
}

// ── Driver ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dry = args.includes("--dry");
// --literals: also migrate expression literals in source that is not a test (steps a module builds in code).
const forceLiterals = args.includes("--literals");
const files: string[] = [];
const collect = (p: string) => {
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) if (!/^(node_modules|dist|\.git|\.jexs)$/.test(e)) collect(path.join(p, e));
  } else if (/\.(json|ts|mjs|md)$/.test(p) && !/package(-lock)?\.json$|tsconfig|\.schema\.json$|\.d\.ts$/.test(p)) files.push(p);
};
for (const a of args.filter(a => !a.startsWith("--"))) collect(a);

let changed = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  let next: string;
  if (f.endsWith(".json")) next = migrateJsonText(text);
  else if (f.endsWith(".md")) next = migrateCodeSpans(text);
  else next = migrateSource(text, { literals: forceLiterals || /[\\/](test|scripts)[\\/]|\.test\.|test-driver/.test(f) });
  if (next !== text) {
    changed++;
    console.log((dry ? "would change " : "changed ") + f);
    if (!dry) writeFileSync(f, next);
  }
  for (const s of [...new Map(suspicious.splice(0).map(x => [x.at, x])).values()]) {
    console.log(`  review ${f}: dispatches on "${s.op}" though "${s.first}" comes first (data holding an op name, or a step written out of order)`);
  }
}
console.log(`${changed} of ${files.length} files ${dry ? "would change" : "changed"}.`);
