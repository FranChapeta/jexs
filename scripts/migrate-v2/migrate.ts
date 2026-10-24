/**
 * Codemod for the template changes of Jexs v2 (core, server and client 2.0).
 *
 * Each v2 commit that changes how a template is written adds a rule to `RULES`,
 * under the op it applies to. A rule is handed each step of that op once and
 * rewrites it through the codemod's `add` (an edit) or `review` (a spot left for
 * a person, printed with its line).
 *
 * Steps are found by walking templates as the project's own combined schema
 * describes them, so a rule only ever sees real steps, never data that holds an
 * op's name. That is `.jexs/combined.schema.json`, which `jexs schema` writes on
 * install from the packages the project has: run the codemod BEFORE upgrading
 * them, while it still describes the templates being migrated.
 *
 * Usage, from the project root:
 *   npx tsx <jexs>/scripts/migrate-v2/migrate.ts [--dry] [--literals] [--schema=<path>] <file|dir>...
 *   .json files  migrated as templates (a whole file is one step or a step list)
 *   .ts/.mjs     expression literals, and JSON inside `examples` strings and
 *                backtick code spans in strings
 *   .md          ```json blocks and inline code spans
 *   --schema     the combined schema to walk by (default .jexs/combined.schema.json)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ANY, STEPS, createCodemod, run, type Codemod, type CombinedSchema, type Val } from "../codemod/codemod.js";
import { HANDLER_RENAMES, OP_RENAMES } from "./renames.js";

const args = process.argv.slice(2);
const schemaPath = path.resolve(args.find(a => a.startsWith("--schema="))?.slice("--schema=".length) ?? ".jexs/combined.schema.json");
if (!existsSync(schemaPath)) {
  console.error(`No combined schema at ${schemaPath}. Run \`jexs schema\` in the project with its current (pre-v2) packages installed, or pass --schema=<path>.`);
  process.exit(1);
}
const C = JSON.parse(readFileSync(schemaPath, "utf8")) as CombinedSchema;
const HANDLERS = new Set(Object.keys(C.byKey));
const GLOBALS = new Set(["as", "then", "catch", "return", "bubble"]);

/** One step: the op it dispatches on, and the object written for it. */
export interface Step {
  op: string;
  obj: Extract<Val, { k: "obj" }>;
}

type Rule = (step: Step, m: Codemod) => void;

/**
 * A tuple whose later slots become named siblings: `{ "$op": [a, b, c] }` is
 * `{ "$op": a, "<names[0]>": b, "<names[1]>": c }`. Only the brackets and the
 * commas between slots are rewritten, so edits inside the slots (a step nested
 * in one) still apply. A value that is not a literal tuple of a fitting length
 * is left for review.
 */
function tupleToSiblings({ op, obj }: Step, names: string[], m: Codemod, minSlots = 2): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  // A step that already has the siblings is migrated.
  if (!prop || obj.props.some(p => p.key === names[0])) return;
  const v = prop.value;
  const shape = `[<array>, ${names.map(n => `<${n}>`).join(", ")}]`;
  if (v.k !== "arr" || v.items.length < minSlots || v.items.length > names.length + 1) {
    m.review(prop.keyStart, `\`$${op}\` no longer takes ${shape}: give it the array, with ${names.map(n => `\`${n}\``).join(" and ")} beside it`);
    return;
  }
  const key = (name: string) => (prop.keyQuoted ? `"${name}"` : name);
  const { items } = v;
  m.add({ start: v.start, end: items[0].start, text: "" });
  for (let i = 1; i < items.length; i++) m.add({ start: items[i - 1].end, end: items[i].start, text: `, ${key(names[i - 1])}: ` });
  m.add({ start: items[items.length - 1].end, end: v.end, text: "" });
}

/**
 * Move a tuple's optional last slot out to a sibling: `[a, b, c]` becomes
 * `[a, b], "<name>": c`. Only a literal slot moves, as it is rewritten from its
 * value; an expression there is left for review, so edits inside it are never
 * lost. A tuple without the slot is left as it is.
 */
function lastSlotToSibling({ op, obj }: Step, slot: number, name: string, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  const v = prop?.value;
  if (!prop || v?.k !== "arr" || v.items.length <= slot) return;
  const moved = v.items[slot];
  if (v.items.length > slot + 1 || (moved.k !== "str" && moved.k !== "lit")) {
    m.review(prop.keyStart, `\`$${op}\`'s slot ${slot + 1} is now the \`${name}\` sibling: move it out of the tuple`);
    return;
  }
  const key = prop.keyQuoted ? `"${name}"` : name;
  m.add({ start: v.items[slot - 1].end, end: moved.end, text: "" });
  m.add({ start: v.end, end: v.end, text: `, ${key}: ${JSON.stringify(moved.value)}` });
}

/**
 * Move a sibling into a tuple with the op's value: `{ "$op": a, "<name>": b }`
 * becomes `{ "$op": [a, b] }`. Only a plain sibling (see `isPlain`) after
 * another key moves; anything else is left for review.
 */
function siblingToTuple({ op, obj }: Step, name: string, m: Codemod): void {
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  const at = obj.props.findIndex(p => p.key === name);
  const sibling = obj.props[at];
  if (!value || !sibling) return;
  if (at === 0 || !isPlain(sibling.value)) {
    m.review(sibling.keyStart, `\`$${op}\` takes \`[<value>, <${name}>]\` now: move \`${name}\` into the tuple`);
    return;
  }
  const close = `, ${m.text(sibling.value.start, sibling.value.end)}]`;
  const before = obj.props[at - 1].value.end;
  m.add({ start: value.start, end: value.start, text: "[" });
  // Right after the op's value, closing the tuple and dropping the sibling are one edit.
  if (before === value.end) m.add({ start: value.end, end: sibling.value.end, text: close });
  else {
    m.add({ start: value.end, end: value.end, text: close });
    m.add({ start: before, end: sibling.value.end, text: "" });
  }
}

/** Rename the step's op key to `$<to>`. */
function renameOp({ op, obj }: Step, to: string, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  if (prop && !prop.shorthand) m.add({ start: prop.keyStart, end: prop.keyEnd, text: "$" + to });
}

/**
 * Whether moving `v`'s text elsewhere is safe: a literal, an array of them, or a
 * lone `$var` of a literal path. Text holding other steps is never moved, as
 * edits made inside it would be lost.
 */
function isPlain(v: Val): boolean {
  if (v.k === "str" || v.k === "lit") return true;
  if (v.k === "arr") return v.items.every(isPlain);
  return v.k === "obj" && v.props.length === 1 && v.props[0].key === "$var" && v.props[0].value.k === "str";
}

/** Rewrite a string literal to `text`, keeping its quotes. */
function replaceString(v: Extract<Val, { k: "str" }>, text: string, m: Codemod): void {
  const quoted = v.quote === '"' ? JSON.stringify(text) : v.quote + text.replaceAll(v.quote, "\\" + v.quote) + v.quote;
  m.add({ start: v.start, end: v.end, text: quoted });
}

/**
 * Point the reads, inside `v`, of the variables named in `roots` through `to`:
 * `$var` paths and `$name...` interpolated in strings, given the whole path.
 */
