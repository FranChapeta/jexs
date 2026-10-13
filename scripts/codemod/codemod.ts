/**
 * The machinery Jexs template codemods share: a tolerant parser for JSON and the
 * JSON-like subset of JS object literals, a walk guided by a combined schema
 * (which tells an expression from data: a map of names, a route tree, an event
 * map), and a driver that applies the edits to .json templates, to expression
 * literals and examples in .ts/.mjs sources, and to JSON code in .md files.
 *
 * A codemod supplies the schema snapshot it was written against and an `expr`
 * hook that rewrites one expression, and calls `run`.
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

export type Schema = Record<string, unknown> | boolean | undefined;

export interface CombinedSchema {
  $defs: Record<string, Schema>;
  vp: Record<string, Schema>;
  byKey: Record<string, Record<string, unknown>>;
}

// ── Values ──────────────────────────────────────────────────────────────────

export interface Edit { start: number; end: number; text: string }
/** A parsed value, with the span of source text it was read from. */
export type Val = { start: number; end: number } & (
  | { k: "obj"; props: Prop[] }
  | { k: "arr"; items: Val[] }
  | { k: "str"; value: string; quote: string }
  | { k: "lit"; type: "number" | "boolean" | "null"; value: unknown }
  | { k: "opaque" }
);
/** `shorthand`: a JS `{ routes }`, whose key is also the variable it reads. */
export interface Prop { key: string; keyStart: number; keyEnd: number; keyQuoted: boolean; value: Val; shorthand?: boolean }

// ── Tolerant parser: JSON, and the JSON-like subset of JS object literals ───

export class Parser {
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
    return { k: "opaque", start, end: this.i };
  }
  value(): Val {
    this.ws();
    const c = this.s[this.i];
    const start = this.i;
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || (this.js && (c === "'" || c === "`"))) {
      if (c === "`" && this.s.slice(this.i).match(/^`[^`]*\$\{/)) return this.opaque();
      const t = this.string(); return { k: "str", ...t };
    }
    if (this.s.startsWith("...", this.i)) { this.i += 3; if (this.js) { this.ws(); if (this.s[this.i] !== "," && this.s[this.i] !== "]" && this.s[this.i] !== "}") this.opaque(); } return { k: "opaque", start, end: this.i }; }
    const m = /^-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return { k: "lit", type: "number", value: Number(m[0]), start, end: this.i }; }
    for (const [w, v, t] of [["true", true, "boolean"], ["false", false, "boolean"], ["null", null, "null"]] as const) {
      if (this.s.startsWith(w, this.i) && !/[\w$]/.test(this.s[this.i + w.length] ?? "")) { this.i += w.length; return { k: "lit", type: t, value: v, start, end: this.i }; }
    }
    if (/[A-Za-z_$<]/.test(c ?? "")) return this.opaque();
    if (this.js) return this.opaque();
    this.fail();
  }
  object(): Val {
    const start = this.i;
    this.i++;
    const props: Prop[] = [];
    const done = (): Val => { this.i++; return { k: "obj", props, start, end: this.i }; };
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") return done();
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
        else if (this.js) { value = { k: "opaque", start: keyStart, end: keyEnd }; shorthand = !keyQuoted; } // shorthand property or method
        else this.fail();
        props.push({ key, keyStart, keyEnd, keyQuoted, value, shorthand });
      }
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "}") return done();
      if (this.js) { this.opaque(); this.ws(); if (this.s[this.i] === ",") { this.i++; continue; } if (this.s[this.i] === "}") return done(); }
      this.fail();
    }
  }
  array(): Val {
    const start = this.i;
    this.i++;
    const items: Val[] = [];
    const done = (): Val => { this.i++; return { k: "arr", items, start, end: this.i }; };
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") return done();
      items.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") { this.i++; continue; }
      if (this.s[this.i] === "]") return done();
      if (this.js) { this.opaque(); this.ws(); if (this.s[this.i] === ",") { this.i++; continue; } if (this.s[this.i] === "]") return done(); }
      this.fail();
    }
  }
}

// ── Schema-guided walk ──────────────────────────────────────────────────────

export const ANY: Schema = { $ref: "#/$defs/anyVal" };
export const STEPS: Schema = { $ref: "#/$defs/steps" };
const ROOT: Schema = { anyOf: [STEPS, { $ref: "#/$defs/exprFlat" }] };
const isExprRef = (ref: string) => /^#\/\$defs\/exprFlat(_\w+)?$/.test(ref);

function kindOf(v: Val): string | undefined {
  if (v.k === "obj") return "object";
  if (v.k === "arr") return "array";
  if (v.k === "str") return "string";
  if (v.k === "lit") return v.type;
  return undefined;
}

