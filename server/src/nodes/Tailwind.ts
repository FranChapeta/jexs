import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, loggerFor, resolve, resolveAll, isObject } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

const inputCss = "input.css";
const outputCss = "public/styles.css";

const PREFIXES = [
  "text-", "bg-", "border-", "ring-", "shadow-",
  "p-", "px-", "py-", "pt-", "pr-", "pb-", "pl-",
  "m-", "mx-", "my-", "mt-", "mr-", "mb-", "ml-",
  "w-", "h-", "min-", "max-",
  "flex", "grid", "block", "inline", "hidden",
  "items-", "justify-", "gap-", "space-",
  "rounded", "font-", "leading-", "tracking-",
  "overflow-", "z-", "opacity-",
  "transition", "duration-", "ease-",
  "cursor-", "select-", "resize-",
  "sr-", "not-sr-",
  "hover:", "focus:", "active:", "disabled:",
  "sm:", "md:", "lg:", "xl:", "2xl:", "dark:",
];

const STANDALONE_CLASSES = [
  "container", "prose", "sr-only", "not-sr-only",
  "antialiased", "truncate",
  "uppercase", "lowercase", "capitalize",
  "underline", "line-through", "no-underline",
  "visible", "invisible", "collapse",
  "static", "fixed", "absolute", "relative", "sticky",
  "inset", "top", "right", "bottom", "left",
];

/** Turns class names into a minified stylesheet. */
interface TailwindCompiler {
  build(candidates: string[]): string;
}

/**
 * A resolver's Tailwind state: the classes it registered, its compiler once a
 * stylesheet is first asked for, and the stylesheet for the classes as they
 * stand, dropped whenever they change. Held by the node instance, so one
 * resolver's classes never reach another's stylesheet.
 */
interface TailwindState {
  readonly registry: Set<string>;
  compiler: Promise<TailwindCompiler> | null;
  css: string | null;
}

export class TailwindNode extends Node {
  private readonly state: TailwindState = { registry: new Set(), compiler: null, css: null };

  static schema: JexsNodeSchema = {
    tailwind: {
      type: "string",
      enum: [
        "extract",
        "add",
        "compile",
        "build",
        "clear",
        "classes",
      ],
      markdownDescription: "Extracts Tailwind class names from JSON templates and compiles them to CSS in process with Tailwind v4 (`tailwindcss` and `@tailwindcss/node` installed), starting from the project's `input.css`. The compiler loads on the first `compile` or `build` and the stylesheet is kept until the registered classes change. The operation is the primary value.",
      examples: [
        "{ \"$tailwind\": \"build\", \"data\": { \"$var\": \"template\" } }",
      ],
      variants: {
        extract: {
          output: { type: "array", items: { type: "string" } },
          markdownDescription: "Returns the Tailwind classes found in `data`, without registering them.",
          siblings: {
            data: { description: "JSON template to extract classes from." },
          },
        },
        add: {
          output: "null",
          markdownDescription: "Registers classes from `data` and/or an explicit `classes` list.",
          siblings: {
            data: { description: "JSON template to extract classes from." },
            classes: {
              type: "array",
              items: { type: "string" },
              description: "Explicit class names to register.",
            },
          },
        },
        compile: {
          output: "string",
          markdownDescription: "Compiles the registered classes and returns the minified CSS (`\"\"` when none are registered). A failed compile throws.",
        },
        build: {
          output: "null",
          markdownDescription: "Registers classes from `data`, then writes the minified stylesheet to `public/styles.css`. A failed build throws.",
          siblings: {
            data: { description: "JSON template to extract classes from." },
          },
        },
        clear: {
          output: "null",
          markdownDescription: "Clears the class registry.",
        },
        classes: {
          output: { type: "array", items: { type: "string" } },
          markdownDescription: "Returns the registered class names as an array.",
        },
      },
    },
  };

  tailwind(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$tailwind, context, operation => {
      switch (String(operation)) {
        case "extract":
          return doExtract(def, context);
        case "add":
          return doAdd(this.state, def, context);
        case "compile":
          return this.state.registry.size === 0 ? "" : stylesheet(this.state);
        case "build":
          return doBuild(this.state, def, context);
        case "clear":
          this.state.registry.clear();
          this.state.css = null;
          return null;
        case "classes":
          return [...this.state.registry];
        default:
          throw new Error(`$tailwind: unknown operation ${JSON.stringify(operation)}`);
      }
    });
  }

}

