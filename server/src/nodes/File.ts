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

// The directory of the file currently being resolved. Tracked under a private
// symbol on the context — NOT a readable `$var`: templates can't read it via
// `var`, and request data / `as` (string keys only) can't inject it, so it can't
// be used to redirect file resolution. Object spread copies it, so child scopes
// (map/foreach/if) inherit it; JSON and structuredClone drop it, so it never
// leaks to logs or the `thread` worker.
const FILE_DIR = Symbol("jexs.fileDir");

function getFileDir(context: Context): string | undefined {
  return (context as Record<symbol, unknown>)[FILE_DIR] as string | undefined;
}

/**
 * Seed a context with an entry file's directory so the entry's relative loads
 * resolve against it, wherever it sits relative to the resolver root. Used by the
 * app runner to bootstrap an entry (JS-only — templates cannot reach the symbol).
 */
export function entryContext(dir: string): Context {
  return { [FILE_DIR]: dir } as Context;
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
      markdownDescription: "Loads a JSON file and resolves it as a Jexs expression. Paths resolve like a filesystem: relative to the file doing the loading (`\"nav.json\"`, `\"../shared/x.json\"`), while a leading `/` anchors at the resolver root (`\"/data/site.json\"`).\nArrays are executed as step sequences; objects are resolved as a single expression.\nPass `\"data\": true` to skip resolution and get the raw parsed JSON (use for data files, route trees, and anywhere you want the resolver to leave the file alone).\nPass `\"raw\": true` for the raw string content with no JSON parse.\nPass `\"params\"` to merge scoped variables into the file's resolution context, or `\"write\"` to write data to the file.",
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
      markdownDescription: "Lists directory contents. The path resolves relative to the file doing the loading; a leading `/` anchors at the resolver root. Lists files by default; pass `\"subdirectories\": true` to list the folders instead.",
      outputDescription: "An array of `{ name, path, size, modified }` entries — files by default, or subdirectories when `subdirectories` is set (filtered by `extension` when given); `[]` if the directory can't be read.",
      examples: [
        "{ \"directory\": \"data/posts\", \"extension\": \"json\", \"recursive\": true }",
        "{ \"directory\": \"node_modules/@jexs\", \"subdirectories\": true }",
      ],
      siblings: {
        recursive: {
          type: "boolean",
          description: "Traverse subdirectories recursively.",
        },
        extension: {
          description: "Filter by file extension(s), e.g. `\"json\"`.",
        },
        subdirectories: {
          type: "boolean",
          description: "List subdirectories instead of files. Combine with `recursive` to walk the whole folder tree.",
        },
      },
      variants: {
        create: {
          type: "boolean",
          output: "boolean",
          markdownDescription: "Creates the directory, auto-creating any missing parent directories (no error if it already exists). Returns `true`/`false` for success.",
        },
      },
    },
    disk: {
      type: ["string", "boolean"],
      output: "object",
      markdownDescription: "Reports disk usage for a path. Pass a path string or `true` to use the current working directory.",
      outputDescription: "`{ total, free, used }` in bytes, or `null` on error.",
      examples: [
        "{ \"disk\": true }",
      ],
    },
  };

  private rootAbs: string;

  constructor(root: string = "app") {
    super();
    // Absolute resolver root: `/`-prefixed paths resolve against it; everything
    // else resolves relative to the file doing the loading.
    this.rootAbs = path.resolve(root);
  }

  file(def: Record<string, unknown>, context: Context): NodeValue {
    return "write" in def
      ? writeFile(def, context, this.rootAbs)
      : loadFile(def, context, this.rootAbs);
  }

  directory(def: Record<string, unknown>, context: Context): NodeValue {
    if ("create" in def) return createDir(def, context, this.rootAbs);

    return resolveAll(
      [def.directory, def.recursive ?? null, def.extension ?? null, def.subdirectories ?? null],
      context,
      async ([dirPathValue, recursiveRaw, extensionValue, subdirsRaw]) => {
        const recursive = toBoolean(recursiveRaw);
        const subdirs = toBoolean(subdirsRaw);
        const dirPath = resolvePath(dirPathValue, this.rootAbs, getFileDir(context));

        try {
          const entries = await listDir(dirPath, recursive, subdirs);

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

// Resolve a path the way a filesystem/URL does: a leading `/` is anchored at the
// resolver root; everything else is relative to the file currently loading (the
// `fileDir`), falling back to the root when there is no current file (the entry).
function resolvePath(pathValue: unknown, rootAbs: string, fileDir?: string): string {
  const p = String(pathValue);
  if (p.startsWith("/")) return path.join(rootAbs, p.slice(1));
  if (fileDir !== undefined) return path.resolve(fileDir, p);
  return path.join(rootAbs, p);
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
  rootAbs: string,
): unknown {
  return resolveAll([def.file, def.raw ?? null, def.data ?? null], context, async ([filePathValue, rawRaw, dataRaw]) => {
    const raw = toBoolean(rawRaw);
    const data = toBoolean(dataRaw);
    const filePath = resolvePath(filePathValue, rootAbs, getFileDir(context));
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

    // Run the loaded file's steps against a context that records ITS directory,
    // so nested relative `{ file }` / `{ directory }` loads resolve against this
    // file (not the caller's). Params, if any, merge on top.
    let fileContext: Context = { ...context, [FILE_DIR]: path.dirname(filePath) };
    if ("params" in def && isObject(def.params)) {
      const params = def.params;
      const pResolved = resolveObj(params, context, r => r);
      const resolved = (pResolved instanceof Promise ? await pResolved : pResolved) as Record<string, unknown>;
      fileContext = { ...fileContext, ...resolved };
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
  rootAbs: string,
): unknown {
  return resolveAll([def.file, def.write], context, async ([filePathValue, data]) => {
    const filePath = resolvePath(filePathValue, rootAbs, getFileDir(context));

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

function createDir(
  def: Record<string, unknown>,
  context: Context,
  rootAbs: string,
): unknown {
  return resolve(def.directory, context, async dirPathValue => {
    const dirPath = resolvePath(dirPathValue, rootAbs, getFileDir(context));

    try {
      await fs.mkdir(dirPath, { recursive: true });
      return true;
    } catch (error) {
      const e = error as Error;
      console.error(`[FileNode] Error creating directory ${dirPath}:`, e.message);
      return false;
    }
  });
}

async function listDir(
  dirPath: string,
  recursive: boolean,
  subdirs: boolean,
): Promise<FileInfo[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: FileInfo[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    // Classify following symlinks, so workspace/pnpm node_modules — which symlink
    // package folders — are seen as the directories they point at.
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(fullPath)).isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }

    if (isDir) {
      // `subdirs` lists the directories themselves; the default lists files.
      if (subdirs) {
        const stat = await fs.stat(fullPath);
        results.push({
          name: entry.name,
          path: entry.name,
          size: stat.size,
          modified: stat.mtimeMs,
        });
      }
      // Descend into real directories only — never follow a symlink recursively,
      // which guards against cycles and escaping the tree (both common under
      // node_modules).
      if (recursive && entry.isDirectory()) {
        const subEntries = await listDir(fullPath, true, subdirs);
        results.push(
          ...subEntries.map((e) => ({
            ...e,
            path: path.join(entry.name, e.path),
          })),
        );
      }
    } else if (!subdirs) {
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
