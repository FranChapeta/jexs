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
function tupleToSiblings({ op, obj }: Step, names: string[], m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  // A step that already has the siblings is migrated.
  if (!prop || obj.props.some(p => p.key === names[0])) return;
  const v = prop.value;
  const shape = `[<array>, ${names.map(n => `<${n}>`).join(", ")}]`;
  if (v.k !== "arr" || v.items.length < 2 || v.items.length > names.length + 1) {
    m.review(prop.keyStart, `\`$${op}\` no longer takes ${shape}: give it the array, with ${names.map(n => `\`${n}\``).join(" and ")} beside it`);
    return;
  }
  const key = (name: string) => (prop.keyQuoted ? `"${name}"` : name);
  const { items } = v;
  m.add({ start: v.start, end: items[0].start, text: "" });
  for (let i = 1; i < items.length; i++) m.add({ start: items[i - 1].end, end: items[i].start, text: `, ${key(names[i - 1])}: ` });
  m.add({ start: items[items.length - 1].end, end: v.end, text: "" });
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
  const op = v.props.find(p => p.key.startsWith("$") && HANDLERS.has(p.key.slice(1)))?.key.slice(1);
  if (op !== undefined) RULES[op]?.({ op, obj: v }, m);
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
