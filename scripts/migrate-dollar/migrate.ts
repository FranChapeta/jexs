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
 * Usage: tsx scripts/migrate-dollar/migrate.ts [--dry] [--literals] <file|dir>...
 *   .json files  migrated as templates (a whole file is one step or a step list)
 *   .ts/.mjs     expression literals, and JSON inside `examples` strings and
 *                backtick code spans in strings
 *   .md          ```json blocks and inline code spans
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANY, STEPS, createCodemod, run, type CombinedSchema, type Prop, type Val } from "../codemod/codemod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(path.join(HERE, "pre-dollar.combined.schema.json"), "utf8")) as CombinedSchema;
const HANDLERS = new Set(Object.keys(C.byKey));
const GLOBALS = new Set(["as", "then", "catch", "return", "bubble"]);
const ROUTE_NODE_KEYS = new Set(Object.keys((C.$defs._routeNode as { properties?: object }).properties ?? {}));

const m = createCodemod(C, { expr: walkExpr, ref: walkRoute });

// A shorthand keeps reading its variable: `{ routes }` becomes `{ $routes: routes }`.
const renameKey = (p: Prop) => m.add({ start: p.keyStart, end: p.keyEnd, text: p.shorthand ? `$${p.key}: ${p.key}` : "$" + p.key });

/**
 * A route leaf is resolved as a FileNode step, so its `file` is an op key;
 * `run` is the router's step list, and `queryParams`/`body` hold JSON Schema,
 * whose keywords (`not`, `if`) must not be read as ops. A route node's own `if`
 * guard is gone: the node becomes an `$if` step returning its subtree by
 * reference, which is a restructure, not a rename.
 */
function walkRoute(ref: string, v: Val): boolean {
  // An event handler without `do` is itself the step the event runs.
  if (ref === "#/$defs/_eventHandler" && v.k === "obj" && !v.props.some(p => p.key === "do")) { m.walk(ANY, v); return true; }
  if (ref === "#/$defs/_routeNode" && v.k === "obj") {
    // A tree read from elsewhere (`{ "var": "$routes" }`) stands in the node's place.
    const first = v.props[0]?.key;
    if (first !== undefined && HANDLERS.has(first) && !ROUTE_NODE_KEYS.has(first)) { m.walk(ANY, v); return true; }
    const guard = v.props.find(p => p.key === "if");
    if (guard) m.review(guard.keyStart, "route node has an `if` guard; rewrite it as { \"$if\": <cond>, \"then\": <subtree by reference> }");
  }
  if (ref === "#/$defs/_routeHandler" && v.k === "obj") {
    for (const p of v.props) {
      if (p.key === "file") { renameKey(p); m.walk({ $ref: "#/$defs/strOrExpr" }, p.value); }
      else if (p.key === "run") m.walk(STEPS, p.value);
    }
    return true;
  }
  return false;
}

/**
 * Siblings renamed since the prefix, by op: names that avoided an op's name
 * and now take their natural one, and the key that picks a named backend
 * (`connection` within the node that owns it, the resource's name outside it).
 */
const SIBLING_RENAMES: Record<string, Record<string, string>> = {
  mapRange: { clampToRange: "clamp" },
  file: { copyTo: "copy", moveTo: "move" },
  tray: { items: "menu" },
  setVars: { raw: "data" },
  database: { name: "connection" },
  query: { connection: "database" },
};

/**
 * A tuple whose later slots became siblings: `[value, x]` is `value` with
 * `<names[0]>: x` beside it. Only the brackets and the commas between slots are
 * rewritten, so edits inside the slots still apply. Returns false, editing
 * nothing, when the value is not a literal tuple of a fitting length.
 */
function tupleToSiblings(p: Prop, names: string[]): boolean {
  const v = p.value;
  if (v.k !== "arr" || v.items.length === 0 || v.items.length > names.length + 1) return false;
  const key = (name: string) => (p.keyQuoted ? `"${name}"` : name);
  const { items } = v;
  m.add({ start: v.start, end: items[0].start, text: "" });
  for (let i = 1; i < items.length; i++) m.add({ start: items[i - 1].end, end: items[i].start, text: `, ${key(names[i - 1])}: ` });
  m.add({ start: items[items.length - 1].end, end: v.end, text: "" });
  return true;
}

/** Whether `key` is one of the options `op` takes, in any of its operations. An element takes any attribute. */
function takesSibling(op: string, key: string): boolean {
  if (op === "tag") return true;
  const s = C.byKey[op] as { properties?: object; patternProperties?: object; allOf?: Array<{ then?: { properties?: object } }>; $ref?: string } | undefined;
  if (!s) return false;
  const shapes = [s, ...(s.allOf ?? []).map(b => b.then ?? {})];
  if (typeof s.$ref === "string") shapes.push(C.$defs[s.$ref.replace("#/$defs/", "")] as object);
  return shapes.some(shape => {
    const { properties, patternProperties } = (shape ?? {}) as { properties?: object; patternProperties?: object };
    return (properties && key in properties) || Object.keys(patternProperties ?? {}).some(re => new RegExp(re).test(key));
  });
}

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
    m.add({ start: v.start, end: v.end, text: q === '"' ? `"${body}"` : `${q}${body.replace(new RegExp(q, "g"), "\\" + q)}${q}` });
    return;
  }
  if (v.k !== "obj") return;
  const concat = v.props.find(p => p.key === "concat" || p.key === "$concat");
  if (concat?.value.k === "arr" && concat.value.items[0]) stripPathDollar(concat.value.items[0]);
}

/**
 * A `setVars` map key could carry the same leading `$` as a `var` path, and the
 * write stripped it. A `$` key is a step now, so the key loses its `$` the way
 * the path does. A key that names an op or a global is left for review: it
 * could be a step written in place of the map.
 */
function stripMapKeyDollars(v: Val): void {
  if (v.k !== "obj") return;
  for (const p of v.props) {
    const name = p.key.slice(1);
    if (!p.key.startsWith("$") || name === "") continue;
    if (HANDLERS.has(name) || GLOBALS.has(name)) {
      m.review(p.keyStart, `\`setVars\` key "${p.key}" names an op, so it now runs as a step; rename the variable if it was one`);
      continue;
    }
    m.add({ start: p.keyStart, end: p.keyEnd, text: name });
  }
}