function retargetReads(v: Val, roots: string[], to: (path: string) => string, m: Codemod): void {
  if (roots.length === 0) return;
  const names = roots.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const rooted = new RegExp(`^(?:${names})(?=\\.|$)`);
  const interpolated = new RegExp(`\\$((?:${names})(?![\\w$])(?:\\.\\w+)*)`, "g");
  const walk = (x: Val): void => {
    if (x.k === "arr") x.items.forEach(walk);
    else if (x.k === "obj") {
      for (const p of x.props) {
        if (p.key === "$var" && p.value.k === "str") {
          if (rooted.test(p.value.value)) replaceString(p.value, to(p.value.value), m);
        } else walk(p.value);
      }
    } else if (x.k === "str") {
      const next = x.value.replace(interpolated, (_, path: string) => "$" + to(path));
      if (next !== x.value) replaceString(x, next, m);
    }
  };
  walk(v);
}

/** Rename the variables a step's `on-*` handlers read, `{ old: new }`, keeping
 *  the path below each. */
function handlerReads({ obj }: Step, names: Record<string, string>, m: Codemod): void {
  const roots = Object.keys(names);
  for (const p of obj.props) {
    if (p.key.startsWith("on-")) retargetReads(p.value, roots, path => path.replace(/^[^.]+/, root => names[root] ?? root), m);
  }
}

/** `$tick` and `$cron` are both `$interval` now; see `intervalRuns` for their steps. */
function toInterval(step: Step, m: Codemod): void {
  renameOp(step, "interval", m);
  intervalRuns(step, m, step.op);
  // A tick's `rate` counted runs per second, 60 unless told otherwise, and an
  // interval's `rate` is the milliseconds between runs.
  const op = step.obj.props.find(p => p.key === "$tick");
  if (op?.value.k !== "str" || op.value.value !== "start") return;
  const msOf = (perSecond: number) => String(Math.round(1_000_000 / perSecond) / 1000);
  const rate = step.obj.props.find(p => p.key === "rate");
  if (!rate) {
    m.add({ start: op.value.end, end: op.value.end, text: `, ${op.keyQuoted ? '"rate"' : "rate"}: ${msOf(60)}` });
  } else if (rate.value.k === "lit" && typeof rate.value.value === "number" && rate.value.value > 0) {
    m.add({ start: rate.value.start, end: rate.value.end, text: msOf(rate.value.value) });
  } else {
    m.review(rate.keyStart, "`rate` is now the milliseconds between runs, not runs per second: give `1000 / rate`");
  }
}

/** A content item written `{ "raw": x }`, an object whose one key is `raw`. */
const rawItem = (v: Val) => (v.k === "obj" && v.props.length === 1 && v.props[0].key === "raw" ? v.props[0].value : undefined);

/**
 * Steps that now run in a scope of their own lose a write meant to outlast them
 * unless it has `$bubble`. Which writes are meant so cannot be told from the
 * template, so each is left for review with `note`.
 */
function scopedWrites(steps: Val, note: string, m: Codemod): void {
  if (steps.k === "arr") steps.items.forEach(item => scopedWrites(item, note, m));
  if (steps.k !== "obj") return;
  const write = steps.props.find(p => p.key === "$as" || p.key === "$setVars");
  if (write && !steps.props.some(p => p.key === "$bubble")) m.review(write.keyStart, note);
  for (const p of steps.props) scopedWrites(p.value, note, m);
}

/** An element's event handlers run in a scope of their own. */
function eventScopes(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const events = obj.props.find(p => p.key === "events")?.value;
  if (events?.k !== "obj" || events.props.some(p => p.key.startsWith("$"))) return;
  for (const handler of events.props) {
    scopedWrites(handler.value, "An event handler runs in a scope of its own now: if this write is page state that later handlers read, add `\"$bubble\": true`", m);
  }
}

/**
 * Each run of an `$interval` has a scope of its own, which holds its timings by
 * name: `interval.dt` (`tick.dt`, `cron.dt`) is `dt`, and `cron.runCount` is
 * `count`. The timings are in milliseconds: `dt` and `elapsed` were seconds,
 * `lastRun` an ISO string. Reads outside the `do` steps are not found, since the
 * timer's variables used to be written where any later step could read them.
 */
function intervalRuns({ obj }: Step, m: Codemod, root = "interval"): void {
  const steps = obj.props.find(p => p.key === "do")?.value;
  if (!steps) return;
  scopedWrites(steps, "Each `$interval` run has a scope of its own now: if a later run or the caller reads this write, add `\"$bubble\": true`", m);
  const reads = (x: Val): void => {
    if (x.k === "arr") x.items.forEach(reads);
    if (x.k !== "obj") return;
    const path = x.props.find(p => p.key === "$var")?.value;
    if (path?.k === "str" && new RegExp(`^${root}\\.(dt|elapsed|lastRun)(\\.|$)`).test(path.value)) {
      m.review(path.start, `\`${path.value}\` is in milliseconds now (\`lastRun\` a Unix timestamp, not an ISO string): divide by 1000 where seconds are meant`);
    }
    for (const p of x.props) reads(p.value);
  };
  reads(steps);
  retargetReads(steps, [root], p => p.slice(root.length + 1).replace(/^runCount(?=\.|$)/, "count"), m);
}

/**
 * An element whose content is one `{ "raw": "text" }` item becomes
 * `"content": "text", "raw": true`. One mixed in with other content is left for
 * review: giving it an element of its own would change the markup.
 */
function rawContent(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const content = obj.props.find(p => p.key === "content");
  if (!content || obj.props.some(p => p.key === "raw")) return;
  const v = content.value;
  const only = rawItem(v) ?? (v.k === "arr" && v.items.length === 1 ? rawItem(v.items[0]) : undefined);
  if (only?.k === "str") {
    m.add({ start: v.start, end: v.end, text: m.text(only.start, only.end) });
    m.add({ start: v.end, end: v.end, text: `, ${content.keyQuoted ? '"raw"' : "raw"}: true` });
  } else if (only?.k === "obj" && isPlain(only)) {
    // A step's result in content is never interpolated, so a lone `$var` needs no `raw`.
    m.add({ start: v.start, end: v.end, text: m.text(only.start, only.end) });
  } else if (only !== undefined || (v.k === "arr" && v.items.some(item => rawItem(item) !== undefined))) {
    m.review(content.keyStart, "`{ \"raw\": ... }` content is gone: give the element `\"raw\": true` (its string content then renders as written), or put the literal text in an element of its own that has it");
  }
}

/** A step: an object with an op key. Where a step list yields a value, anything else is the response. */
const isStep = (v: Val) => v.k === "obj" && v.props.some(p => p.key.startsWith("$"));

/** A response object, written where a value is yielded, sets its headers with `responseHeaders`, not `responseHeader`. */
function responseObject(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const keys = obj.props.map(p => p.key);
  if (isStep(obj) || !keys.includes("response")) return;
  const alias = obj.props.find(p => p.key === "responseHeader");
  if (alias && keys.includes("responseHeaders")) {
    m.review(alias.keyStart, "`responseHeader` is gone: merge it into `responseHeaders`");
  } else if (alias) {
    m.add({ start: alias.keyStart, end: alias.keyEnd, text: alias.shorthand ? "responseHeaders: responseHeader" : "responseHeaders" });
  }
}