/** The Tailwind classes a template uses, from its `class` values. */
function extractClasses(json: unknown): string[] {
  const classes = new Set<string>();
  traverse(json, classes);
  return [...classes];
}

/**
 * Load Tailwind v4 in process and compile the project's `input.css` once, the
 * way the official Vite and PostCSS integrations do: after that, each stylesheet
 * is a `build` over the class names, a few milliseconds with no child process.
 * Imported on first use, so a resolver that never compiles never loads it.
 */
async function loadCompiler(): Promise<TailwindCompiler> {
  let tailwind: typeof import("@tailwindcss/node");
  try {
    tailwind = await import("@tailwindcss/node");
  } catch (err) {
    if (isObject(err) && err.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("$tailwind needs Tailwind v4: npm i -D tailwindcss @tailwindcss/node", { cause: err });
    }
    throw err;
  }
  const input = path.resolve(inputCss);
  const compiler = await tailwind.compile(await fs.readFile(input, "utf-8"), {
    base: path.dirname(input),
    onDependency: () => {},
  });
  return { build: candidates => tailwind.optimize(compiler.build(candidates), { minify: true }).code };
}

/** The resolver's compiler, loaded on the first call; a failed load is retried on the next. */
function compilerFor(state: TailwindState): Promise<TailwindCompiler> {
  state.compiler ??= loadCompiler().catch(err => {
    state.compiler = null;
    throw err;
  });
  return state.compiler;
}

/** The stylesheet for the registered classes, built once per set of classes. */
async function stylesheet(state: TailwindState): Promise<string> {
  if (state.css !== null) return state.css;
  const compiler = await compilerFor(state);
  // Built after the await, from the classes as they stand then, so the result is never stale.
  state.css = compiler.build([...state.registry]);
  return state.css;
}

/** Add classes to the registry, dropping the kept stylesheet when any is new. */
function register(state: TailwindState, classes: Iterable<string>): void {
  const before = state.registry.size;
  for (const cls of classes) state.registry.add(cls);
  if (state.registry.size !== before) state.css = null;
}

function doExtract(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.data, context, data => (data ? extractClasses(data) : []));
}

function doAdd(state: TailwindState, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.classes ?? null, def.data ?? null], context, ([classesRaw, dataRaw]) => {
    if (def.classes && Array.isArray(classesRaw)) register(state, classesRaw.map(String));
    if (def.data && dataRaw) register(state, extractClasses(dataRaw));
    return null;
  });
}

function doBuild(state: TailwindState, def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.data ?? null, context, async dataRaw => {
    if (def.data && dataRaw) register(state, extractClasses(dataRaw));
    if (state.registry.size === 0) {
      loggerFor(context).info("[tailwind] No classes registered, skipping");
      return null;
    }
    await fs.mkdir(path.dirname(outputCss), { recursive: true });
    await fs.writeFile(outputCss, await stylesheet(state));
    loggerFor(context).info(`[tailwind] CSS written to ${outputCss}`);
    return null;
  });
}

function traverse(value: unknown, classes: Set<string>): void {
  if (typeof value === "string") {
    extractFromString(value, classes);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) traverse(item, classes);
    return;
  }

  if (isObject(value)) {
    if ("class" in value) extractFromClass(value.class, classes);
    for (const v of Object.values(value)) traverse(v, classes);
  }
}

function extractFromClass(value: unknown, classes: Set<string>): void {
  if (typeof value === "string") {
    for (const cls of value.split(/\s+/)) {
      if (isTailwindClass(cls)) classes.add(cls);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && isTailwindClass(item)) classes.add(item);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const cls of Object.keys(value)) {
      if (isTailwindClass(cls)) classes.add(cls);
    }
  }
}

function extractFromString(str: string, classes: Set<string>): void {
  const pattern =
    /(?:(?:sm|md|lg|xl|2xl|dark|hover|focus|active|disabled|group-hover):)*[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\[[^\]]+\])?/g;
  const matches = str.match(pattern);
  if (matches) {
    for (const match of matches) {
      if (isTailwindClass(match)) classes.add(match);
    }
  }
}

function isTailwindClass(str: string): boolean {
  if (!str || str.length < 2) return false;
  for (const prefix of PREFIXES) {
    if (str.startsWith(prefix) || str === prefix.slice(0, -1)) return true;
  }
  return STANDALONE_CLASSES.includes(str);
}