/**
 * A listener's `sw` used to map event names to steps; its keys are event names,
 * never ops (a `fetch` event is not the `fetch` op), so only the steps under them
 * are migrated. The config itself changed shape, which is left for review:
 * precaching, routes, skipWaiting and claim are config now, and the handlers
 * move under `events`. Returns true when it walked the value.
 */
function migrateServiceWorker(op: string, key: string, p: Prop): boolean {
  if (op !== "listen" || key !== "sw" || p.value.k !== "obj") return false;
  m.review(
    p.keyStart,
    p.value.props.length === 0
      ? "`sw: {}` no longer registers a default service worker; remove it, or write a config"
      : "`sw` is now { precache, routes, skipWaiting, claim, events }: `sw-cache` becomes `precache` (plus `skipWaiting: true`, which install used to do on its own), `sw-claim` becomes `claim`, `sw-strategy` becomes a route (`prefix: \"/assets/*\"` becomes `path: \"/assets/**\"`), and the other handlers move under `events`",
  );
  for (const event of p.value.props) m.walk(ANY, event.value);
  return true;
}

/** The operators a `where` column's value may hold, as `query` read them. */
const WHERE_OPS = new Set(["eq", "neq", "ne", "!=", "gt", ">", "gte", ">=", "lt", "<", "lte", "<=", "like", "notLike", "in", "notIn", "between", "notBetween", "null"]);

/**
 * A `query`'s `where`, `data` or `orderBy`: column names mapped to values, which
 * `query` resolved one by one so a column named like an op (`email`, `slug`) was
 * never dispatched. Its keys stay as written: `or`/`and` hold more of the same,
 * a `where` operator object (`{ "in": [...] }`) keeps its operator, and each
 * value is an expression. An array is rows, and `{ "var": ... }` reads the whole
 * map from a variable.
 */