/** Wrap `v` in a `$return` step, quoting the key as `quoted` says. */
function wrapInReturn(v: Val, quoted: boolean, m: Codemod): void {
  m.add({ start: v.start, end: v.start, text: `{ ${quoted ? '"$return"' : "$return"}: ` });
  m.add({ start: v.end, end: v.end, text: " }" });
}

/**
 * A `$listen` request ends with what its steps yield, so a response object no
 * longer ends them early: one before the last step, written there or as an `$if`
 * or `$switch` branch, is wrapped in `$return`. A `$routes` step before the last
 * ended them whenever a route matched, so it is left for review.
 */
function listenSteps({ obj }: Step, m: Codemod): void {
  const steps = obj.props.find(p => p.key === "do");
  if (steps?.value.k !== "arr") return;
  const quoted = steps.keyQuoted;
  const wrap = (v: Val) => { if (v.k === "obj" && !isStep(v)) wrapInReturn(v, quoted, m); };
  for (const item of steps.value.items.slice(0, -1)) {
    if (item.k !== "obj") continue;
    if (!isStep(item)) { wrap(item); continue; }
    const op = item.props.find(p => p.key.startsWith("$"))?.key;
    for (const p of item.props) {
      if (op === "$if" && (p.key === "then" || p.key === "else")) wrap(p.value);
      if (op === "$switch" && p.key === "default") wrap(p.value);
      if (op === "$switch" && p.key === "cases" && p.value.k === "obj") p.value.props.forEach(c => wrap(c.value));
    }
    if (op === "$routes") {
      m.review(item.start, "A `$listen` request's steps no longer stop at a route's result: the last step's value (or a `$return`'s) is the response, so put `$routes` last or wrap it in `$return`");
    }
  }
}

const ROUTE_KEYS = new Set(["paramName", "paramRegex", "methods", "children"]);
const HANDLER_KEYS = new Set(["run", "queryParams", "body"]);

/** A route tree written as data: route keys only, with methods or children. */
const isRouteTree = (v: Val): v is Extract<Val, { k: "obj" }> =>
  v.k === "obj" && v.props.length > 0 && v.props.every(p => ROUTE_KEYS.has(p.key)) && v.props.some(p => p.key === "methods" || p.key === "children");

/** A route handler written as data: a `run` of steps, with its request schemas. */
const isRunHandler = (v: Val): v is Extract<Val, { k: "obj" }> =>
  v.k === "obj" && v.props.some(p => p.key === "run") && v.props.every(p => HANDLER_KEYS.has(p.key));

/** A handler's steps are its `do`, and the params above it are read from `request.params`. */
function routeHandler(v: Val, params: string[], m: Codemod): void {
  if (v.k !== "obj") return;
  const steps = v.props.find(p => p.key === "run");
  if (steps && isRunHandler(v)) {
    m.add({ start: steps.keyStart, end: steps.keyEnd, text: steps.shorthand ? "do: run" : "do" });
    // Walked as steps here too, as a schema that has the handler's `do` has no `run`.
    m.walk(STEPS, steps.value);
  }
  const file = v.props.find(p => p.key === "$file");
  if (file && params.length > 0) {
    m.review(file.keyStart, `Route params are read from \`request.params\` now: in the page this loads, read ${params.map(p => `\`${p}\` as \`request.params.${p}\``).join(", ")}`);
  }
  retargetReads(v, params, p => "request.params." + p, m);
}

/**
 * A route tree as v2 has it: each handler's steps in `do`, and a captured param
 * read from `request.params`. A param is retargeted where it is read under the
 * route that declares it; a subtree held elsewhere (a variable, a file) does not
 * know the params above it.
 */
function routeTree(v: Val, params: string[], m: Codemod): void {
  if (v.k !== "obj") return;
  if (!isRouteTree(v)) { retargetReads(v, params, p => "request.params." + p, m); return; }
  const name = v.props.find(p => p.key === "paramName")?.value;
  const inScope = name?.k === "str" && !params.includes(name.value) ? [...params, name.value] : params;
  for (const p of v.props) {
    if (p.key === "methods" && p.value.k === "obj") for (const h of p.value.props) routeHandler(h.value, inScope, m);
    if (p.key === "children" && p.value.k === "obj") for (const c of p.value.props) routeTree(c.value, inScope, m);
  }
}

/** A route tree or handler held as data, migrated without the params above it. */
function dataRoute(v: Val, m: Codemod): void {
  if (isRouteTree(v)) routeTree(v, [], m);
  else if (isRunHandler(v)) routeHandler(v, [], m);
}

/** The `$query` operations that read and write rows, each an op of its own. */
const ROW_OPS = ["select", "insert", "upsert", "update", "delete", "count"];

/** A `where` operator's one name, by each alias it had. */
const WHERE_OPERATORS: Record<string, string> = { ne: "neq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

/**
 * Rename the operator aliases in a `where` clause, through its `or` and `and`
 * lists. `isNotNull: <boolean>` is `isNull` with the opposite boolean.
 */
function whereOperators(v: Val, m: Codemod): void {
  if (v.k !== "obj" || isStep(v)) return;
  for (const p of v.props) {
    if ((p.key === "or" || p.key === "and") && p.value.k === "arr") p.value.items.forEach(item => whereOperators(item, m));
    else if (p.value.k === "obj" && !isStep(p.value)) {
      for (const op of p.value.props) {
        if (op.key === "isNotNull") {
          if (op.value.k === "lit" && typeof op.value.value === "boolean") {
            m.add({ start: op.keyStart, end: op.keyEnd, text: "isNull" });
            m.add({ start: op.value.start, end: op.value.end, text: String(!op.value.value) });
          } else {
            m.review(op.keyStart, "`isNotNull` is gone: `isNull: false` matches NOT NULL");
          }
          continue;
        }
        const to = WHERE_OPERATORS[op.key];
        // The key's span leaves out its quotes, so they stay as written.
        if (to) m.add({ start: op.keyStart, end: op.keyEnd, text: to });
      }
    }
  }
}

/** Rename the step's `from` sibling to `to`, keeping how its key is quoted. */
function renameSibling({ obj }: Step, from: string, to: string, m: Codemod): void {
  const prop = obj.props.find(p => p.key === from);
  if (prop) m.add({ start: prop.keyStart, end: prop.keyEnd, text: prop.shorthand ? `${to}: ${from}` : to });
}

/** Remove the step's `name` sibling, with the comma that joined it. */
function removeSibling({ obj }: Step, name: string, m: Codemod): void {
  const at = obj.props.findIndex(p => p.key === name);
  if (at === -1) return;
  const prop = obj.props[at];
  const keyStart = (p: typeof prop) => p.keyStart - (p.keyQuoted ? 1 : 0);
  if (at > 0) m.add({ start: obj.props[at - 1].value.end, end: prop.value.end, text: "" });
  else if (obj.props[at + 1]) m.add({ start: keyStart(prop), end: keyStart(obj.props[at + 1]), text: "" });
}

/**
 * `ws-close` and `ws-status` take the connection's name as their value, in place
 * of `true` and a `name` sibling: the sibling's value moves up, or `"default"`
 * stands for the unnamed connection.
 */
function connectionNameValue(step: Step, m: Codemod): void {
  const value = step.obj.props.find(p => p.key === "$" + step.op)?.value;
  if (value?.k !== "lit" || value.value !== true) return;
  const name = step.obj.props.find(p => p.key === "name");
  if (!name) {
    m.add({ start: value.start, end: value.end, text: '"default"' });
  } else if (!isPlain(name.value)) {
    m.review(name.keyStart, `\`$${step.op}\` takes the connection's name as its value now: move \`name\` there`);
  } else {
    m.add({ start: value.start, end: value.end, text: m.text(name.value.start, name.value.end) });
    removeSibling(step, "name", m);
  }
}

