import fs from "fs/promises";
import { statfsSync } from "fs";
import path from "path";
import { Node, Context, NodeValue, resolve, resolveAll, resolveObj, runSteps } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

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
  static schema: JexsNodeSchema = {
    file: {
      type: "string",
      markdownDescription: "Loads and resolves a JSON file relative to the `app/` directory.\nArrays are executed as step sequences; objects are resolved as expressions.\nPass `\"raw\": true` for raw string content, `\"data\": true` to skip resolution,\n`\"params\"` to provide scoped variables, or `\"write\"` to write data to the file.",
      examples: [
        "{ \"file\": \"pages/home.json\", \"params\": { \"title\": \"Home\" } }",
      ],
      siblings: {
        raw: {
          type: "boolean",
          description: "Return raw string content without parsing.",
        },
        data: {
          type: "boolean",
          description: "Parse JSON but skip expression resolution.",
        },
        params: {
          map: true,
          description: "Scoped variables passed into the loaded file's context.",
        },
        write: {
          description: "Data to write to the file (triggers write mode).",
        },
      },
    },
    directory: {
      type: "string",
      output: "array",
      markdownDescription: "Lists directory contents relative to `app/`. Returns `[{ name, path, size, modified }]`.",
      examples: [
        "{ \"directory\": \"data/posts\", \"extension\": \"json\", \"recursive\": true }",
      ],
      siblings: {
        recursive: {
          type: "boolean",
          description: "Traverse subdirectories recursively.",
        },
        extension: {
          description: "Filter by file extension(s), e.g. `\"json\"`.",
        },
      },
    },
    disk: {
      output: "object",
      markdownDescription: "Returns disk usage stats for a path: `{ total, free, used }` in bytes.\nPass a path string or `true` to use the current working directory.",
      examples: [
        "{ \"disk\": true }",
      ],
    },
  };

  private appDir: string;

  constructor(appDir: string = "app") {

    super();
    this.appDir = appDir;
  }

  file(def: Record<string, unknown>, context: Context): NodeValue {
    return "write" in def
      ? writeFile(def, context, this.appDir)
      : loadFile(def, context, this.appDir);
  }

  directory(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll(
      [def.directory, def.recursive ?? null, def.extension ?? null],
      context,
      async ([dirPathValue, recursiveRaw, extensionValue]) => {
        const recursive = toBoolean(recursiveRaw);
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
      },
    );
  }

  disk(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.disk, context, diskPath => {
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
    });
  }
}

function resolvePath(pathValue: unknown, appDir: string): string {
  let p = String(pathValue);
  if (p.startsWith("/")) p = p.slice(1);
  return path.join(appDir, p);
}

const TEXT_EXT = new Set([
  "txt", "html", "htm", "css", "svg", "md", "js", "ts", "tsx", "jsx",
  "glsl", "frag", "vert", "xml", "yaml", "yml", "csv", "log",
]);
const JSON_EXT = new Set(["json", "gltf"]);

function classifyExt(filePath: string): "json" | "text" | "binary" {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "binary";
  const ext = filePath.slice(dot + 1).toLowerCase();
  if (JSON_EXT.has(ext)) return "json";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

function loadFile(
  def: Record<string, unknown>,
  context: Context,
  appDir: string,
): unknown {
  return resolveAll([def.file, def.raw ?? null, def.data ?? null], context, async ([filePathValue, rawRaw, dataRaw]) => {
    const raw = toBoolean(rawRaw);
    const data = toBoolean(dataRaw);
    const filePath = resolvePath(filePathValue, appDir);
    const kind = classifyExt(filePath);

    try {
      // Binary files: return Buffer (no text decoding, no JSON parse).
      // `raw: true` overrides to force string decoding even for binary extensions.
      if (kind === "binary" && !raw) {
        return await fs.readFile(filePath);
      }

      const content = await fs.readFile(filePath, "utf-8");

      if (raw) return content;

      // Text files (non-JSON): return string content directly.
      if (kind === "text") return content;

      const parsed = JSON.parse(content);

      if (data) return parsed;

      // Scoped context: if params provided, clone context and merge resolved params
      let fileContext = context;
      if ("params" in def && isObject(def.params)) {
        const params = def.params;
        const pResolved = resolveObj(params, context, r => r);
        const resolved = (pResolved instanceof Promise ? await pResolved : pResolved) as Record<string, unknown>;
        fileContext = { ...context, ...resolved };
      }

      // Array -> execute steps in sequence
      if (Array.isArray(parsed)) {
        const result = await Promise.resolve(runSteps(parsed, fileContext));
        if (result && typeof result === "object" && !Array.isArray(result) &&
            (result as Record<string, unknown>).type === "return") {
          return (result as Record<string, unknown>).value ?? null;
        }
        return result ?? null;
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
  });
}

function writeFile(
  def: Record<string, unknown>,
  context: Context,
  appDir: string,
): unknown {
  return resolveAll([def.file, def.write], context, async ([filePathValue, data]) => {
    const filePath = resolvePath(filePathValue, appDir);

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
  });
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