function walkColumns(v: Val): void {
  if (v.k === "arr") { for (const it of v.items) walkColumns(it); return; }
  if (v.k !== "obj" || (v.props.length === 1 && v.props[0].key === "var")) { m.walk(ANY, v); return; }
  for (const p of v.props) {
    const value = p.value;
    if ((p.key === "or" || p.key === "and") && value.k === "arr") { for (const it of value.items) walkColumns(it); continue; }
    if (value.k === "obj" && value.props.some(o => WHERE_OPS.has(o.key))) { for (const o of value.props) m.walk(ANY, o.value); continue; }
    m.walk(ANY, value);
  }
}

/** A route tree written as data, as a file `routes` loads with `data: true` holds: route keys only, with methods or children. */
const isRouteTree = (v: Extract<Val, { k: "obj" }>) =>
  v.props.length > 0 && v.props.every(p => ROUTE_NODE_KEYS.has(p.key)) && v.props.some(p => p.key === "methods" || p.key === "children");

function walkExpr(v: Val): void {
  if (v.k === "arr") { for (const it of v.items) m.walk(ANY, it); return; }
  if (v.k !== "obj") return;
  // Its handlers' `body` and `query` hold JSON Schema and its children are named
  // by path segment, so it is walked as a route node, not as an expression.
  if (isRouteTree(v)) { m.walk({ $ref: "#/$defs/_routeNode" }, v); return; }
  // A table document's `properties` describe columns (`unique`, `computed: { sha256 }`),
  // never steps: only its `x-db.validator` runs, and its `x-entity` is the app's own.
  if (v.props.some(p => p.key === "x-db") && v.props.some(p => p.key === "properties")) {
    for (const p of v.props) {
      const validator = p.key === "x-db" && p.value.k === "obj" ? p.value.props.find(d => d.key === "validator") : undefined;
      if (validator) m.walk(STEPS, validator.value);
      if (p.key.startsWith("x-") && p.key !== "x-db") m.walk(ANY, p.value);
    }
    return;
  }
  // Already migrated (a `$op` key, or only `$` globals): walk it the same way, renaming nothing.
  const migratedOp = v.props.find(p => p.key.startsWith("$") && HANDLERS.has(p.key.slice(1)))?.key.slice(1);
  const migrated = migratedOp !== undefined || v.props.some(p => p.key.startsWith("$") && GLOBALS.has(p.key.slice(1)));
  const bare = (p: Prop) => (migrated && p.key.startsWith("$") ? p.key.slice(1) : p.key);
  const op = migrated ? migratedOp : v.props.find(p => HANDLERS.has(p.key))?.key;
  const first = v.props.find(p => !GLOBALS.has(bare(p)));
  // Objects that dispatch on a key other than their first: data that happens to
  // hold an op name, or a real step written out of order.
  if (!migrated && op && first && first.key !== op) {
    m.review(first.keyStart, `dispatches on "${op}" though "${first.key}" comes first (data holding an op name, or a step written out of order)`);
  }
  // Keys none of which the op takes are data that happens to hold an op's name
  // (a content file's `slug` field): it is left as it is, its values walked.
  const others = v.props.filter(p => p.key !== op && !GLOBALS.has(bare(p)) && p.key !== "comment");
  if (!migrated && op && others.length >= 2 && others.every(p => !takesSibling(op, p.key))) {
    const at = v.props.find(p => p.key === op)!;
    m.review(at.keyStart, `"${op}" is left as data: it is an op's name, but ${others.map(p => `"${p.key}"`).join(", ")} ${others.length === 1 ? "is not one of its options" : "are none of its options"}; if this is a step, prefix its key with \`$\``);
    for (const p of v.props) m.walk(ANY, p.value);
    return;
  }
  const rawValues = op === "setVars" && v.props.some(p => (p.key === "raw" || p.key === "data") && p.value.k === "lit" && p.value.value === true);
  for (const p of v.props) {
    const key = bare(p);
    const global = migrated ? p.key.startsWith("$") && GLOBALS.has(key) : GLOBALS.has(key) && !(key === "then" && op === "if");
    if (global) {
      if (!migrated) renameKey(p);
      if (key === "then" || key === "catch") m.walk(STEPS, p.value);
      else if (key === "return" || key === "bubble") m.walk(ANY, p.value);
      continue;
    }
    if (op === undefined) { m.walk(ANY, p.value); continue; }
    if (key === op && (!migrated || p.key.startsWith("$"))) {
      // `$exec` became `$runVar`, which takes the variable's path rather than a
      // step reading it: `{ "$exec": { "$var": "x" } }` is `{ "$runVar": "x" }`.
      if (op === "exec") {
        const v = p.value;
        const read = v.k === "obj" && v.props.length === 1 ? v.props[0] : undefined;
        if (v.k === "obj" && read && (read.key === "var" || read.key === "$var") && read.value.k === "str" && !p.shorthand) {
          m.add({ start: p.keyStart, end: p.keyEnd, text: "$runVar" });
          m.add({ start: v.start, end: v.end, text: JSON.stringify(read.value.value.replace(/^\$/, "")) });
          continue;
        }
        m.review(p.keyStart, "`$exec` is now `$runVar`, which runs the steps a variable holds by its path: keep these steps in a variable (`$setVars` with `data: true`) and run `{ \"$runVar\": \"name\" }`");
      }
      if (!migrated) renameKey(p);
      // v1 took both as a tuple, so its later slot becomes the sibling it is now.
      if (!migrated && op === "stringify" && p.value.k === "arr" && !tupleToSiblings(p, ["indent"])) {
        m.review(p.keyStart, "`$stringify` serializes its value as given now, arrays included; `[value, indent]` becomes `value` with an `indent` sibling");
      }
      if (!migrated && op === "join" && p.value.k === "arr" && !tupleToSiblings(p, ["separator"])) {
        m.review(p.keyStart, "`$join` takes the array itself now; `[array, separator]` becomes `array` with a `separator` sibling");
      }
      // Rotating the session is a sibling of setting values now, so a login is one step.
      if (op === "session" && p.value.k === "str" && p.value.value === "regenerate") {
        m.add({ start: p.value.start, end: p.value.end, text: "{}, \"regenerate\": true" });
      }
      if (op === "session" && p.value.k === "str" && p.value.value === "create") {
        m.review(p.keyStart, "`$session: \"create\"` is gone: `load` starts a session on a page view and setting values starts one when needed; for a fresh id use `{ \"$session\": {}, \"regenerate\": true }`");
      }
      if (op === "oauth" && p.value.k === "str" && p.value.value === "state") {
        m.review(p.keyStart, "`$oauth: \"state\"` is gone: `authUrl` makes its own state and keeps it in the session for `exchange`; drop the step, or use `$randomHex` for a random string");
      }
      if (op === "var" || op.startsWith("tree-")) stripPathDollar(p.value);
      if (op === "setVars") stripMapKeyDollars(p.value);
      // Values stored raw are mostly steps kept for `$exec`, so each is walked
      // as an expression: data holding no op passes through as it is.
      if (!rawValues) m.walk(C.vp[op] ?? m.siblingSchema(op, op), p.value);
      else if (p.value.k === "obj") for (const stored of p.value.props) m.walk(ANY, stored.value);
      continue;
    }
    const renamed = SIBLING_RENAMES[op]?.[key];
    if (renamed) m.add({ start: p.keyStart, end: p.keyEnd, text: p.shorthand ? `${renamed}: ${p.key}` : renamed });
    if (migrateServiceWorker(op, key, p)) continue;
    if (op === "query" && key === "options" && p.value.k === "obj") {
      for (const o of p.value.props) {
        if (o.key === "where" || o.key === "data" || o.key === "orderBy") walkColumns(o.value);
        // A join names its table, alias (`as`) and columns: there is nothing in it to migrate.
        else if (!o.key.endsWith("Join")) m.walk(ANY, o.value);
      }
      continue;
    }
    m.walk(m.siblingSchema(op, p.key), p.value);
  }
}

run(m);