/**
 * `{ "$file": path, "delete": true }` is `{ "$fileDelete": path }`: the first
 * of `flags` present names the op, and its key goes. A flag that is not a
 * literal `true` ran the action all the same, which is likely not what was
 * meant, so it is left for review.
 */
function flagToOp(step: Step, flags: string[], m: Codemod): void {
  const flag = step.obj.props.find(p => flags.includes(p.key));
  if (!flag) return;
  const op = step.op + flag.key[0].toUpperCase() + flag.key.slice(1);
  if (flag.value.k !== "lit" || flag.value.value !== true) {
    m.review(flag.keyStart, `\`$${step.op}\` with \`${flag.key}\` ran the ${flag.key} whatever its value: it is \`$${op}\` now, so check this one was meant to`);
    return;
  }
  renameOp(step, op, m);
  removeSibling(step, flag.key, m);
}

/**
 * A value-mode step is an op of its own now, valued by what one of its siblings
 * gave: `{ "$query": "select", "table": "users" }` is `{ "$querySelect": "users" }`.
 * The op's key and value go and the sibling's key becomes the op's, so edits
 * inside the sibling's value still apply.
 */
function siblingAsOp(step: Step, sibling: string, to: string, m: Codemod): void {
  if (!step.obj.props.some(p => p.key === sibling)) {
    const prop = step.obj.props.find(p => p.key === "$" + step.op)!;
    m.review(prop.keyStart, `This step is \`$${to}\` now, valued by what \`${sibling}\` gave: give it that value`);
    return;
  }
  removeSibling(step, "$" + step.op, m);
  renameSibling(step, sibling, "$" + to, m);
}

type Obj = Extract<Val, { k: "obj" }>;
type Prop = Obj["props"][number];

/** Where a key starts, its opening quote included. */
const quoteStart = (p: Prop) => p.keyStart - (p.keyQuoted ? 1 : 0);

/**
 * Lift the settings of `owner`'s `x-db` object into `owner`, each renamed by
 * `rename`, or left out where it gives `null`. Only the wrapper and the keys are
 * rewritten, so edits inside the values still apply. A setting whose new name
 * `owner` already has is left for review, and nothing moves.
 */
function hoistXDb(owner: Obj, rename: (p: Prop) => string | null, m: Codemod): void {
  const xdb = owner.props.find(p => p.key === "x-db");
  if (xdb?.value.k !== "obj") return;
  const inner = xdb.value.props;
  const kept = inner.filter(p => rename(p) !== null);
  const clash = kept.find(p => owner.props.some(o => o !== xdb && o.key === rename(p)));
  if (clash) {
    m.review(xdb.keyStart, `\`x-db\`'s settings move up into this object, which already has \`${rename(clash)}\`: merge the two by hand`);
    return;
  }
  if (kept.length === 0) {
    removeSibling({ op: "", obj: owner }, "x-db", m);
    return;
  }
  m.add({ start: quoteStart(xdb), end: quoteStart(kept[0]), text: "" });
  m.add({ start: kept[kept.length - 1].value.end, end: xdb.value.end, text: "" });
  for (let i = 1; i < kept.length; i++) {
    const dropped = inner.slice(inner.indexOf(kept[i - 1]) + 1, inner.indexOf(kept[i]));
    if (dropped.length > 0) m.add({ start: kept[i - 1].value.end, end: dropped[dropped.length - 1].value.end, text: "" });
  }
  for (const p of kept) {
    const to = rename(p)!;
    if (to !== p.key) m.add({ start: p.keyStart, end: p.keyEnd, text: to });
  }
}

/** v1's SQL types that v2 names one way only. */
const SQL_TYPE_ALIASES: Record<string, string> = { int: "integer", bool: "boolean", blob: "binary", string: "varchar" };

/**
 * A v1 column: its `x-db` settings move up beside its JSON Schema keywords,
 * `default` there as `sqlDefault` and `length` as `maxLength`, and an `sqlType`
 * alias takes its one name. v1 used the JSON Schema `default` as the SQL default
 * when `x-db` gave none, so such a column gets a `sqlDefault` of the same value.
 */
function v1Column(col: Obj, m: Codemod): void {
  const xdb = col.props.find(p => p.key === "x-db")?.value;
  const inner = xdb?.k === "obj" ? xdb.props : [];
  const jsonDefault = col.props.find(p => p.key === "default");
  if (jsonDefault && !inner.some(p => p.key === "default")) {
    if (isPlain(jsonDefault.value)) {
      const key = jsonDefault.keyQuoted ? '"sqlDefault"' : "sqlDefault";
      m.add({ start: quoteStart(jsonDefault), end: quoteStart(jsonDefault), text: `${key}: ${m.text(jsonDefault.value.start, jsonDefault.value.end)}, ` });
    } else {
      m.review(jsonDefault.keyStart, "v1 used `default` as the column's SQL default too; v2 reads that from `sqlDefault` only, so add one if the database should fill it in");
    }
  }
  if (!xdb) return;
  const hasMaxLength = col.props.some(p => p.key === "maxLength");
  for (const p of inner) {
    if (p.key === "sqlType" && p.value.k === "str" && SQL_TYPE_ALIASES[p.value.value.toLowerCase()]) {
      replaceString(p.value, SQL_TYPE_ALIASES[p.value.value.toLowerCase()], m);
    }
    if (p.key === "length" && hasMaxLength) m.review(p.keyStart, "`length` goes: `maxLength` sets a `varchar`'s length, and this column has one already");
    if (p.key === "onUpdate" || p.key === "secret") m.review(p.keyStart, `\`${p.key}\` had no effect in v1 and is no column setting in v2: remove it`);
  }
  hoistXDb(col, p => p.key === "default" ? "sqlDefault" : p.key === "length" ? (hasMaxLength ? null : "maxLength") : p.key, m);
}

/** Each column of a v1 `properties` (or `addColumns`) map. */
function v1Columns(columns: Val, m: Codemod): void {
  if (columns.k !== "obj") return;
  for (const p of columns.props) if (p.value.k === "obj") v1Column(p.value, m);
}