/** true / false / undefined (unknown) for the `if` of an if/then/else; `deref` follows a `$ref`. */
function test(schema: Schema, v: Val, deref: (ref: string) => Schema): boolean | undefined {
  if (!schema || typeof schema !== "object") return schema === true ? true : undefined;
  if (typeof schema.$ref === "string") return test(deref(schema.$ref), v, deref);
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
  // `pattern` constrains strings only; anything else passes.
  if (typeof schema.pattern === "string") {
    and(v.k === "str" ? new RegExp(schema.pattern).test(v.value) : v.k === "opaque" ? undefined : true);
  }
  // `propertyNames` tests each key as a string: how a schema tells data (no `$`
  // key) from a step.
  if (schema.propertyNames !== undefined) {
    if (v.k === "opaque") and(undefined);
    else if (v.k === "obj") {
      for (const p of v.props) and(test(schema.propertyNames as Schema, { k: "str", value: p.key, start: p.keyStart, end: p.keyEnd, quote: '"' }, deref));
    }
  }
  if (schema.not) { const r = test(schema.not as Schema, v, deref); and(r === undefined ? undefined : !r); }
  return result;
}

export interface CodemodHooks {
  /** Rewrite one expression: an object or array where the schema allows a step. */
  expr(v: Val): void;
  /** Handle a value under a `$ref` yourself; return true when it is handled. */
  ref?(ref: string, v: Val): boolean;
}

export interface Codemod {
  readonly schema: CombinedSchema;
  walk(schema: Schema, v: Val): void;
  /** The schema of `key` as a sibling of op `op`, as the snapshot has it. */
  siblingSchema(op: string, key: string): Schema;
  add(edit: Edit): void;
  /** Report a spot the codemod cannot rewrite on its own. */
  review(at: number, message: string): void;
  /** The source text of a span of the value being walked, e.g. a slot to move. */
  text(start: number, end: number): string;
}

const edits = new Map<number, Edit>();
/** The text the value being walked was parsed from; edit and value positions index into it. */
let source = "";
const reviews: Array<{ at: number; message: string }> = [];
function takeEdits(): Edit[] { const l = [...edits.values()]; edits.clear(); return l; }

export function createCodemod(schema: CombinedSchema, hooks: CodemodHooks): Codemod {
  const deref = (ref: string): Schema => {
    const [, area, name] = /^#\/(\$defs|vp|byKey)\/(.+)$/.exec(ref) ?? [];
    if (area === "$defs") return schema.$defs[name];
    if (area === "vp") return schema.vp[name];
    if (area === "byKey") return schema.byKey[name];
    return undefined;
  };

  let depth = 0;
  const walk = (s: Schema, v: Val): void => {
    if (!s || typeof s !== "object" || v.k === "opaque" || v.k === "lit" || v.k === "str") return;
    if (++depth > 200) { depth--; return; }
    try {
      if (typeof s.$ref === "string") {
        if (isExprRef(s.$ref)) return hooks.expr(v);
        if (hooks.ref?.(s.$ref, v)) return;
        walk(deref(s.$ref), v);
      }
      if (s.if) {
        const r = test(s.if as Schema, v, deref);
        if (r !== false) walk(s.then as Schema, v);
        if (r !== true) walk(s.else as Schema, v);
      }
      for (const key of ["allOf", "anyOf", "oneOf"]) {
        for (const b of (s[key] as Schema[] | undefined) ?? []) walk(b, v);
      }
      if (v.k === "obj") {
        const props = s.properties as Record<string, Schema> | undefined;
        const patterns = s.patternProperties as Record<string, Schema> | undefined;
        const extra = s.additionalProperties;
        if (props || patterns || typeof extra === "object") {
          for (const p of v.props) {
            const byPattern = patterns && Object.entries(patterns).find(([re]) => new RegExp(re).test(p.key))?.[1];
            walk(props?.[p.key] ?? byPattern ?? (typeof extra === "object" ? extra as Schema : undefined), p.value);
          }
        }
      }
      if (v.k === "arr") {
        const prefix = s.prefixItems as Schema[] | undefined;
        v.items.forEach((it, i) => walk(prefix?.[i] ?? (s.items as Schema), it));
      }
      // A schema that says nothing about what is inside (`{}`, `{ type: "array" }`)
      // leaves it to the op, and ops resolve their arguments: walk them as values.
      const guides = ["$ref", "if", "allOf", "anyOf", "oneOf", "properties", "patternProperties", "additionalProperties", "items", "prefixItems"];
      if (!guides.some(g => g in s)) walk(ANY, v);
      // An object where only an array is described (a tuple slot given a single
      // expression, which the op resolves): walk it as a value.
      else if (v.k === "obj" && !("properties" in s) && !("additionalProperties" in s) && ("items" in s || "prefixItems" in s)) walk(ANY, v);
    } finally { depth--; }
  };

  const siblingSchema = (op: string, key: string): Schema => {
    const m = schema.byKey[op];
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
  };

  return {
    schema,
    walk,
    siblingSchema,
    add: (e) => { edits.set(e.start, e); },
    review: (at, message) => { reviews.push({ at, message }); },
    text: (start, end) => source.slice(start, end),
  };
}

