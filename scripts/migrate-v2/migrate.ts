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
 *   npx tsx <jexs>/scripts/migrate-v2/migrate.ts [--dry] [--literals] [--schema=<path>] [--bubble-handler-writes] <file|dir>...
 *   .json files  migrated as templates (a whole file is one step or a step list)
 *   .ts/.mjs     expression literals, and JSON inside `examples` strings and
 *                backtick code spans in strings
 *   .md          ```json blocks and inline code spans
 *   --schema     the combined schema to walk by (default .jexs/combined.schema.json)
 *   --bubble-handler-writes
 *                give `$bubble` to each write an event handler, an `$interval` run
 *                or a collision handler makes outside a loop, where they are left
 *                for review by default: v1 ran those steps in their caller's scope,
 *                so this keeps every such write where v1 kept it
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
const BUBBLE_HANDLER_WRITES = args.includes("--bubble-handler-writes");
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

/** `text` as a string literal in `quote`s. */
// A no-break space is written as its escape, which a reader can see.
const quoted = (text: string, quote: string) =>
  (quote === '"' ? JSON.stringify(text) : quote + text.replaceAll(quote, "\\" + quote) + quote).replaceAll(" ", "\\u00a0");

/** Rewrite a string literal to `text`, keeping its quotes. */
function replaceString(v: Extract<Val, { k: "str" }>, text: string, m: Codemod): void {
  m.add({ start: v.start, end: v.end, text: quoted(text, v.quote) });
}

/**
 * Point the reads, inside `v`, of the variables named in `roots` through `to`:
 * `$var` paths and `$name...` interpolated in strings, given the whole path.
 */
/** The names a socket's handlers are given: v1's `message`, and v2's connection `id` beside it. */
const SOCKET_BINDS: Record<string, string[]> = { "$socket-accept": ["message"], $socketAccept: ["id", "message"] };

function retargetReads(v: Val, roots: string[], to: (path: string) => string, m: Codemod): void {
  if (roots.length === 0) return;
  const names = roots.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const rooted = new RegExp(`^(?:${names})(?=\\.|$)`);
  const interpolated = new RegExp(`\\$((?:${names})(?![\\w$])(?:\\.\\w+)*)`, "g");
  const walk = (x: Val): void => {
    if (x.k === "arr") x.items.forEach(walk);
    else if (x.k === "obj") {
      // A socket's handlers bind names of their own, which hide a route param of the same name.
      const bound = SOCKET_BINDS[x.props.find(p => p.key in SOCKET_BINDS)?.key ?? ""];
      for (const p of x.props) {
        if (bound && /^on[-A-Z]/.test(p.key)) retargetReads(p.value, roots.filter(r => !bound.includes(r)), to, m);
        else if (p.key === "$var" && p.value.k === "str") {
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

/**
 * A collision handler runs in the scope `$physicsInit` ran in, which in a `mount`
 * handler is that handler's own, where v1's `load` ran in the page's.
 */
function collisionRuns({ obj }: Step, m: Codemod): void {
  const steps = obj.props.find(p => p.key === "do")?.value;
  if (steps) scopedWrites(steps, "A collision handler writes the scope `$physicsInit` ran in, which in a `mount` handler is that handler's own: if this write is page state, add `\"$bubble\": true`", m);
}

/** A content item written `{ "raw": x }`, an object whose one key is `raw`. */
const rawItem = (v: Val) => (v.k === "obj" && v.props.length === 1 && v.props[0].key === "raw" ? v.props[0].value : undefined);

/** The ops whose `do` runs once per item, in a scope per item, as v1's did. */
const LOOPS = new Set(["$map", "$foreach", "$filter", "$find", "$reduce", "$mapValues"]);

/**
 * Steps that now run in a scope of their own lose a write meant to outlast them
 * unless it has `$bubble`. Which writes are meant so cannot be told from the
 * template, so each is left for review with `note`; with `--bubble-handler-writes`
 * each gets `$bubble`, as v1 ran these steps in their caller's scope and so kept
 * every write. A write inside a loop's `do` stayed in that iteration in v1 too.
 */
function scopedWrites(steps: Val, note: string, m: Codemod): void {
  if (steps.k === "arr") steps.items.forEach(item => scopedWrites(item, note, m));
  if (steps.k !== "obj") return;
  const write = steps.props.find(p => p.key === "$as" || p.key === "$setVars");
  if (write && !steps.props.some(p => p.key === "$bubble")) {
    if (BUBBLE_HANDLER_WRITES) m.add({ start: write.value.end, end: write.value.end, text: `, ${keyLike(write, "$bubble")}: true` });
    else m.review(write.keyStart, note);
  }
  const loop = steps.props.some(p => LOOPS.has(p.key));
  for (const p of steps.props) if (!(loop && p.key === "do")) scopedWrites(p.value, note, m);
}

/**
 * An element's event handlers run in a scope of their own. The handler that ran
 * when the element was hydrated is `mount`, so `load` is the element's own DOM
 * event (an image's, a frame's), which v1 never bound.
 */