/** A v1 table document: `properties` beside an `x-db` that names the table. */
const isV1TableDocument = (v: Val): v is Obj => v.k === "obj"
  && v.props.some(p => p.key === "properties" && p.value.k === "obj")
  && v.props.some(p => p.key === "x-db" && p.value.k === "obj" && p.value.props.some(q => q.key === "table"));

const migratedTables = new WeakSet<Val>();

/**
 * A v1 table document takes the v2 shape: its `x-db` settings move up beside
 * `properties`, and so do each column's. v1 added a `system` and a
 * `created_at` column to every table it built, so the document declares them,
 * else writes to them would be dropped. A table `validator` ran instead of the
 * global one in v1, and after it now; `false` opted out, which v2 has no way to.
 */
function v1TableDocument(doc: Obj, m: Codemod): void {
  if (migratedTables.has(doc)) return;
  migratedTables.add(doc);
  const xdb = doc.props.find(p => p.key === "x-db")!;
  const validator = xdb.value.k === "obj" ? xdb.value.props.find(p => p.key === "validator") : undefined;
  if (validator?.value.k === "lit" && validator.value.value === false) {
    m.review(validator.keyStart, "`validator: false` is gone: a table's `validator` runs after the connection's `rows` validator, never instead, so give the app's own queries `system: true`");
  } else if (validator) {
    m.review(validator.keyStart, "A table's `validator` used to run instead of the global one; it now runs after the connection's `rows` validator: check the two together");
  }
  const indexes = xdb.value.k === "obj" ? xdb.value.props.find(p => p.key === "indexes")?.value : undefined;
  for (const index of indexes?.k === "obj" ? indexes.props : []) {
    const type = index.value.k === "obj" ? index.value.props.find(p => p.key === "type") : undefined;
    if (type?.value.k === "str" && type.value.value === "fulltext") {
      m.review(type.keyStart, "A `fulltext` index was built as a plain one, and no `where` operator searches with it: make it `\"index\"`, or drop it");
    }
  }
  hoistXDb(doc, p => (p === validator && validator.value.k === "lit" && validator.value.value === false ? null : p.key), m);

  const properties = doc.props.find(p => p.key === "properties")!;
  if (properties.value.k !== "obj") return;
  v1Columns(properties.value, m);
  const columns = properties.value.props;
  const missing = ["system", "created_at"].filter(name => !columns.some(c => c.key === name));
  if (missing.length === 0) return;
  const quoted = columns[0]?.keyQuoted ?? properties.keyQuoted;
  const k = (name: string) => (quoted ? `"${name}"` : name);
  const declared: Record<string, string> = {
    system: `${k("system")}: { ${k("type")}: "integer", ${k("default")}: 0, ${k("sqlType")}: "boolean", ${k("sqlDefault")}: 0 }`,
    created_at: `${k("created_at")}: { ${k("type")}: "string", ${k("sqlType")}: "timestamp", ${k("sqlDefault")}: "CURRENT_TIMESTAMP" }`,
  };
  const text = missing.map(name => declared[name]).join(", ");
  const last = columns[columns.length - 1];
  if (last) m.add({ start: last.value.end, end: last.value.end, text: `, ${text}` });
  else m.add({ start: properties.value.start + 1, end: properties.value.start + 1, text: ` ${text} ` });
  m.review(properties.keyStart, `v1 added ${missing.map(n => `\`${n}\``).join(" and ")} to every table it built; they are declared here now, so drop them if this table has no use for them`);
}

/** The value a value-mode step names, when it is written as a literal. */
const opValue = ({ op, obj }: Step) => {
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  return value?.k === "str" ? value.value : undefined;
};

/**
 * An iterator's `do` runs as steps, so an array there is a step sequence rather
 * than the array it used to build. `[{ "$return": [...] }]` builds it as before:
 * a sequence of one step, which ends the sequence with that value.
 * An array whose items write with `$as` reads as steps already, so it is left
 * for review rather than kept as the array it built.
 */
function arrayDoAsReturn({ op, obj }: Step, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "do");
  const v = prop?.value;
  if (!prop || v?.k !== "arr") return;
  if (v.items.some(it => it.k === "obj" && it.props.some(p => p.key === "$as"))) {
    m.review(prop.keyStart, `\`$${op}\`'s \`do\` runs as steps now: this array was resolved as a literal, each item in parallel, so check it gives what the steps should, the last step's value being the result`);
    return;
  }
  m.add({ start: v.start, end: v.start, text: `[{ ${prop.keyQuoted ? '"$return"' : "$return"}: ` });
  m.add({ start: v.end, end: v.end, text: " }]" });
}