// ── Adapters ────────────────────────────────────────────────────────────────

function applyEdits(text: string, list: Edit[]): string {
  let out = text;
  for (const e of [...list].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * Migrate every JSON value in `text` (a sequence of values; stray text between
 * them is skipped). `base` is where `text` starts in its file, so a review found
 * in it reports the file's line.
 */
function migrateJsonText(m: Codemod, text: string, base = 0): string {
  const p = new Parser(text);
  const firstReview = reviews.length;
  let any = false;
  while (p.i < text.length) {
    p.ws();
    if (p.i >= text.length) break;
    const c = text[p.i];
    if (c !== "{" && c !== "[") { p.i++; continue; }
    const save = p.i;
    source = text;
    try { m.walk(ROOT, p.value()); any = true; } catch { p.i = save + 1; }
  }
  for (let i = firstReview; i < reviews.length; i++) reviews[i].at += base;
  return any ? applyEdits(text, takeEdits()) : text;
}

/** Backtick code spans (and ```json blocks) whose content is JSON; `base` as for `migrateJsonText`. */
function migrateCodeSpans(m: Codemod, text: string, base = 0): string {
  return text
    .replace(/```json(\r?\n)([\s\S]*?)```/g, (_m, nl: string, body: string, at: number) =>
      "```json" + nl + migrateJsonText(m, body, base + at + "```json".length + nl.length) + "```")
    .replace(/(?<!`)`([^`\n]+)`(?!`)/g, (s, body: string, at: number) =>
      (/^\s*[{[]/.test(body) ? "`" + migrateJsonText(m, body, base + at + 1) + "`" : s));
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

function migrateSource(m: Codemod, text: string, { literals }: { literals: boolean }): string {
  const out: Edit[] = [];
  // 1. Strings: one that is JSON (an `examples` entry) is migrated whole; any other
  //    string gets the JSON in its backtick code spans migrated.
  const strRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (const s of text.matchAll(strRe)) {
    if (s[0].startsWith("`") && s[0].includes("${")) continue;
    const start = s.index!;
    let value: string;
    try { value = new Parser(s[0], 0, true).string().value; } catch { continue; }
    if (!/[{[`]/.test(value)) continue;
    const next = /^\s*[{[]/.test(value) ? migrateJsonText(m, value, start + 1) : migrateCodeSpans(m, value, start + 1);
    if (next !== value) out.push({ start, end: start + s[0].length, text: quoteLike(s[0], next) });
  }
  // 2. Expression literals in code. A literal is migrated as a whole; the scan then
  //    resumes after it, looking only inside its opaque parts (calls, identifiers)
  //    for literals of their own, so a map inside a step is never read as a step.
  const scan = (from: number, to: number): void => {
    let i = from;
    while (i < to) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") { const q = /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(text.slice(i)); i += q ? q[0].length : 1; continue; }
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
          source = text;
          if (!(owner && SCHEMA_WORDS.has(owner)) && !schemaTyped && !(callee && DATA_CALLS.test(callee))) m.walk(ROOT, v);
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
      const q = /^("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(text.slice(i));
      if (q) i += q[0].length - 1;
      continue;
    }
    if (c !== "/" || (text[i + 1] !== "/" && text[i + 1] !== "*")) continue;
    const end = text[i + 1] === "/" ? (text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i)) : (text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2);
    const comment = text.slice(i, end);
    const next = migrateJsonText(m, comment, i);
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

/**
 * Migrate the files and directories named on the command line, printing what
 * changed and what needs review.
 *
 *   --dry       report without writing
 *   --literals  also migrate expression literals in source that is not a test
 *               (steps a module builds in code)
 */
export function run(m: Codemod, args: string[] = process.argv.slice(2)): void {
  const dry = args.includes("--dry");
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
    if (f.endsWith(".json")) next = migrateJsonText(m, text);
    else if (f.endsWith(".md")) next = migrateCodeSpans(m, text);
    else next = migrateSource(m, text, { literals: forceLiterals || /[\\/](test|scripts)[\\/]|\.test\.|test-driver/.test(f) });
    if (next !== text) {
      changed++;
      console.log((dry ? "would change " : "changed ") + f);
      if (!dry) writeFileSync(f, next);
    }
    for (const r of [...new Map(reviews.splice(0).map(x => [x.at, x])).values()]) {
      console.log(`  review ${f}:${text.slice(0, r.at).split("\n").length}: ${r.message}`);
    }
  }
  console.log(`${changed} of ${files.length} files ${dry ? "would change" : "changed"}.`);
}