function eventScopes(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const events = obj.props.find(p => p.key === "events")?.value;
  if (events?.k !== "obj" || events.props.some(p => p.key.startsWith("$"))) return;
  for (const handler of events.props) {
    if (handler.key === "load") m.add({ start: handler.keyStart, end: handler.keyEnd, text: "mount" });
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

/** A `$identifier` that element content used to read from a variable. */
const CONTENT_READ = /\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;

/**
 * Element content renders its strings as written: `$name` in one is text, and a
 * variable is read with a `$var` step. An element's own text, and a `{ "raw": x }`
 * item, were kept out of interpolation and translation by `raw`; the text needs
 * nothing now, and staying untranslated is `translate: "no"`. That is also what
 * `raw: true` became, so the `$identifier`s in an element with it are left for
 * review: it was interpolated only if v1 wrote it so.
 */
function elementContent(obj: Extract<Val, { k: "obj" }>, m: Codemod): void {
  const content = obj.props.find(p => p.key === "content");
  const raw = obj.props.find(p => p.key === "raw");
  const key = (name: string) => ((content ?? raw)?.keyQuoted ? `"${name}"` : name);
  if (raw) {
    if (raw.value.k === "lit" && m.text(raw.value.start, raw.value.end) === "true") {
      m.add({ start: quoteStart(raw), end: raw.value.end, text: `${key("translate")}: "no"` });
    } else {
      m.review(raw.keyStart, "`raw` is gone: content renders as written now, and `translate: \"no\"` keeps it out of `$translate`");
    }
    return;
  }
  if (!content) return;
  const translate = obj.props.find(p => p.key === "translate")?.value;
  const reads = !(translate?.k === "str" && translate.value === "no");
  const tag = obj.props.find(p => p.key === "$tag")?.value;
  const name = tag?.k === "str" ? tag.value : "";
  if (name === "script") return;
  if (name === "style") return styleReads(content.value, key, m);
  const v = content.value;
  const only = rawItem(v) ?? (v.k === "arr" && v.items.length === 1 ? rawItem(v.items[0]) : undefined);
  if (only !== undefined) {
    m.add({ start: v.start, end: v.end, text: rawText(only, m) });
    if (only.k === "str") m.add({ start: v.end, end: v.end, text: `, ${key("translate")}: "no"` });
    return;
  }
  if (v.k === "str") {
    const items = contentText(v, key, m, reads);
    if (items) m.add({ start: v.start, end: v.end, text: items.length === 1 ? items[0] : `[${items.join(", ")}]` });
    return;
  }
  const items = (x: Val): void => {
    if (x.k !== "arr") return;
    for (const item of x.items) {
      const inner = rawItem(item);
      if (inner !== undefined) m.add({ start: item.start, end: item.end, text: rawText(inner, m) });
      else if (item.k === "str") {
        const split = contentText(item, key, m, reads);
        if (split) m.add({ start: item.start, end: item.end, text: split.join(", ") });
      } else items(item);
    }
  };
  items(v);
}

/** A v1 `{ "raw": x }` item's value as written in its place: text with its references decoded. */
const rawText = (v: Val, m: Codemod) => (v.k === "str" ? quoted(markupText(v, m), v.quote) : m.text(v.start, v.end));

/** A content string as items: its text with character references decoded and,
 *  when `reads`, a `$var` step for each read; undefined when it stays as written. */
function contentText(v: Extract<Val, { k: "str" }>, key: (name: string) => string, m: Codemod, reads: boolean): string[] | undefined {
  const text = markupText(v, m);
  const split = reads ? contentReads({ ...v, value: text }, key, m) : reviewReads(v, m);
  return split ?? (text !== v.value ? [quoted(text, v.quote)] : undefined);
}

/** Leave the `$identifier`s in `v` for review, as text. */
function reviewReads(v: Extract<Val, { k: "str" }>, m: Codemod): undefined {
  if (v.value.search(CONTENT_READ) >= 0) m.review(v.start, "This text renders as written now, `$` included; if a `$name` in it read a variable, read it with a `$var` step");
  return undefined;
}

/** The named character references v1 content was written with. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", middot: "·", bull: "•", times: "×", deg: "°", euro: "€",
};
const CHAR_REF = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;
/** A tag in text, which v1 content rendered as markup. */
const MARKUP_TAG = /<\/?[a-zA-Z][^<>]*>/;

/**
 * Content escapes its strings now, so a character reference in one would show
 * as written, and a tag as text. A reference becomes its character; a tag, or a
 * reference not known here, is left for review.
 */
function markupText(v: Extract<Val, { k: "str" }>, m: Codemod): string {
  if (MARKUP_TAG.test(v.value)) m.review(v.start, "Content escapes strings now, so this tag shows as text: write it as a `$tag` element, or wrap markup the app wrote in `$html`");
  return v.value.replace(CHAR_REF, (whole, ref: string) => {
    const code = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : ref.startsWith("#") ? Number(ref.slice(1)) : undefined;
    if (code !== undefined && code <= 0x10ffff) return String.fromCodePoint(code);
    if (ref in ENTITIES) return ENTITIES[ref];
    m.review(v.start, `\`${whole}\` shows as written now: write the character itself`);
    return whole;
  });
}

/** Whether `v` holds an element, or text with a tag in it. */
const holdsMarkup = (v: Val): boolean =>
  v.k === "obj" ? v.props.some(p => p.key === "$tag" || holdsMarkup(p.value))
  : v.k === "arr" ? v.items.some(holdsMarkup)
  : v.k === "str" && MARKUP_TAG.test(v.value);

/** `$concat` or `$join` building markup gives a plain string now, which content escapes and a response sends as text. */
function markupString({ op, obj }: Step, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  if (prop && holdsMarkup(prop.value)) {
    m.review(prop.keyStart, `\`$${op}\` builds markup as a string here, which content escapes now and a response sends as text: put the elements in a content array, or wrap markup the app wrote in \`$html\``);
  }
}

/**
 * `v`'s text as content items, its literal runs and a `$var` step for each
 * `$identifier`, or undefined when it has none. Text where a `$` follows a
 * quote is code, which interpolation garbled: it renders as written now.
 */
function contentReads(v: Extract<Val, { k: "str" }>, key: (name: string) => string, m: Codemod): string[] | undefined {
  const matches = [...v.value.matchAll(CONTENT_READ)];
  if (matches.length === 0) return undefined;
  if (matches.some(match => /["'`]/.test(v.value[match.index - 1] ?? ""))) {
    m.review(v.start, "This text renders as written now, `$` included; if a `$name` in it read a variable, read it with a `$var` step");
    return undefined;
  }
  const items: string[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.index > at) items.push(quoted(v.value.slice(at, match.index), v.quote));
    items.push(`{ ${key("$var")}: ${quoted(match[1], v.quote)} }`);
    at = match.index + match[0].length;
  }
  if (at < v.value.length) items.push(quoted(v.value.slice(at), v.quote));
  return items;
}

/** A `<style>` object's values: one `$identifier` is a `$var` step, text around one a `$concat`. */
function styleReads(v: Val, key: (name: string) => string, m: Codemod): void {
  if (v.k !== "obj" || isStep(v)) return;
  for (const p of v.props) {
    if (p.value.k !== "str") { styleReads(p.value, key, m); continue; }
    const items = contentReads(p.value, key, m);
    if (!items) continue;
    m.add({ start: p.value.start, end: p.value.end, text: items.length === 1 ? items[0] : `{ ${key("$concat")}: [${items.join(", ")}] }` });
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
 * ended them whenever a route matched, so it is left for review. A step is an
 * object now: a last step written as a plain value (`"Hello"`) is `$return`ed,
 * and one before it, which did nothing, is left for review.
 */
function listenSteps({ obj }: Step, m: Codemod): void {
  const steps = obj.props.find(p => p.key === "do");
  if (steps?.value.k !== "arr") return;
  const quoted = steps.keyQuoted;
  const wrap = (v: Val) => { if (v.k === "obj" && !isStep(v)) wrapInReturn(v, quoted, m); };
  const { items } = steps.value;
  items.forEach((item, i) => {
    if (item.k !== "str" && item.k !== "lit") return;
    if (i === items.length - 1) wrapInReturn(item, quoted, m);
    else m.review(item.start, "A step is an object now, and this plain value before the last step did nothing: remove it");
  });
  for (const item of items.slice(0, -1)) {
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

/**
 * A route tree or handler held as data, migrated without the params above it.
 * A file that is a route tree becomes a `$routes` step, the shape the schema
 * checks a tree in; the `$routes` that loaded it as data loads it as a step.
 */
function dataRoute(v: Val, m: Codemod): void {
  if (isRouteTree(v)) {
    routeTree(v, [], m);
    if (!m.isRoot(v)) return;
    m.add({ start: v.start, end: v.start, text: '{ "$routes": ' });
    m.add({ start: v.end, end: v.end, text: " }" });
    m.review(v.start, "This route tree is a `$routes` step now, which the schema checks: load it with `{ \"$file\": ... }` rather than as data with `data: true`");
  } else if (isRunHandler(v)) routeHandler(v, [], m);
}

/**
 * `{ "$routes": { "$file": path, "data": true } }` loaded a file holding a bare
 * route tree; that file is a `$routes` step now (see `dataRoute`), so the step
 * loads it as one: `{ "$file": path }`.
 */
function routesFromFile({ obj }: Step, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$routes");
  const v = prop?.value;
  if (!prop || prop.shorthand || v?.k !== "obj" || v.props.length !== 2) return;
  const file = v.props.find(p => p.key === "$file");
  const data = v.props.find(p => p.key === "data");
  if (!file || data?.value.k !== "lit" || data.value.value !== true) return;
  m.add({ start: quoteStart(prop), end: v.end, text: `${keyLike(prop, "$file")}: ${m.text(file.value.start, file.value.end)}` });
  m.review(prop.keyStart, "The route tree this loaded as data is a `$routes` step now, so it is loaded as one: check that the file holds the tree itself (the codemod wraps a file whose root is a route tree)");
}

/**
 * v1 kept `$query`'s clauses in `options`; they are the step's own siblings now.
 * Only the object's braces go, so edits inside its entries still apply. Returns
 * the clauses it moved.
 */
function hoistOptions(step: Step, m: Codemod): Prop[] {
  const options = step.obj.props.find(p => p.key === "options");
  const v = options?.value;
  if (!options) return [];
  if (v?.k !== "obj") {
    m.review(options.keyStart, "`options` is gone: its clauses (`where`, `data`, `first`, ...) are siblings of the step");
    return [];
  }
  if (v.props.length === 0) { removeSibling(step, "options", m); return []; }
  const opening = (p: Prop) => p.keyStart - (p.keyQuoted ? 1 : 0);
  m.add({ start: opening(options), end: opening(v.props[0]), text: "" });
  m.add({ start: v.props[v.props.length - 1].value.end, end: v.end, text: "" });
  return v.props;
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
  if (op === "fileStat") m.review(flag.keyStart, "`$fileStat` throws for a path that is not there, where `stat` gave null: ask `$fileExists` first if it may be missing");
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
    system: `${k("system")}: { ${k("type")}: "boolean", ${k("default")}: false, ${k("sqlDefault")}: false }`,
    created_at: `${k("created_at")}: { ${k("type")}: "string", ${k("sqlType")}: "timestamp", ${k("sqlDefault")}: "CURRENT_TIMESTAMP" }`,
  };
  const text = missing.map(name => declared[name]).join(", ");
  const last = columns[columns.length - 1];
  if (last) m.add({ start: last.value.end, end: last.value.end, text: `, ${text}` });
  else m.add({ start: properties.value.start + 1, end: properties.value.start + 1, text: ` ${text} ` });
  m.review(properties.keyStart, `v1 added ${missing.map(n => `\`${n}\``).join(" and ")} to every table it built; they are declared here now, so drop them if this table has no use for them`);
}

/**
 * A payload written with `__coalesce`: the receiver coalesces now, by its own
 * `listen`, which is usually in another template, so this is left for review.
 */
function coalesceKeys(payload: Val | undefined, m: Codemod): void {
  const flag = payload?.k === "obj" ? payload.props.find(p => p.key === "__coalesce" || p.key === "__coalesceKey") : undefined;
  if (flag) {
    m.review(flag.keyStart, "Coalescing is the receiver's now: drop `__coalesce` and `__coalesceKey`, and give the receiving `$rtc: \"listen\"` `coalesce: true`, or the name of the field to group by (what `__coalesceKey` named, or `\"type\"`)");
  }
}

/** Put `pre` before a value and `post` after it, its own text untouched, so edits inside it still apply. */
function wrapValue(v: Val, pre: string, post: string, m: Codemod): void {
  m.add({ start: v.start, end: v.start, text: pre });
  m.add({ start: v.end, end: v.end, text: post });
}

/** A key as the step writes its own: quoted in JSON, bare in a JS literal. */
const keyLike = (prop: Prop, name: string) => (prop.keyQuoted ? `"${name}"` : name);

/** v1's DOM shorthands that set or read one property: `{ "$disable": el }` is `{ "$setProp": [el, "disabled", true] }`. */
function domProp(step: Step, op: "setProp" | "getProp", prop: string, value: string | null, m: Codemod): void {
  const p = step.obj.props.find(q => q.key === "$" + step.op);
  if (!p || p.shorthand) return;
  renameOp(step, op, m);
  wrapValue(p.value, "[", `, "${prop}"${value === null ? "" : `, ${value}`}]`, m);
}

/** v1's `[el, value]` setters: `{ "$setText": [el, t] }` is `{ "$setProp": [el, "textContent", t] }`. */
function domSetter(step: Step, prop: string, m: Codemod): void {
  const p = step.obj.props.find(q => q.key === "$" + step.op);
  if (!p || p.shorthand) return;
  if (p.value.k !== "arr" || p.value.items.length !== 2) {
    m.review(p.keyStart, `\`$${step.op}\` is gone: \`{ "$setProp": [element, "${prop}", value] }\` sets it`);
    return;
  }
  renameOp(step, "setProp", m);
  m.add({ start: p.value.items[1].start, end: p.value.items[1].start, text: `"${prop}", ` });
}

/** v1's `showAll`/`hideAll`: each match of the selector, by `$foreach`. */
function eachMatch(step: Step, op: "show" | "hide", m: Codemod): void {
  const p = step.obj.props.find(q => q.key === "$" + step.op);
  if (!p || p.shorthand) return;
  renameOp(step, "foreach", m);
  wrapValue(p.value, `{ ${keyLike(p, "$querySelectorAll")}: `, ` }, ${keyLike(p, "do")}: { ${keyLike(p, `$${op}`)}: { ${keyLike(p, "$var")}: "item" } }`, m);
  const as = step.obj.props.find(q => q.key === "$as");
  if (as) m.review(as.keyStart, `\`$${step.op}\` returned how many matched; \`$foreach\` returns the last: count with \`{ "$count": { "$querySelectorAll": ... } }\``);
}

/** The value a value-mode step names, when it is written as a literal. */
const opValue = ({ op, obj }: Step) => {
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  return value?.k === "str" ? value.value : undefined;
};

/**
 * An iterator's `do` runs as steps, so an array there is a step sequence rather
 * than the array it used to build. `[{ "$return": [...] }]` builds it as before:
 * a sequence of one step, which ends the sequence with that value, and is left
 * as it is. An array whose items write with `$as` reads as steps already, so it
 * is left for review rather than kept as the array it built.
 */
function arrayDoAsReturn({ op, obj }: Step, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "do");
  const v = prop?.value;
  if (!prop || v?.k !== "arr") return;
  if (v.items.length === 1 && v.items[0].k === "obj" && v.items[0].props.some(p => p.key === "$return")) return;
  if (v.items.some(it => it.k === "obj" && it.props.some(p => p.key === "$as"))) {
    m.review(prop.keyStart, `\`$${op}\`'s \`do\` runs as steps now: this array was resolved as a literal, each item in parallel, so check it gives what the steps should, the last step's value being the result`);
    return;
  }
  m.add({ start: v.start, end: v.start, text: `[{ ${prop.keyQuoted ? '"$return"' : "$return"}: ` });
  m.add({ start: v.end, end: v.end, text: " }]" });
}

/** The iterators that bound v1's `loop`, by their v1 names. */
const LOOP_OPS = new Set(["map", "filter", "find", "reduce", "foreach", "mapValues"]);

/** `loop` reads an iterator rewrote, which the `var` rule then leaves alone. */
const loopRetargeted = new WeakSet<Val>();

/**
 * v1's iterators bound `loop` (`item`, `index`, `key`, `first`, `last`,
 * `length`) beside the item; v2 binds the item and index under the names the
 * step gives them. A read of `loop.item`, `loop.index` or `loop.key` in the
 * iterator's own template reads that name now. A nested iterator binds its own
 * `loop`, so the walk stops there; `first`, `last` and `length` are left to the
 * `var` rule's review.
 */
function loopReads({ op, obj }: Step, m: Codemod): void {
  const named = (key: string, fallback: string) => {
    const v = obj.props.find(p => p.key === key)?.value;
    return v?.k === "str" ? v.value : fallback;
  };
  const index = op === "foreach" ? named("key", named("index", "index")) : named("index", "index");
  const to: Record<string, string> = { item: named("item", "item"), index, key: op === "mapValues" ? "key" : index };
  const value = obj.props.find(p => p.key === "$" + op)?.value;
  const template = obj.props.find(p => p.key === "do")?.value ?? (value?.k === "arr" ? value.items[1] : undefined);
  const walk = (x: Val | undefined): void => {
    if (x?.k === "arr") x.items.forEach(walk);
    if (x?.k !== "obj") return;
    if (x.props.some(p => p.key.startsWith("$") && LOOP_OPS.has(p.key.slice(1)))) return;
    for (const p of x.props) {
      const read = p.key === "$var" && p.value.k === "str" ? /^loop\.(item|index|key)(?=\.|$)(.*)$/.exec(p.value.value) : null;
      if (read) { replaceString(p.value as Extract<Val, { k: "str" }>, to[read[1]] + read[2], m); loopRetargeted.add(p.value); }
      else walk(p.value);
    }
  };
  walk(template);
}

/** `$match` steps a `$first` or `$index` rewrote into a `capture`, which the `match` rule then leaves alone. */
const captured = new WeakSet<Val>();

/**
 * `{ "$first": <match> }` and `{ "$index": [<match>, n] }` picked from the
 * match array v1's `$match` returned without `g`: the whole match, or group n.
 * That is `capture` now, so the wrapper goes and the `$match` takes its place.
 * A `g` match returned every match's text, which `$first` still picks from, so
 * it is left to the `match` rule.
 */
function pickCapture({ op, obj }: Step, inner: Val | undefined, group: number, m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  if (!prop || inner?.k !== "obj" || inner.props.some(p => p.key === "all" || p.key === "capture")) return;
  const match = inner.props.find(p => p.key === "$match");
  const pattern = match?.value.k === "arr" ? match.value.items[1] : undefined;
  if (!match || (pattern?.k === "str" && /^\/.+\/[a-z]*g[a-z]*$/.test(pattern.value))) return;
  const p = v1Pattern({ op: "match", obj: inner }, m);
  const key = (name: string) => (match.keyQuoted ? `"${name}"` : name);
  const opening = (x: Prop) => x.keyStart - (x.keyQuoted ? 1 : 0);
  m.add({ start: opening(prop), end: opening(inner.props[0]), text: "" });
  m.add({ start: inner.props[inner.props.length - 1].value.end, end: prop.value.end, text: [...(p?.siblings ?? []), `${key("capture")}: ${group}`].map(s => ", " + s).join("") });
  captured.add(inner);
}

/** A string v1 read as a regular expression: `/source/flags`. */
const V1_REGEX = /^\/(.+)\/([a-z]*)$/;

/**
 * A literal `/source/flags` pattern in slot 1 as v2 writes it: the bare source,
 * with `regex: true` and the flags beside it, or plain text when the source has
 * no metacharacter and there are no flags. `g` is gone from the flags; what it
 * meant is returned for the op to place. Returns null when the slot is not such
 * a literal, and leaves flags v2 has no use for to review.
 */
function v1Pattern({ op, obj }: Step, m: Codemod): { global: boolean; siblings: string[] } | null {
  const prop = obj.props.find(p => p.key === "$" + op);
  const pattern = prop?.value.k === "arr" ? prop.value.items[1] : undefined;
  const parsed = pattern?.k === "str" ? V1_REGEX.exec(pattern.value) : null;
  if (!prop || pattern?.k !== "str" || !parsed || obj.props.some(p => p.key === "regex" || p.key === "flags")) return null;
  const [, source, flagsIn] = parsed;
  const flags = flagsIn.replace("g", "");
  if (/[^imsuv]/.test(flags)) {
    m.review(pattern.start, `\`${pattern.value}\` is literal text now: write the bare pattern with \`regex: true\`; v2 takes the flags \`i\`, \`m\`, \`s\`, \`u\` and \`v\``);
    return null;
  }
  const key = (name: string) => (prop.keyQuoted ? `"${name}"` : name);
  replaceString(pattern, source, m);
  const isRegex = op === "match" || flags !== "" || /[\\^$.*+?()[\]{}|]/.test(source);
  const siblings = [
    ...(isRegex && op !== "match" ? [`${key("regex")}: true`] : []),
    ...(flags ? [`${key("flags")}: "${flags}"`] : []),
  ];
  return { global: flagsIn.includes("g"), siblings };
}

/** Siblings written after a step's value. */
function addSiblings({ op, obj }: Step, siblings: string[], m: Codemod): void {
  const prop = obj.props.find(p => p.key === "$" + op);
  if (prop && siblings.length > 0) m.add({ start: prop.value.end, end: prop.value.end, text: ", " + siblings.join(", ") });
}

/** The v2 rewrites, by the op they apply to. */
const RULES: Record<string, Rule> = {
  // A `/source/flags` string is literal text now; a regular expression is opted
  // into with `regex: true`. v1 replaced only the first match of one without `g`.
  replace: (step, m) => {
    const p = v1Pattern(step, m);
    if (!p) return;
    const all = step.obj.props.some(q => q.key === "all");
    const key = step.obj.props.find(q => q.key === "$replace")!.keyQuoted ? '"all"' : "all";
    addSiblings(step, [...p.siblings, ...(p.global || all ? [] : [`${key}: false`])], m);
  },
  split: (step, m) => { const p = v1Pattern(step, m); if (p) addSiblings(step, p.siblings, m); },
  contains: (step, m) => { const p = v1Pattern(step, m); if (p) addSiblings(step, p.siblings, m); },
  // `$match` returns a match object now; `g` returned every match's text.
  match: (step, m) => {
    const prop = step.obj.props.find(q => q.key === "$match")!;
    if (captured.has(step.obj) || step.obj.props.some(q => q.key === "all" || q.key === "capture")) return;
    const p = v1Pattern(step, m);
    const key = (name: string) => (prop.keyQuoted ? `"${name}"` : name);
    if (p?.global) {
      addSiblings(step, [...p.siblings, `${key("all")}: true`, `${key("capture")}: 0`], m);
      return;
    }
    if (p) addSiblings(step, p.siblings, m);
    m.review(prop.keyStart, "`$match` returns `{ match, index, captures, groups }` or null now, not the match array: `\"capture\": n` gives group n's text (`0` the whole match)");
  },
  // The per-item template is a `do` sibling, as on `map` and `foreach`, and the
  // reducer's start an `initial` one.
  filter: (step, m) => { loopReads(step, m); tupleToSiblings(step, ["do"], m); arrayDoAsReturn(step, m); },
  find: (step, m) => { loopReads(step, m); tupleToSiblings(step, ["do"], m); arrayDoAsReturn(step, m); },
  reduce: (step, m) => { loopReads(step, m); tupleToSiblings(step, ["do", "initial"], m); arrayDoAsReturn(step, m); },
  map: (step, m) => { loopReads(step, m); arrayDoAsReturn(step, m); },
  mapValues: (step, m) => { loopReads(step, m); arrayDoAsReturn(step, m); },
  // The index variable is named by `index`, as on the array ops.
  foreach: (step, m) => { loopReads(step, m); renameSibling(step, "key", "index", m); },
  // Picking from a match array is a `capture` of the match now.
  first: (step, m) => pickCapture(step, step.obj.props.find(p => p.key === "$first")?.value, 0, m),
  index: (step, m) => {
    const v = step.obj.props.find(p => p.key === "$index")?.value;
    const n = v?.k === "arr" && v.items.length === 2 && v.items[1].k === "lit" ? v.items[1].value : undefined;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) pickCapture(step, v!.k === "arr" ? v!.items[0] : undefined, n, m);
  },
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
    // The haystack moves in front of the needle, which stays where it is, so an
    // edit another rule makes inside the needle (a retargeted read) still applies.
    const isLiteral = (item: Val): boolean => item.k === "str" || item.k === "lit" || (item.k === "arr" && item.items.every(isLiteral));
    const [needle, haystack] = v?.k === "arr" && v.items.length === 2 ? v.items : [];
    if (!needle || !haystack || !isPlain(needle) || (haystack.k !== "arr" && haystack.k !== "str") || !isLiteral(haystack)) {
      m.review(prop.keyStart, "`$in` is gone: `[needle, haystack]` is `$includes` with `[haystack, needle]` for an array, `$contains` with `[haystack, needle]` for a string, or `$includes` with `[{ \"$keys\": haystack }, needle]` for an object's keys");
      return;
    }
    renameOp(step, haystack.k === "arr" ? "includes" : "contains", m);
    m.add({ start: needle.start, end: needle.start, text: `${m.text(haystack.start, haystack.end)}, ` });
    m.add({ start: needle.end, end: haystack.end, text: "" });
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
  // Content renders its strings as written, and `raw` is `translate: "no"`.
  tag: ({ obj }, m) => {
    elementContent(obj, m);
    eventScopes(obj, m);
  },
  concat: markupString,
  join: markupString,
  // A request's response is what its steps yield.
  listen: listenSteps,
  // Handlers run `do`, and read params from `request.params`.
  routes: (step, m) => {
    const tree = step.obj.props.find(p => p.key === "$routes")?.value;
    if (tree) routeTree(tree, [], m);
    routesFromFile(step, m);
  },
  // A connection's handlers: `on-connect` is `onOpen`, and its id is `id`.
  "socket-accept": (step, m) => {
    renameSibling(step, "on-connect", "onOpen", m);
    handlerReads(step, { wsId: "id" }, m);
  },
  // Client handlers read what they are handed by its role, as the server's do.
  "ws-connect": (step, m) => handlerReads(step, { wsMessage: "message", wsCode: "code", wsReason: "reason", wsClean: "clean" }, m),
  "collision-on": collisionRuns,
  collisionOn: collisionRuns,
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
    // v1 gave a request that never completed `null`, or with `full` a response
    // with `status: 0`, which a catch gets no `response` for: it stands one in.
    const full = step.obj.props.find(p => p.key === "full");
    const q = prop.keyQuoted ? '"' : "";
    const read = (path: string) => `{ ${q}$var${q}: "${path}" }`;
    const url = step.obj.props.find(p => p.key === "$fetch")?.value;
    const failed = `{ ${q}status${q}: 0, ${q}ok${q}: false, ${q}headers${q}: {}, ${q}body${q}: null${url?.k === "str" ? `, ${q}url${q}: ${m.text(url.start, url.end)}` : ""} }`;
    const caught = full?.value.k === "lit" && full.value.value === true
      ? `{ ${q}$coalesce${q}: [${read("response")}, ${failed}] }`
      : `{ ${q}$coalesce${q}: [${read("response.body")}, null] }`;
    m.add({ start: prop.keyStart, end: prop.value.end, text: `$catch${q}: [${caught}]` });
  },
  // Storage reads like the cache: `storageSet` takes `value`, and removing is `storageDelete`.
  "storage-set": (step, m) => tupleToSiblings(step, ["value"], m),
  "storage-remove": (step, m) => renameOp(step, "storageDelete", m),
  // A level's name and value are its two operands.
  "audio-volume": (step, m) => siblingToTuple(step, "volume", m),
  // v1's DOM shorthands compose from the property, query and placement ops now.
  enable: (step, m) => domProp(step, "setProp", "disabled", "false", m),
  disable: (step, m) => domProp(step, "setProp", "disabled", "true", m),
  getValue: (step, m) => domProp(step, "getProp", "value", null, m),
  setValue: (step, m) => domSetter(step, "value", m),
  setHtml: (step, m) => domSetter(step, "innerHTML", m),
  setText: (step, m) => domSetter(step, "textContent", m),
  removeEl: (step, m) => renameOp(step, "removeElement", m),
  showAll: (step, m) => eachMatch(step, "show", m),
  hideAll: (step, m) => eachMatch(step, "hide", m),
  getElementById: (step, m) => {
    const p = step.obj.props.find(q => q.key === "$getElementById");
    if (!p || p.shorthand) return;
    renameOp(step, "querySelector", m);
    if (p.value.k === "str" && /^[A-Za-z][\w-]*$/.test(p.value.value)) replaceString(p.value, "#" + p.value.value, m);
    else {
      wrapValue(p.value, `{ ${keyLike(p, "$concat")}: ["#", `, "] }", m);
      m.review(p.keyStart, "`$getElementById` is `$querySelector` with `#` and the id: one with characters CSS gives a meaning to needs escaping");
    }
  },
  scrollTo: (step, m) => {
    const p = step.obj.props.find(q => q.key === "$scrollTo");
    if (!p || p.shorthand) return;
    if (!isPlain(p.value)) {
      m.review(p.keyStart, "`$scrollTo` is gone: `{ \"$setProp\": [el, \"scrollTop\", { \"$getProp\": [el, \"scrollHeight\"] }] }` scrolls to the bottom");
      return;
    }
    renameOp(step, "setProp", m);
    wrapValue(p.value, "[", `, "scrollTop", { ${keyLike(p, "$getProp")}: [${m.text(p.value.start, p.value.end)}, "scrollHeight"] }]`, m);
  },
  append: (step, m) => {
    const p = step.obj.props.find(q => q.key === "$append");
    if (!p || p.shorthand) return;
    renameOp(step, "insertHtml", m);
    m.review(p.keyStart, "`$append` is `$insertHtml`, which does not scroll: to keep a log at its bottom, follow it with `{ \"$setProp\": [el, \"scrollTop\", { \"$getProp\": [el, \"scrollHeight\"] }] }`");
  },
  submit: ({ obj }, m) => {
    const p = obj.props.find(q => q.key === "$submit");
    if (p?.value.k === "str" && p.value.value === "form") {
      m.add({ start: p.value.start, end: p.value.end, text: `{ ${keyLike(p, "$closest")}: [{ ${keyLike(p, "$var")}: "target" }, "form"] }` });
    }
  },
  copy: (step, m) => renameOp(step, "clipboardWrite", m),
  getClipboard: (step, m) => renameOp(step, "clipboardRead", m),
  // Coalescing is the receiver's `coalesce` on `listen`, not keys in the payload.
  "rtc-send": (step, m) => coalesceKeys(step.obj.props.find(p => p.key === "data")?.value, m),
  "rtc-broadcast": (step, m) => coalesceKeys(step.obj.props.find(p => p.key === "$rtc-broadcast")?.value, m),
  // `close-all` is `closeAll`, as every other value-mode op names its operations.
  rtc: (step, m) => {
    handlerReads(step, { rtcSignal: "signal", rtcPeerId: "peer", rtcInbound: "inbound", rtcMessage: "message", rtcChannel: "channel" }, m);
    const value = step.obj.props.find(p => p.key === "$rtc")?.value;
    if (value?.k === "str" && value.value === "close-all") replaceString(value, "closeAll", m);
  },
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
  // The report's `response` is `reply`, so returning it from a route sends it as data.
  email: ({ obj }, m) => {
    const as = obj.props.find(p => p.key === "$as");
    if (as) m.review(as.keyStart, "`$email`'s report names the server's reply `reply`, no longer `response`: read it under the new name");
    // `html` escapes a string now: markup written here is the app's own, so it is trusted as written.
    const html = obj.props.find(p => p.key === "html");
    if (html?.value.k === "str") wrapValue(html.value, `{ ${keyLike(html, "$html")}: `, " }", m);
    else if (html && !holdsMarkup(html.value)) m.review(html.keyStart, "`$email`'s `html` escapes a string now: build it with `$tag`, or wrap markup the app wrote in `$html`");
  },
  defer: ({ obj }, m) => {
    const delay = obj.props.find(p => p.key === "delay");
    if (delay) m.review(delay.keyStart, "`$defer`'s `delay` is gone: start the deferred steps with `{ \"$sleep\": <ms> }`");
  },
  // Each row operation is an op valued by its table (`$querySelect`, ...);
  // creating, altering and dropping a table are the table ops' (`$tableSync`,
  // valued by what `schema` gave, `$tableAlter`, `$tableDrop`); and the
  // connection is `connection`.
  query: (step, m) => {
    const clauses = [...step.obj.props, ...hoistOptions(step, m)];
    const where = clauses.find(p => p.key === "where");
    if (where) whereOperators(where.value, m);
    renameSibling(step, "database", "connection", m);
    const concat = clauses.find(p => p.key === "group_concat");
    if (concat) m.add({ start: concat.keyStart, end: concat.keyEnd, text: "groupConcat" });
    const value = opValue(step);
    if (value === "update" && !where) {
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
  // A random hex token is core's `$randomString`, counted in characters, two per byte.
  randomHex: (step, m) => {
    const prop = step.obj.props.find(p => p.key === "$randomHex");
    if (!prop || prop.shorthand) return;
    const v = prop.value;
    const bytes = v.k === "lit" && v.value === null ? 32
      : v.k === "lit" && typeof v.value === "number" ? v.value
      : v.k === "str" && /^\d+$/.test(v.value) ? Number(v.value)
      : undefined;
    if (bytes === undefined) {
      m.review(prop.keyStart, "`$randomHex` is gone: `{ \"$randomString\": <twice the bytes>, \"chars\": \"0123456789abcdef\" }` makes the same token");
      return;
    }
    renameOp(step, "randomString", m);
    m.add({ start: v.start, end: v.end, text: String(bytes * 2) });
    m.add({ start: v.end, end: v.end, text: `, ${prop.keyQuoted ? '"chars"' : "chars"}: "0123456789abcdef"` });
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
    if (path?.k === "str" && !loopRetargeted.has(path) && /^loop(\.|$)/.test(path.value)) {
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
  // `$setVars` with `data: true` stores its values as written, mostly steps kept
  // for `$runVar` or a route tree, so each is walked as an expression: data
  // holding no op passes through as it is.
  const rawValues = op === "setVars" && v.props.some(p => p.key === "data" && p.value.k === "lit" && p.value.value === true);
  const stored = v.props.find(p => p.key === "$setVars")?.value;
  if (rawValues && stored?.k === "obj") for (const p of stored.props) m.walk(ANY, p.value);
  for (const p of v.props) {
    const owned = p.key.startsWith("$") ? p.key.slice(1) : null;
    if (owned !== null && GLOBALS.has(owned)) m.walk(owned === "then" || owned === "catch" ? STEPS : ANY, p.value);
    else if (op === undefined) m.walk(ANY, p.value);
    else if (owned === op) { if (!rawValues) m.walk(C.vp[op] ?? m.siblingSchema(op, p.key), p.value); }
    else m.walk(m.siblingSchema(op, p.key), p.value);
  }
}

run(m, args.filter(a => !a.startsWith("--schema=")));