/** The v2 rewrites, by the op they apply to. */
const RULES: Record<string, Rule> = {
  // The per-item template is a `do` sibling, as on `map` and `foreach`, and the
  // reducer's start an `initial` one.
  filter: (step, m) => { tupleToSiblings(step, ["do"], m); arrayDoAsReturn(step, m); },
  find: (step, m) => { tupleToSiblings(step, ["do"], m); arrayDoAsReturn(step, m); },
  reduce: (step, m) => { tupleToSiblings(step, ["do", "initial"], m); arrayDoAsReturn(step, m); },
  map: arrayDoAsReturn,
  mapValues: arrayDoAsReturn,
  // The index variable is named by `index`, as on the array ops.
  foreach: (step, m) => renameSibling(step, "key", "index", m),
  // `then` is required: a branch on a falsy condition alone negates it.
  if: (step, m) => {
    const { obj } = step;
    if (obj.props.some(p => p.key === "then")) return;
    const prop = obj.props.find(p => p.key === "$if")!;
    if (!obj.props.some(p => p.key === "else")) {
      m.review(prop.keyStart, "`$if` needs a `then`: this one has no branch, so its condition alone was the point; use the condition step itself, or give `\"then\": true`");
      return;
    }
    m.add({ start: prop.value.start, end: prop.value.start, text: `{ ${prop.keyQuoted ? '"$not"' : "$not"}: ` });
    m.add({ start: prop.value.end, end: prop.value.end, text: " }" });
    renameSibling(step, "else", "then", m);
  },
  // Optional modifiers are siblings, not tuple slots.
  sortBy: (step, m) => lastSlotToSibling(step, 2, "order", m),
  padStart: (step, m) => lastSlotToSibling(step, 2, "pad", m),
  padEnd: (step, m) => lastSlotToSibling(step, 2, "pad", m),
  // `[n, decimals]` becomes `n` with `decimals` beside it; a plain number is already migrated.
  toFixed: (step, m) => {
    if (step.obj.props.find(p => p.key === "$toFixed")?.value.k === "arr") tupleToSiblings(step, ["decimals"], m, 1);
  },
  // `$sortDesc` is `$sort` with `order: "desc"`.
  sortDesc: ({ obj }, m) => {
    const prop = obj.props.find(p => p.key === "$sortDesc");
    if (!prop || prop.shorthand) return;
    m.add({ start: prop.keyStart, end: prop.keyEnd, text: "$sort" });
    m.add({ start: prop.value.end, end: prop.value.end, text: `, ${prop.keyQuoted ? '"order"' : "order"}: "desc"` });
  },
  // One timer op repeats steps at an interval.
  tick: toInterval,
  cron: toInterval,
  interval: (step, m) => intervalRuns(step, m),
  // Ops that duplicated others.
  sum: (step, m) => renameOp(step, "add", m),
  notEmpty: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$notEmpty");
    if (!prop || prop.shorthand) return;
    renameOp(step, "not", m);
    m.add({ start: prop.value.start, end: prop.value.start, text: `{ ${prop.keyQuoted ? '"$empty"' : "$empty"}: ` });
    m.add({ start: prop.value.end, end: prop.value.end, text: " }" });
  },
  in: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$in");
    const v = prop?.value;
    if (!prop) return;
    // Which op replaces it depends on the haystack's type, known only for a literal.
    const haystackKind = v?.k === "arr" ? v.items[1]?.k : undefined;
    if (v?.k !== "arr" || v.items.length !== 2 || !v.items.every(isPlain) || (haystackKind !== "arr" && haystackKind !== "str")) {
      m.review(prop.keyStart, "`$in` is gone: `[needle, haystack]` is `$includes` with `[haystack, needle]` for an array, `$contains` with `[haystack, needle]` for a string, or `$includes` with `[{ \"$keys\": haystack }, needle]` for an object's keys");
      return;
    }
    const [needle, haystack] = v.items;
    renameOp(step, haystackKind === "arr" ? "includes" : "contains", m);
    m.add({ start: needle.start, end: needle.end, text: m.text(haystack.start, haystack.end) });
    m.add({ start: haystack.start, end: haystack.end, text: m.text(needle.start, needle.end) });
  },
  // `$count` counts arrays only; a string's length is `$length`, an object's keys `$count` of `$keys`.
  count: ({ obj }, m) => {
    const prop = obj.props.find(p => p.key === "$count");
    if (prop && prop.value.k !== "arr") {
      m.review(prop.keyStart, "`$count` counts arrays only now: if this counts a string, use `$length`; for an object's keys, `$count` of `$keys`");
    }
  },
  // `$merge` merges objects only; concatenating arrays is `$flatten` one level deep.
  merge: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$merge");
    const v = prop?.value;
    if (!prop || prop.shorthand) return;
    const isData = (item: Val) => item.k === "obj" && item.props.every(p => !p.key.startsWith("$"));
    if (v?.k === "arr" && v.items.length > 0 && v.items.every(isData)) return;
    if (v?.k === "arr" && v.items.some(item => item.k === "arr")) {
      renameOp(step, "flatten", m);
      m.add({ start: v.end, end: v.end, text: `, ${prop.keyQuoted ? '"depth"' : "depth"}: 1` });
      return;
    }
    m.review(prop.keyStart, "`$merge` merges objects only now: if this concatenates arrays, use `$flatten` with `depth: 1`");
  },
  // Literal content is the element's `raw: true`, not an object with a `raw` key.
  tag: ({ obj }, m) => {
    rawContent(obj, m);
    eventScopes(obj, m);
  },
  // A request's response is what its steps yield.
  listen: listenSteps,
  // Handlers run `do`, and read params from `request.params`.
  routes: ({ obj }, m) => {
    const tree = obj.props.find(p => p.key === "$routes")?.value;
    if (tree) routeTree(tree, [], m);
  },
  // A connection's handlers: `on-connect` is `onOpen`, and its id is `id`.
  "socket-accept": (step, m) => {
    renameSibling(step, "on-connect", "onOpen", m);
    handlerReads(step, { wsId: "id" }, m);
  },
  // Client handlers read what they are handed by its role, as the server's do.
  "ws-connect": (step, m) => handlerReads(step, { wsMessage: "message", wsCode: "code", wsReason: "reason", wsClean: "clean" }, m),
  "ws-close": connectionNameValue,
  "ws-status": connectionNameValue,
  // `throw: false` is gone: the step's `$catch` yields what it used to, the
  // failing response (`full`) or its body. A request that never connected used
  // to yield a stand-in; under `$catch` it has no `response`.
  fetch: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "throw");
    if (!prop) return;
    if (prop.value.k === "lit" && prop.value.value === true) return removeSibling(step, "throw", m);
    if (prop.value.k !== "lit" || prop.value.value !== false || step.obj.props.some(p => p.key === "$catch")) {
      m.review(prop.keyStart, "`$fetch`'s `throw` is gone: a failure throws, and `$catch` on the step gets the failing `response`");
      return;
    }
    const full = step.obj.props.find(p => p.key === "full");
    const read = full?.value.k === "lit" && full.value.value === true ? "response" : "response.body";
    const q = prop.keyQuoted ? '"' : "";
    m.add({ start: prop.keyStart, end: prop.value.end, text: `$catch${q}: [{ ${q}$var${q}: "${read}" }]` });
  },
  // Storage reads like the cache: `storageSet` takes `value`, and removing is `storageDelete`.
  "storage-set": (step, m) => tupleToSiblings(step, ["value"], m),
  "storage-remove": (step, m) => renameOp(step, "storageDelete", m),
  // A level's name and value are its two operands.
  "audio-volume": (step, m) => siblingToTuple(step, "volume", m),
  rtc: (step, m) => handlerReads(step, { rtcSignal: "signal", rtcPeerId: "peer", rtcInbound: "inbound", rtcMessage: "message", rtcChannel: "channel" }, m),
  // The selection is one `selected`, and `on-change` no longer hands over the
  // tree serialized: it is `$stringify` of the tree's path.
  "tree-init": (step, m) => {
    handlerReads(step, { selectedPath: "selected.path", selectedNode: "selected.node", selectedEditMode: "selected.editMode" }, m);
    const path = opValue(step);
    const walk = (x: Val): void => {
      if (x.k === "arr") x.items.forEach(walk);
      if (x.k !== "obj") return;
      const only = x.props.length === 1 ? x.props[0] : undefined;
      if (only?.key === "$var" && only.value.k === "str" && only.value.value === "editorData") {
        if (path === undefined) m.review(only.keyStart, "`editorData` is gone: give `{ \"$stringify\": { \"$var\": <the tree's path> }, \"indent\": 2 }`");
        else m.add({ start: x.start, end: x.end, text: `{ "$stringify": { "$var": ${JSON.stringify(path)} }, "indent": 2 }` });
        return;
      }
      for (const p of x.props) walk(p.value);
    };
    const onChange = step.obj.props.find(p => p.key === "on-change")?.value;
    if (onChange) walk(onChange);
  },
  // One name per option: `tls` and `user`.
  // Dropping a table is `$tableDrop`, valued by the table, and whether one
  // exists is read from the list of them.
  database: (step, m) => {
    const value = opValue(step);
    if (value === "connect") renameSibling(step, "ssl", "tls", m);
    if (value === "dropTable") siblingAsOp(step, "table", "tableDrop", m);
    if (value === "tableExists") {
      const prop = step.obj.props.find(p => p.key === "$database")!;
      m.review(prop.keyStart, "`$database: \"tableExists\"` is gone: test the list of tables, `{ \"$includes\": [{ \"$database\": \"tables\" }, <table>] }`");
    }
  },
  // An action picked by a flag key's presence is an op of its own on the path.
  file: (step, m) => flagToOp(step, ["delete", "stat", "exists"], m),
  directory: (step, m) => flagToOp(step, ["create"], m),
  cache: (step, m) => {
    if (opValue(step) !== "dump") return;
    const prop = step.obj.props.find(p => p.key === "$cache")!;
    m.review(prop.keyStart, "`$cache: \"dump\"` is gone: read the keys you need with `$cacheGet`");
  },
  "cache-connect": (step, m) => {
    renameSibling(step, "username", "user", m);
    renameSibling(step, "ssl", "tls", m);
    const ttl = step.obj.props.find(p => p.key === "defaultTtl");
    if (ttl) m.review(ttl.keyStart, "`defaultTtl` is gone, and it never applied: drop it, and give `$cacheSet` its `ttl`");
    // `checkPeriod` was always milliseconds, though documented as seconds.
    const period = step.obj.props.find(p => p.key === "checkPeriod");
    if (period?.value.k === "lit" && typeof period.value.value === "number" && period.value.value > 0 && period.value.value < 1000) {
      m.review(period.keyStart, `\`checkPeriod\` is milliseconds, as it always was though documented as seconds: ${period.value.value} sweeps every ${period.value.value}ms, so write ${period.value.value * 1000} if seconds were meant`);
    }
  },
  "email-connect": (step, m) => renameSibling(step, "ssl", "tls", m),
  defer: ({ obj }, m) => {
    const delay = obj.props.find(p => p.key === "delay");
    if (delay) m.review(delay.keyStart, "`$defer`'s `delay` is gone: start the deferred steps with `{ \"$sleep\": <ms> }`");
  },
  // Each row operation is an op valued by its table (`$querySelect`, ...);
  // creating, altering and dropping a table are the table ops' (`$tableSync`,
  // valued by what `schema` gave, `$tableAlter`, `$tableDrop`); and the
  // connection is `connection`.
  query: (step, m) => {
    const where = step.obj.props.find(p => p.key === "where");
    if (where) whereOperators(where.value, m);
    renameSibling(step, "database", "connection", m);
    renameSibling(step, "group_concat", "groupConcat", m);
    const value = opValue(step);
    if (value === "update" && !step.obj.props.some(p => p.key === "where")) {
      const prop = step.obj.props.find(p => p.key === "$query")!;
      m.review(prop.keyStart, "`$queryUpdate` needs `where`: without one this updated every row, which is `where: {}` now");
    }
    if (value === "create") {
      const schema = step.obj.props.find(p => p.key === "schema")?.value;
      if (schema && isV1TableDocument(schema)) v1TableDocument(schema, m);
      siblingAsOp(step, "schema", "tableSync", m);
    } else if (value === "drop") siblingAsOp(step, "table", "tableDrop", m);
    else if (value === "alter") {
      siblingAsOp(step, "table", "tableAlter", m);
      const added = step.obj.props.find(p => p.key === "addColumns")?.value;
      if (added) v1Columns(added, m);
      renameSibling(step, "addColumns", "add", m);
      const prop = step.obj.props.find(p => p.key === "$query")!;
      m.review(prop.keyStart, "`$tableAlter` adds every column in `add` and returns `null`: one that exists is an error rather than skipped, so where this runs on every start, use `$tableSync` with the table's document");
    } else if (value !== undefined && ROW_OPS.includes(value)) {
      siblingAsOp(step, "table", "query" + value[0].toUpperCase() + value.slice(1), m);
    } else {
      const prop = step.obj.props.find(p => p.key === "$query")!;
      m.review(prop.keyStart, "`$query` is an op per operation now, valued by the table (`$querySelect`, `$queryInsert`, `$queryUpsert`, `$queryUpdate`, `$queryDelete`, `$queryCount`): use the one this step runs");
    }
  },
  // The subscription is the value, in place of `true` and `to`.
  webpush: (step, m) => {
    const value = step.obj.props.find(p => p.key === "$webpush")?.value;
    if (value?.k === "lit" && value.value === true) siblingAsOp(step, "to", "webpush", m);
  },
  // A connection's entry carries only the `meta` it was accepted with.
  "socket-list": ({ obj }, m) => {
    m.review(obj.props[0].keyStart, "`$socketList` entries no longer carry `name` from `session.user_name`: give `$socketAccept` a `meta`, e.g. `{ \"name\": { \"$var\": \"session.user_name\" } }`");
  },
  // A schema to register or check against is `schema`, a table's registered one
  // is `table/<name>`, and the validator is the connection's, its steps `rows`.
  schema: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$schema")!;
    const value = opValue(step);
    if (value === "register") {
      const table = step.obj.props.find(p => p.key === "table")?.value;
      if (table && isV1TableDocument(table)) v1TableDocument(table, m);
      renameSibling(step, "table", "schema", m);
      if (step.obj.props.some(p => p.key === "$as")) {
        m.review(prop.keyStart, "`$schema: \"register\"` returns the ids it registered (`table/<name>` for a table), not `{ registered }`");
      }
    }
    if (value === "validator") {
      renameOp(step, "database", m);
      renameSibling(step, "run", "rows", m);
      m.review(prop.keyStart, "The validator is the connection's now, so set it after `$database: \"connect\"` (with `connection` for one not the default). `rows` runs for row queries only: to authorize creating, altering and dropping tables, give it `structure` steps too");
    }
    if (value === "get") {
      m.review(prop.keyStart, "`$schema: \"get\"` is gone: read the document's file with `$file` (`data: true`), or find it in `{ \"$schema\": \"list\" }`");
    }
    if (value !== "validate") return;
    renameSibling(step, "document", "schema", m);
    const table = step.obj.props.find(p => p.key === "table");
    if (table?.value.k === "str") {
      m.add({ start: table.keyStart, end: table.keyEnd, text: "schema" });
      replaceString(table.value, "table/" + table.value.value, m);
    } else if (table) {
      m.review(table.keyStart, "`$schema: \"validate\"` names a table's schema as `schema: \"table/<name>\"`");
    }
  },
  // The part to extract is the second operand.
  datePart: (step, m) => siblingToTuple(step, "part", m),
  // `true` was shorthand for `"ms"`.
  dateNow: ({ obj }, m) => {
    const v = obj.props.find(p => p.key === "$dateNow")?.value;
    if (v?.k === "lit" && v.value === true) m.add({ start: v.start, end: v.end, text: '"ms"' });
  },
  // `[steps]` was shorthand for the default thread with those steps in `do`.
  thread: ({ obj }, m) => {
    const prop = obj.props.find(p => p.key === "$thread");
    if (prop?.value.k !== "arr") return;
    m.add({ start: prop.value.start, end: prop.value.start, text: `"default", ${prop.keyQuoted ? '"do"' : "do"}: ` });
  },
  // One operand was the max with 0 as the min; it is `[min, max]` or `[]` now.
  // `$random` is `$randomNumber`, which always takes `[min, max]`: a float in
  // [0, 1) is `[0, 1]` with as many `decimals` as are wanted, 15 at most.
  random: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$random");
    if (!prop || prop.shorthand) return;
    renameOp(step, "randomNumber", m);
    const v = prop.value;
    const one = v.k === "arr" ? (v.items.length === 1 ? v.items[0] : undefined) : v.k === "lit" || v.k === "str" ? v : undefined;
    if (v.k === "arr" && v.items.length === 0) {
      m.add({ start: v.start, end: v.end, text: "[0, 1]" });
      m.add({ start: v.end, end: v.end, text: `, ${prop.keyQuoted ? '"decimals"' : "decimals"}: 15` });
      m.review(prop.keyStart, "`$random` with no operands was a float in [0, 1); this is `[0, 1]` with 15 `decimals`: give fewer if fewer will do");
    } else if (one && v.k === "arr") {
      m.add({ start: one.start, end: one.start, text: "0, " });
    } else if (one) {
      m.add({ start: v.start, end: v.start, text: "[0, " });
      m.add({ start: v.end, end: v.end, text: "]" });
    } else if (v.k !== "arr") {
      m.review(prop.keyStart, "`$randomNumber` takes `[min, max]`: one operand `n` is `[0, n]`, and no operands was a float in [0, 1), now `[0, 1]` with `decimals`");
    }
  },
  // `[timestamp, "7d"]` is `[timestamp, 7]` with `"unit": "day"`, so a minute
  // and a month no longer share the letter `m`.
  dateAdd: ({ obj }, m) => {
    const prop = obj.props.find(p => p.key === "$dateAdd");
    const amount = prop?.value.k === "arr" ? prop.value.items[1] : undefined;
    if (!prop || !amount || (amount.k === "lit" && typeof amount.value === "number")) return;
    const units: Record<string, string> = { ms: "ms", s: "second", m: "minute", h: "hour", d: "day" };
    const parsed = amount.k === "str" ? /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(amount.value) : null;
    if (!parsed) {
      m.review(prop.keyStart, "`$dateAdd` takes `[timestamp, amount]` with a `unit` beside it (`ms`, `second`, `minute`, `hour`, `day`, `week`, `month`, `year`), not a duration string");
      return;
    }
    m.add({ start: amount.start, end: amount.end, text: parsed[1] });
    if (parsed[2] !== "ms") {
      const key = prop.keyQuoted ? '"unit"' : "unit";
      m.add({ start: prop.value.end, end: prop.value.end, text: `, ${key}: "${units[parsed[2]]}"` });
    }
  },
  // `[array, key, value]` is gone: `find` tests objects by a key.
  includes: ({ obj }, m) => {
    const prop = obj.props.find(p => p.key === "$includes");
    if (prop?.value.k === "arr" && prop.value.items.length === 3) {
      m.review(prop.keyStart, "`$includes` takes `[array, value]` only: for `[array, key, value]` test `{ \"$find\": array, \"do\": { \"$eq\": [{ \"$var\": \"item.<key>\" }, value] } }` against `null`");
    }
  },
  // Iterations bind only their item and index; what `loop` read depends on the
  // enclosing iterator's names, so it is left for review.
  var: ({ obj }, m) => {
    const path = obj.props.find(p => p.key === "$var")?.value;
    if (path?.k === "str" && /^loop(\.|$)/.test(path.value)) {
      m.review(path.start, `\`${path.value}\` is gone: \`loop.item\` and \`loop.index\` are the iteration's \`item\` and \`index\` (or the names its \`item\`/\`index\` siblings give), \`loop.key\` is \`index\` (or \`key\` in \`$mapValues\`), \`loop.first\` is \`{ "$eq": [index, 0] }\`, and \`loop.length\`/\`loop.last\` come from \`$count\` of the array`);
    }
  },
};

