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
 * becomes `{ "$op": [a, b] }`. Only a literal sibling after another key moves,
 * as it is rewritten from its value; anything else is left for review.
 */
function siblingToTuple({ op, obj }: Step, name: string, m: Codemod): void {
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  const at = obj.props.findIndex(p => p.key === name);
  const sibling = obj.props[at];
  if (!value || !sibling) return;
  if (at === 0 || (sibling.value.k !== "str" && sibling.value.k !== "lit")) {
    m.review(sibling.keyStart, `\`$${op}\` takes \`[<value>, <${name}>]\` now: move \`${name}\` into the tuple`);
    return;
  }
  const close = `, ${JSON.stringify(sibling.value.value)}]`;
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
 * Point the reads of a `$tick` or `$cron` step's own variables, inside its
 * steps, at the `interval` ones: `$var` paths and `$<from>...` interpolated in
 * strings, with `cron.runCount` now `count`. Reads elsewhere are not found,
 * since the timer's variables are written where any later step can read them.
 */
function retargetTimerReads(v: Val, from: "tick" | "cron", m: Codemod): void {
  const path = (p: string) => p.replace(new RegExp(`^${from}(?=\\.|$)`), "interval").replace(/^interval\.runCount(?=\.|$)/, "interval.count");
  if (v.k === "arr") for (const item of v.items) retargetTimerReads(item, from, m);
  else if (v.k === "obj") {
    for (const p of v.props) {
      if (p.key === "$var" && p.value.k === "str") {
        const next = path(p.value.value);
        if (next !== p.value.value) replaceString(p.value, next, m);
      } else retargetTimerReads(p.value, from, m);
    }
  } else if (v.k === "str") {
    const next = v.value.replace(new RegExp(`\\$${from}(?=\\.|\\b|$)((?:\\.[\\w]+)?)`, "g"), (_, rest: string) => "$" + path(from + rest));
    if (next !== v.value) replaceString(v, next, m);
  }
}

/** `$tick` and `$cron` are both `$interval` now; their steps read `interval.*`. */
function toInterval(step: Step, m: Codemod): void {
  renameOp(step, "interval", m);
  const steps = step.obj.props.find(p => p.key === "do")?.value;
  if (steps) retargetTimerReads(steps, step.op === "tick" ? "tick" : "cron", m);
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

/** Rename the step's `from` sibling to `to`, keeping how its key is quoted. */
function renameSibling({ obj }: Step, from: string, to: string, m: Codemod): void {
  const prop = obj.props.find(p => p.key === from);
  if (prop) m.add({ start: prop.keyStart, end: prop.keyEnd, text: prop.shorthand ? `${to}: ${from}` : to });
}

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
  // A `$then` step yields null at once, so `$as` beside it is refused now.
  const asKey = v.props.find(p => p.key === "$as");
  if (asKey && v.props.some(p => p.key === "$then")) {
    m.review(asKey.keyStart, "`$as` is refused beside `$then`, whose result arrives later: read it as `result` inside `$then`, or drop the `$as`");
  }
  // `$setVars` with `data: true` stores its values as written, steps included.
  const rawValues = op === "setVars" && v.props.some(p => p.key === "data" && p.value.k === "lit" && p.value.value === true);
  for (const p of v.props) {
    const owned = p.key.startsWith("$") ? p.key.slice(1) : null;
    if (owned !== null && GLOBALS.has(owned)) m.walk(owned === "then" || owned === "catch" ? STEPS : ANY, p.value);
    else if (op === undefined) m.walk(ANY, p.value);
    else if (owned === op) { if (!rawValues) m.walk(C.vp[op] ?? m.siblingSchema(op, p.key), p.value); }
    else m.walk(m.siblingSchema(op, p.key), p.value);
  }
}

run(m, args.filter(a => !a.startsWith("--schema=")));
