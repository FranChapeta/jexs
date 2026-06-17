import fs from "fs/promises";
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
      output: "any",
      markdownDescription: "Loads a JSON file relative to the `app/` directory and resolves it as a Jexs expression.\nArrays are executed as step sequences; objects are resolved as a single expression.\nPass `\"data\": true` to skip resolution and get the raw parsed JSON (use for data files, route trees, and anywhere you want the resolver to leave the file alone).\nPass `\"raw\": true` for the raw string content with no JSON parse.\nPass `\"params\"` to merge scoped variables into the file's resolution context, or `\"write\"` to write data to the file.",
      outputDescription: "Default: the file resolved as a Jexs expression (a JSON array runs as steps → its last value; a JSON object resolves to its value). With `data: true`, the raw parsed JSON; with `raw: true`, the file as a string; non-JSON text files return their string and binaries a Buffer. `null` if the file can't be read or parsed.",
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
      },
      variants: {
        write: {
          output: "boolean",
          markdownDescription: "Writes data to the file (strings verbatim, otherwise JSON). Returns `true`/`false` for success.",
        },
      },
    },
    directory: {
      type: "string",
      output: "array",
      markdownDescription: "Lists directory contents relative to `app/`.",
      outputDescription: "An array of `{ name, path, size, modified }` entries (filtered by `extension` when given); `[]` if the directory can't be read.",
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
      markdownDescription: "Reports disk usage for a path. Pass a path string or `true` to use the current working directory.",
      outputDescription: "`{ total, free, used }` in bytes, or `null` on error.",
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

      // Async statfs keeps the event loop free during the syscall; the resolve
      // family propagates the returned promise. Error semantics preserved.
      return fs.statfs(target).then(stats => {
        const total = stats.bsize * stats.blocks;
        const free = stats.bsize * stats.bavail;
        return { total, free, used: total - free };
      }).catch(error => {
        const e = error as Error;
        console.error(`[FileNode] Error getting disk info:`, e.message);
        return null;
      });
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
    const wantBuffer = kind === "binary" && !raw;

    // Narrow try: only catch file I/O failures here. Errors thrown by the
    // loaded file's own steps (e.g. HttpError from a 404 route) must
    // propagate to the caller, not be swallowed as a "file load error".
    let content: string | Buffer;
    try {
      content = wantBuffer
        ? await fs.readFile(filePath)
        : await fs.readFile(filePath, "utf-8");
    } catch (error) {
      console.error(`[FileNode] Error loading file ${filePath}:`, (error as Error).message);
      return null;
    }

    if (wantBuffer) return content;
    if (raw) return content;
    if (kind === "text") return content;

    // JSON parse is also FileNode's concern — narrow catch so a malformed file
    // doesn't surface as a 500 from somewhere downstream.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content as string);
    } catch (error) {
      console.error(`[FileNode] Error parsing JSON in ${filePath}:`, (error as Error).message);
      return null;
    }

    if (data) return parsed;

    // Scoped context: if params provided, clone context and merge resolved params
    let fileContext = context;
    if ("params" in def && isObject(def.params)) {
      const params = def.params;
      const pResolved = resolveObj(params, context, r => r);
      const resolved = (pResolved instanceof Promise ? await pResolved : pResolved) as Record<string, unknown>;
      fileContext = { ...context, ...resolved };
    }

    // From here, anything that throws is application code — let it propagate.
    // Array -> execute steps in sequence
    if (Array.isArray(parsed)) {
      const result = await Promise.resolve(runSteps(parsed, fileContext));
      return result ?? null;
    }

    // Single object: always resolve (with file context if params were provided,
    // else the caller's context). Use `data: true` to short-circuit resolution
    // and get the raw parsed JSON back — that's the explicit knob for pure data
    // and for definition trees (e.g. routes) that should be walked, not eagerly
    // evaluated by the resolver.
    return resolve(parsed, fileContext);
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