const m = createCodemod(C, { expr: walkExpr });

/** The schema can reach one value by several branches (an `anyOf`, an `if` it cannot decide); each is walked once. */
const walked = new WeakSet<Val>();

function walkExpr(v: Val): void {
  if (walked.has(v)) return;
  walked.add(v);
  if (v.k === "arr") { for (const it of v.items) m.walk(ANY, it); return; }
  if (v.k !== "obj") return;
  // An op a rule rewrites is a step even where the schema no longer has it (one
  // made after the upgrade, say); its siblings are then walked as plain values.
  const isOp = (name: string) => HANDLERS.has(name) || Object.hasOwn(RULES, name);
  const op = v.props.find(p => p.key.startsWith("$") && isOp(p.key.slice(1)))?.key.slice(1);
  if (op !== undefined) {
    RULES[op]?.({ op, obj: v }, m);
    // Ops and their handlers are named in camelCase.
    if (Object.hasOwn(OP_RENAMES, op)) renameOp({ op, obj: v }, OP_RENAMES[op], m);
    for (const p of v.props) if (Object.hasOwn(HANDLER_RENAMES, p.key)) renameSibling({ op, obj: v }, p.key, HANDLER_RENAMES[p.key], m);
  } else responseObject(v, m);
  // A route tree or handler written as data, such as a file `$routes` loads a
  // subtree from.
  if (op === undefined) dataRoute(v, m);
  // A v1 table document, in a file of its own or written inline.
  if (op === undefined && isV1TableDocument(v)) v1TableDocument(v, m);
  // A response object is also a branch's or a `$return`'s value, which the schema
  // takes for data.
  for (const p of v.props) {
    const branch = (op === "if" && (p.key === "then" || p.key === "else")) || (op === "switch" && p.key === "default") || p.key === "$return";
    if (branch && p.value.k === "obj") responseObject(p.value, m);
    if (op === "switch" && p.key === "cases" && p.value.k === "obj") {
      for (const c of p.value.props) if (c.value.k === "obj") responseObject(c.value, m);
    }
  }
  // A variable is written by its name as read: a leading `$` is no longer
  // dropped from `$as`.
  const asKey = v.props.find(p => p.key === "$as");
  if (asKey?.value.k === "str" && asKey.value.value.startsWith("$")) replaceString(asKey.value, asKey.value.value.slice(1), m);
  // A `$then` step yields null at once, so `$as` beside it is refused now.
  if (asKey && v.props.some(p => p.key === "$then")) {
    m.review(asKey.keyStart, "`$as` is refused beside `$then`, whose result arrives later: read it as `result` inside `$then`, or drop the `$as`");
  }
  // `$setVars` with `data: true` stores its values as written, steps included.
  const rawValues = op === "setVars" && v.props.some(p => p.key === "data" && p.value.k === "lit" && p.value.value === true);
  const stored = v.props.find(p => p.key === "$setVars")?.value;
  if (rawValues && stored?.k === "obj") for (const p of stored.props) dataRoute(p.value, m);
  for (const p of v.props) {
    const owned = p.key.startsWith("$") ? p.key.slice(1) : null;
    if (owned !== null && GLOBALS.has(owned)) m.walk(owned === "then" || owned === "catch" ? STEPS : ANY, p.value);
    else if (op === undefined) m.walk(ANY, p.value);
    else if (owned === op) { if (!rawValues) m.walk(C.vp[op] ?? m.siblingSchema(op, p.key), p.value); }
    else m.walk(m.siblingSchema(op, p.key), p.value);
  }
}

run(m, args.filter(a => !a.startsWith("--schema=")));
