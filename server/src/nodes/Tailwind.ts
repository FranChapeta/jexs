import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, resolve, resolveAll } from "@jexs/core";

const execAsync = promisify(exec);

// Module-level state
const classRegistry: Set<string> = new Set();
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

/**
 * TailwindNode - Process templates and compile Tailwind CSS.
 *
 * { "tailwind": "extract", "data": {...} }
 * { "tailwind": "add", "data": {...} }
 * { "tailwind": "add", "classes": ["bg-red-500"] }
 * { "tailwind": "compile" }
 * { "tailwind": "build" }
 * { "tailwind": "clear" }
 * { "tailwind": "classes" }
 */
export class TailwindNode extends Node {
  /**
   * Extracts Tailwind class names from JSON templates and compiles CSS.
   * Operations: `"extract"`, `"add"`, `"compile"`, `"build"`, `"clear"`, `"classes"`.
   *
   * @example
   * { "tailwind": "build", "data": { "var": "$template" } }
   */
  tailwind(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.tailwind, context, operation => {
      switch (String(operation)) {
        case "extract":
          return doExtract(def, context);
        case "add":
          return doAdd(def, context);
        case "compile":
          return doCompile();
        case "build":
          return doBuild(def, context);
        case "clear":
          classRegistry.clear();
          return { cleared: true };
        case "classes":
          return [...classRegistry];
        default:
          console.error(`[Tailwind] Unknown operation: ${operation}`);
          return null;
      }
    });
  }

  // Public static API

  static extractClasses(json: unknown): string[] {
    const classes = new Set<string>();
    traverse(json, classes);
    return [...classes];
  }

  static async build(classes: string[], contentGlob?: string): Promise<void> {
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
}

function doExtract(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.data, context, data => {
    if (!data) return { classes: [] };
    return { classes: TailwindNode.extractClasses(data) };
  });
}

function doAdd(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.classes ?? null, def.data ?? null], context, ([classesRaw, dataRaw]) => {
    let classes: string[] = [];

    if (def.classes && Array.isArray(classesRaw)) {
      classes = classesRaw.map(String);
    }

    if (def.data && dataRaw) {
      classes.push(...TailwindNode.extractClasses(dataRaw));
    }

    const before = classRegistry.size;
    for (const cls of classes) classRegistry.add(cls);
    const after = classRegistry.size;

    return { added: after - before, total: after };
  });
}

async function doCompile(): Promise<unknown> {
  const classes = [...classRegistry];
  const css = await compile(classes);
  return { css, classes: classes.length };
}

function doBuild(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.data ?? null, def.content ?? null], context, async ([dataRaw, contentRaw]) => {
    if (def.data && dataRaw) {
      for (const cls of TailwindNode.extractClasses(dataRaw)) {
        classRegistry.add(cls);
      }
    }

    const contentGlob = def.content && contentRaw != null ? String(contentRaw) : undefined;

    await TailwindNode.build([...classRegistry], contentGlob);
    return { built: true, classes: classRegistry.size };
  });
}

async function compile(classes: string[]): Promise<string> {
  if (classes.length === 0) return "";

  await fs.mkdir(tempDir, { recursive: true });

  const content = classes.map((c) => `<div class="${c}"></div>`).join("\n");
  const contentFile = path.join(tempDir, "tw-content.html");
  await fs.writeFile(contentFile, content);

  const outputFile = path.join(tempDir, "tw-output.css");

  try {
    await execAsync(
      `npx tailwindcss -i ${inputCss} -o ${outputFile} --content ${contentFile} --minify`,
      { timeout: 30000 },
    );
    return await fs.readFile(outputFile, "utf-8");
  } catch (error) {
    console.error("[Tailwind] Compilation failed:", error);
    return "";
  }
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

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    if ("class" in obj) extractFromClass(obj.class, classes);

    if ("attrs" in obj && typeof obj.attrs === "object" && obj.attrs !== null) {
      const attrs = obj.attrs as Record<string, unknown>;
      if ("class" in attrs) extractFromClass(attrs.class, classes);
    }

    for (const v of Object.values(obj)) traverse(v, classes);
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
