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

/**
 * `$tick` and `$cron` are both `$interval` now; their steps read `interval.*`,
 * with `cron.runCount` now `count`. Reads elsewhere are not found, since the
 * timer's variables are written where any later step can read them.
 */
function toInterval(step: Step, m: Codemod): void {
  renameOp(step, "interval", m);
  const from = step.op === "tick" ? "tick" : "cron";
  const steps = step.obj.props.find(p => p.key === "do")?.value;
  if (steps) {
    retargetReads(steps, [from], p => p.replace(from, "interval").replace(/^interval\.runCount(?=\.|$)/, "interval.count"), m);
  }
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
 * An element's event handlers run in a scope of their own, so a write meant as
 * page state needs `$bubble`. Which writes are page state cannot be told from
 * the template, so each is left for review.
 */
function eventScopes(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const events = obj.props.find(p => p.key === "events")?.value;
  if (events?.k !== "obj" || events.props.some(p => p.key.startsWith("$"))) return;
  const walk = (x: Val): void => {
    if (x.k === "arr") x.items.forEach(walk);
    if (x.k !== "obj") return;
    const write = x.props.find(p => p.key === "$as" || p.key === "$setVars");
    if (write && !x.props.some(p => p.key === "$bubble")) {
      m.review(write.keyStart, "An event handler runs in a scope of its own now: if this write is page state that later handlers read, add `\"$bubble\": true`");
    }
    for (const p of x.props) walk(p.value);
  };
  for (const handler of events.props) walk(handler.value);
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

/** A `where` operator's one name, by each alias it had. */
const WHERE_OPERATORS: Record<string, string> = { ne: "neq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };

/** Rename the operator aliases in a `where` clause, through its `or` and `and` lists. */
function whereOperators(v: Val, m: Codemod): void {
  if (v.k !== "obj" || isStep(v)) return;
  for (const p of v.props) {
    if ((p.key === "or" || p.key === "and") && p.value.k === "arr") p.value.items.forEach(item => whereOperators(item, m));
    else if (p.value.k === "obj" && !isStep(p.value)) {
      for (const op of p.value.props) {
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
 * Move the step to another op: `{ "$<op>": "<from>" }` becomes
 * `{ "$<node>": "<to>" }`, keeping how its key is quoted.
 */
function moveOp({ op, obj }: Step, node: string, to: string, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  if (!prop || prop.shorthand || prop.value.k !== "str") return;
  m.add({ start: prop.keyStart, end: prop.keyEnd, text: "$" + node });
  if (prop.value.value !== to) replaceString(prop.value, to, m);
}

/** The value a value-mode step names, when it is written as a literal. */
const opValue = ({ op, obj }: Step) => {
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  return value?.k === "str" ? value.value : undefined;
};

/** The v2 rewrites, by the op they apply to. */
const RULES: Record<string, Rule> = {
  // The per-item template is a `do` sibling, as on `map` and `foreach`, and the
  // reducer's start an `initial` one.
  filter: (step, m) => tupleToSiblings(step, ["do"], m),
  find: (step, m) => tupleToSiblings(step, ["do"], m),
  reduce: (step, m) => tupleToSiblings(step, ["do", "initial"], m),
  // The index variable is named by `index`, as on the array ops.
  foreach: (step, m) => renameSibling(step, "key", "index", m),
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
  // A connection's handlers: `on-connect` is `on-open`, and its id is `id`.
  "socket-accept": (step, m) => {
    renameSibling(step, "on-connect", "on-open", m);
    handlerReads(step, { wsId: "id" }, m);
  },
  // Client handlers read what they are handed by its role, as the server's do.
  "ws-connect": (step, m) => handlerReads(step, { wsMessage: "message", wsCode: "code", wsReason: "reason", wsClean: "clean" }, m),
  "ws-close": connectionNameValue,
  "ws-status": connectionNameValue,
  // Storage reads like the cache: `storage-set` takes `value`, and removing is `storage-delete`.
  "storage-set": (step, m) => tupleToSiblings(step, ["value"], m),
  "storage-remove": (step, m) => renameOp(step, "storage-delete", m),
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
  // A table's structure is `$table`'s.
  database: (step, m) => {
    const value = opValue(step);
    if (value === "connect") renameSibling(step, "ssl", "tls", m);
    if (value === "tableExists") moveOp(step, "table", "exists", m);
    if (value === "dropTable") moveOp(step, "table", "drop", m);
  },
  "cache-connect": (step, m) => {
    renameSibling(step, "username", "user", m);
    renameSibling(step, "ssl", "tls", m);
    const ttl = step.obj.props.find(p => p.key === "defaultTtl");
    if (ttl) m.review(ttl.keyStart, "`defaultTtl` is gone, and it never applied: drop it, and give `$cache-set` its `ttl`");
  },
  "email-connect": (step, m) => renameSibling(step, "ssl", "tls", m),
  defer: ({ obj }, m) => {
    const delay = obj.props.find(p => p.key === "delay");
    if (delay) m.review(delay.keyStart, "`$defer`'s `delay` is gone: start the deferred steps with `{ \"$sleep\": <ms> }`");
  },
  // `$query` is rows: creating, altering and dropping a table are `$table`'s,
  // and the connection is `connection`.
  query: (step, m) => {
    const where = step.obj.props.find(p => p.key === "where");
    if (where) whereOperators(where.value, m);
    renameSibling(step, "database", "connection", m);
    const value = opValue(step);
    if (value === "create" || value === "drop" || value === "alter") {
      moveOp(step, "table", value === "create" ? "sync" : value, m);
      renameSibling(step, "addColumns", "add", m);
    }
    if (value === "alter") {
      const prop = step.obj.props.find(p => p.key === "$query")!;
      m.review(prop.keyStart, "`$table: \"alter\"` adds every column in `add` and returns `null`: one that exists is an error rather than skipped, so where this runs on every start, use `$table: \"sync\"` with the table's document");
    }
  },
  // A connection's entry carries only the `meta` it was accepted with.
  "socket-list": ({ obj }, m) => {
    m.review(obj.props[0].keyStart, "`$socket-list` entries no longer carry `name` from `session.user_name`: give `$socket-accept` a `meta`, e.g. `{ \"name\": { \"$var\": \"session.user_name\" } }`");
  },
  // A schema to register or check against is `schema`, a table's registered one
  // is `table/<name>`, and the global validator is `$query`'s, its steps its `do`.
  schema: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$schema")!;
    const value = opValue(step);
    if (value === "register") {
      renameSibling(step, "table", "schema", m);
      if (step.obj.props.some(p => p.key === "$as")) {
        m.review(prop.keyStart, "`$schema: \"register\"` returns the ids it registered (`table/<name>` for a table), not `{ registered }`");
      }
    }
    if (value === "validator") {
      moveOp(step, "query", "validator", m);
      renameSibling(step, "run", "do", m);
      m.review(prop.keyStart, "The global validator now runs for row queries only: to authorize creating, altering and dropping tables, give `$table: \"validator\"` steps too");
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
  if (op !== undefined) RULES[op]?.({ op, obj: v }, m);
  else responseObject(v, m);
  // A route tree or handler written as data, such as a file `$routes` loads a
  // subtree from.
  if (op === undefined) dataRoute(v, m);
  // A response object is also a branch's or a `$return`'s value, which the schema
  // takes for data.
  for (const p of v.props) {
    const branch = (op === "if" && (p.key === "then" || p.key === "else")) || (op === "switch" && p.key === "default") || p.key === "$return";
    if (branch && p.value.k === "obj") responseObject(p.value, m);
    if (op === "switch" && p.key === "cases" && p.value.k === "obj") {
      for (const c of p.value.props) if (c.value.k === "obj") responseObject(c.value, m);
    }
  }
  // A `$then` step yields null at once, so `$as` beside it is refused now.
  const asKey = v.props.find(p => p.key === "$as");
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
