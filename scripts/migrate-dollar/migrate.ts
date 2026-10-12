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
  if (ref === "#/$defs/_routeNode" && v.k === "obj") {
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

function walkExpr(v: Val): void {
  if (v.k === "arr") { for (const it of v.items) m.walk(ANY, it); return; }
  if (v.k !== "obj") return;
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
      if (!migrated && op === "stringify" && p.value.k === "arr") {
        m.review(p.keyStart, "`$stringify` serializes its value as given now, arrays included; `[value, indent]` becomes `value` with an `indent` sibling");
      }
      if (!migrated && op === "join" && p.value.k === "arr") {
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
      if (!rawValues) m.walk(C.vp[op] ?? m.siblingSchema(op, op), p.value);
      continue;
    }
    const renamed = SIBLING_RENAMES[op]?.[key];
    if (renamed) m.add({ start: p.keyStart, end: p.keyEnd, text: p.shorthand ? `${renamed}: ${p.key}` : renamed });
    if (migrateServiceWorker(op, key, p)) continue;
    m.walk(m.siblingSchema(op, p.key), p.value);
  }
}

run(m);
