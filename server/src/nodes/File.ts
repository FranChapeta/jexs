import fs from "fs/promises";
import { statfsSync } from "fs";
import path from "path";
import { Node, Context, NodeValue, resolve } from "@jexs/core";

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return value !== null && value !== undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * FileNode - Handles file operations in JSON.
 *
 * Operations:
 * - { "file": "path/to/file.json" } -> load and parse JSON file
 * - { "file": { "var": "$path" }, "raw": true } -> dynamic path, load as string
 * - { "directory": "path/to/dir" } -> list directory contents
 * - { "directory": "path/to/dir", "recursive": true } -> list recursively
 * - { "directory": "path/to/dir", "extension": ["json", "js"] } -> filter by extension
 *
 * File paths are resolved relative to the app directory.
 * All property values are resolved dynamically (can use variables, joins, etc.)
 */
export class FileNode extends Node {
  private appDir: string;

  constructor(appDir: string = "app") {
    super();
    this.appDir = appDir;
  }

  async file(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    return "write" in def
      ? writeFile(def, context, this.appDir)
      : loadFile(def, context, this.appDir);
  }

  async directory(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const dirPathValue = await resolve(def.directory, context);
    const recursive = toBoolean(await resolve(def.recursive, context));
    const extensionValue = await resolve(def.extension, context);

    const dirPath = resolvePath(dirPathValue, this.appDir);

    try {
      const entries = await listDir(dirPath, recursive);

      if (extensionValue) {
        const exts = Array.isArray(extensionValue)
          ? extensionValue.map((e) => String(e))
          : [String(extensionValue)];
        return entries.filter((e) =>
          exts.some((ext) => e.name.endsWith(`.${ext}`)),
        );
      }

      return entries;
    } catch (error) {
      const e = error as Error;
      console.error(
        `[FileNode] Error reading directory ${dirPath}:`,
        e.message,
      );
      return [];
    }
  }

  async disk(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const diskPath = await resolve(def.disk, context);
    const target = diskPath && diskPath !== true ? String(diskPath) : process.cwd();

    try {
      const stats = statfsSync(target);
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bavail;
      return { total, free, used: total - free };
    } catch (error) {
      const e = error as Error;
      console.error(`[FileNode] Error getting disk info:`, e.message);
      return null;
    }
  }
}

function resolvePath(pathValue: unknown, appDir: string): string {
  let p = String(pathValue);
  if (p.startsWith("/")) p = p.slice(1);
  return path.join(appDir, p);
}

async function loadFile(
  def: Record<string, unknown>,
  context: Context,
  appDir: string,
): Promise<unknown> {
  const filePathValue = await resolve(def.file, context);
  const raw = toBoolean(await resolve(def.raw, context));
  const data = toBoolean(await resolve(def.data, context));

  const filePath = resolvePath(filePathValue, appDir);

  try {
    const content = await fs.readFile(filePath, "utf-8");

    if (raw) return content;

    const parsed = JSON.parse(content);

    if (data) return parsed;

    // Scoped context: if params provided, clone context and merge resolved params
    let fileContext = context;
    if ("params" in def && isObject(def.params)) {
      const params = def.params as Record<string, unknown>;
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        resolved[key] = await resolve(value, context);
      }
      fileContext = { ...context, ...resolved };
    }

    // Array -> execute steps in sequence
    if (Array.isArray(parsed)) {
      let lastResult: unknown = null;
      for (const step of parsed) {
        lastResult = await resolve(step, fileContext);
        if (
          lastResult &&
          typeof lastResult === "object" &&
          !Array.isArray(lastResult) &&
          (lastResult as Record<string, unknown>).type === "return"
        ) {
          return (lastResult as Record<string, unknown>).value ?? null;
        }
        if (
          step &&
          typeof step === "object" &&
          !Array.isArray(step) &&
          "as" in step
        ) {
          const varName = String((step as Record<string, unknown>).as).replace(/^\$/, "");
          fileContext[varName] = lastResult;
        }
      }
      return lastResult;
    }

    // Single object: resolve with file context if params were provided
    if (fileContext !== context) {
      return resolve(parsed, fileContext);
    }

    return parsed;
  } catch (error) {
    const e = error as Error;
    console.error(`[FileNode] Error loading file ${filePath}:`, e.message);
    return null;
  }
}

async function writeFile(
  def: Record<string, unknown>,
  context: Context,
  appDir: string,
): Promise<boolean> {
  const filePathValue = await resolve(def.file, context);
  const filePath = resolvePath(filePathValue, appDir);
  const data = await resolve(def.write, context);

  try {
    const content =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content);
    return true;
  } catch (error) {
    const e = error as Error;
    console.error(`[FileNode] Error writing file ${filePath}:`, e.message);
    return false;
  }
}

async function listDir(
  dirPath: string,
  recursive: boolean,
): Promise<FileInfo[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: FileInfo[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (recursive) {
        const subEntries = await listDir(fullPath, true);
        results.push(
          ...subEntries.map((e) => ({
            ...e,
            path: path.join(entry.name, e.path),
          })),
        );
      }
    } else {
      const stat = await fs.stat(fullPath);
      results.push({
        name: entry.name,
        path: entry.name,
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }
  }

  return results;
}

/**
 * File info structure
 */
export interface FileInfo {
  name: string;
  path: string;
  size: number;
  modified: number;
}
