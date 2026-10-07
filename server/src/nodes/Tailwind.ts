import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, resolve, resolveAll, isObject } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

const execAsync = promisify(exec);

const tempDir = "temp";
const inputCss = "src/input.css";
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

export class TailwindNode extends Node {
  /** The classes this resolver has registered. An instance field, so one
   *  resolver's registry is never built into another's stylesheet. */
  private readonly registry = new Set<string>();

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
      markdownDescription: "Extracts Tailwind class names from JSON templates and compiles CSS. The operation is the primary value.",
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
          markdownDescription: "Compiles the registered classes and returns the CSS (`\"\"` when none are registered). A failed compile throws.",
        },
        build: {
          output: "null",
          markdownDescription: "Registers classes from `data`, then writes the stylesheet. A failed build throws.",
          siblings: {
            data: { description: "JSON template to extract classes from." },
            content: { type: "string", description: "Glob pattern for additional content sources." },
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
          return doAdd(this.registry, def, context);
        case "compile":
          return compile([...this.registry]);
        case "build":
          return doBuild(this.registry, def, context);
        case "clear":
          this.registry.clear();
          return null;
        case "classes":
          return [...this.registry];
        default:
          console.error(`[Tailwind] Unknown operation: ${operation}`);
          return null;
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

/** Write the stylesheet for `classes`, plus whatever `contentGlob` matches. */
async function buildStylesheet(classes: string[], contentGlob?: string): Promise<void> {
  console.log(`[Tailwind] Building CSS...`);

  await fs.mkdir(tempDir, { recursive: true });

  const contentParts: string[] = [];

  if (classes.length > 0) {
    const html = classes.map((c) => `<div class="${c}"></div>`).join("\n");
    const contentFile = path.join(tempDir, "tw-content.html");
    await fs.writeFile(contentFile, html);
    contentParts.push(contentFile);
  }

  if (contentGlob) {
    contentParts.push(contentGlob);
  }

  if (contentParts.length === 0) {
    console.log("[Tailwind] No content sources, skipping");
    return;
  }

  try {
    const contentArg = contentParts.map((p) => `"${p}"`).join(",");
    await execAsync(
      `npx @tailwindcss/cli -i ${inputCss} -o ${outputCss} --content ${contentArg}`,
      { timeout: 60000 },
    );
    console.log(`[Tailwind] CSS written to ${outputCss}`);
  } catch (error) {
    console.error("[Tailwind] Build failed:", error);
    throw error;
  }
}

function doExtract(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.data, context, data => (data ? extractClasses(data) : []));
}

function doAdd(registry: Set<string>, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.classes ?? null, def.data ?? null], context, ([classesRaw, dataRaw]) => {
    let classes: string[] = [];

    if (def.classes && Array.isArray(classesRaw)) {
      classes = classesRaw.map(String);
    }

    if (def.data && dataRaw) {
      classes.push(...extractClasses(dataRaw));
    }

    for (const cls of classes) registry.add(cls);
    return null;
  });
}

function doBuild(registry: Set<string>, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.data ?? null, def.content ?? null], context, async ([dataRaw, contentRaw]) => {
    if (def.data && dataRaw) {
      for (const cls of extractClasses(dataRaw)) {
        registry.add(cls);
      }
    }

    const contentGlob = def.content && contentRaw != null ? String(contentRaw) : undefined;

    await buildStylesheet([...registry], contentGlob);
    return null;
  });
}

async function compile(classes: string[]): Promise<string> {
  if (classes.length === 0) return "";

  await fs.mkdir(tempDir, { recursive: true });

  const content = classes.map((c) => `<div class="${c}"></div>`).join("\n");
  const contentFile = path.join(tempDir, "tw-content.html");
  await fs.writeFile(contentFile, content);

  const outputFile = path.join(tempDir, "tw-output.css");

  await execAsync(
    `npx tailwindcss -i ${inputCss} -o ${outputFile} --content ${contentFile} --minify`,
    { timeout: 30000 },
  );
  return fs.readFile(outputFile, "utf-8");
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
    if (isObject(value.attrs) && "class" in value.attrs) extractFromClass(value.attrs.class, classes);
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
