import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, resolve, resolveAll, runSteps, childContext, isObject } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return value !== null && value !== undefined;
}

// The directory of the file currently being resolved. Tracked under a private
// symbol on the context — NOT a readable `$var`: templates can't read it via
// `var`, and request data / `$as` (string keys only) can't inject it, so it can't
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
 * Decode a URL pathname into a path relative to `root`, or null if it escapes.
 *
 * For runners that serve files over HTTP or a custom scheme, where the path
 * arrives from outside. Note this is the OPPOSITE rule from `resolvePath` below,
 * which deliberately lets a load escape the root: `"../shared/x.json"` is a
 * documented, supported template path. Escaping is a feature for a template
 * author and a vulnerability for a request, so the two never share a code path.
 *
 * The containment check is not belt-and-braces, it is the actual guard. URL
 * parsing normalizes a plain `../`, so `/../../etc/passwd` arrives as
 * `/etc/passwd` and is harmless -- but a PERCENT-ENCODED separator survives it:
 * the parser reads `..%2f..` as one opaque segment, and the decodeURIComponent
 * that follows turns it back into `../../`.
 *
 * `path.join` rather than `path.resolve` for the candidate, so an absolute
 * segment such as `C:/Windows/...` is appended rather than honored.
 */
export function safeRelative(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    // Malformed percent-encoding (`%zz`, a trailing `%`). Not a path at all.
    return null;
  }
  // `%00` decodes to a NUL, which truncates the name for some consumers and
  // makes Node's fs throw. Rejected here so no caller has to wrap its own read.
  if (rel.includes("\0")) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(path.join(root, rel));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return rel;
}

export class FileNode extends Node {
  static schema: JexsNodeSchema = {
    file: {
      type: "string",
      output: "any",
      markdownDescription: "Loads a JSON file and resolves it as a Jexs expression. Paths resolve like a filesystem: relative to the file doing the loading (`\"nav.json\"`, `\"../shared/x.json\"`), while a leading `/` anchors at the resolver root (`\"/data/site.json\"`).\nArrays are executed as step sequences; objects are resolved as a single expression.\nPass `\"data\": true` to skip resolution and get the raw parsed JSON (use for data files, route trees, and anywhere you want the resolver to leave the file alone).\nPass `\"raw\": true` for the raw string content with no JSON parse.\nPass `\"params\"` to merge scoped variables into the file's resolution context, or `\"write\"` to write data to the file.",
      outputDescription: "Default: the file resolved as a Jexs expression (a JSON array runs as steps → its last value; a JSON object resolves to its value). With `data: true`, the raw parsed JSON; with `raw: true`, the file as a string; non-JSON text files return their string and binaries a Buffer. A file that can't be read, or a `.json` file that isn't valid JSON, is an error; `fileExists` asks first without one.",
      examples: [
        "{ \"$file\": \"pages/home.json\", \"params\": { \"title\": \"Home\" } }",
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
          description: "Scoped variables passed into the loaded file's context: a map of values, or a step resolving to one.",
        },
      },
      // One action per step: loading (none of these), or one of them.
      exclusive: true,
      variants: {
        write: {
          output: "null",
          markdownDescription: "Writes data to the file (strings verbatim, otherwise JSON). A failure is an error.",
        },
        copy: {
          type: "string",
          output: "null",
          markdownDescription: "Copies the file to another path, overwriting any file already there. The destination resolves the same way the source does.",
        },
        move: {
          type: "string",
          output: "null",
          markdownDescription: "Moves or renames the file, overwriting any file already there. The destination resolves the same way the source does.\nFalls back to copy-then-delete when the destination is on another drive or mount, which a plain rename cannot cross.",
        },
      },
    },
    fileExists: {
      type: "string",
      output: "boolean",
      markdownDescription: "Reports whether the path exists, without reading it. Cheaper than loading a large file to test for it, and unlike a load it does not treat an unparseable file as missing. The path resolves as `file`'s does.",
      examples: [
        "{ \"$fileExists\": \"/data/settings.json\" }",
      ],
    },
    fileStat: {
      type: "string",
      output: {
        type: "object",
        properties: {
          size: { type: "number", description: "In bytes." },
          modified: { type: "string", description: "ISO date-time." },
          created: { type: "string", description: "ISO date-time." },
          isFile: { type: "boolean" },
          isDirectory: { type: "boolean" },
        },
      },
      markdownDescription: "Reports a file's metadata without reading its contents. A path that cannot be read is an error. The path resolves as `file`'s does.",
      outputDescription: "The file's metadata.",
      examples: [
        "{ \"$fileStat\": \"/uploads/report.pdf\" }",
      ],
    },
    fileDelete: {
      type: "string",
      output: "boolean",
      markdownDescription: "Deletes a file. An absent one is not an error, so cleanup steps are repeatable. Refuses directories, since there is deliberately no recursive delete. The path resolves as `file`'s does.",
      outputDescription: "`true` if the file existed and was deleted, otherwise `false`.",
      examples: [
        "{ \"$fileDelete\": \"/tmp/upload.part\" }",
      ],
    },
    directory: {
      type: "string",
      output: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            size: { type: "number", description: "In bytes." },
            modified: { type: "string", description: "ISO date-time." },
          },
        },
      },
      markdownDescription: "Lists directory contents. The path resolves relative to the file doing the loading; a leading `/` anchors at the resolver root. Lists files by default; pass `\"subdirectories\": true` to list the folders instead.",
      outputDescription: "One entry per file by default, or per subdirectory when `subdirectories` is set (filtered by `extension` when given). A directory that can't be read is an error.",
      examples: [
        "{ \"$directory\": \"data/posts\", \"extension\": \"json\", \"recursive\": true }",
        "{ \"$directory\": \"node_modules/@jexs\", \"subdirectories\": true }",
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
    },
    directoryCreate: {
      type: "string",
      output: "null",
      markdownDescription: "Creates a directory, and any missing parent directories; one that already exists is not an error. The path resolves as `directory`'s does.",
      examples: [
        "{ \"$directoryCreate\": \"/data/exports\" }",
      ],
    },
    disk: {
      type: ["string", "boolean"],
      output: {
        type: "object",
        properties: { total: { type: "number" }, free: { type: "number" }, used: { type: "number" } },
      },
      markdownDescription: "Reports disk usage for a path. Pass a path string or `true` to use the current working directory.",
      outputDescription: "Disk usage in bytes.",
      examples: [
        "{ \"$disk\": true }",
      ],
    },
  };

  private rootAbs: string;

  constructor(root: string = "src") {
    super();
    // Absolute resolver root: `/`-prefixed paths resolve against it; everything
    // else resolves relative to the file doing the loading.
    this.rootAbs = path.resolve(root);
  }

  file(def: Record<string, unknown>, context: Context): NodeValue {
    if ("write" in def) return writeFile(def, context, this.rootAbs);
    if ("copy" in def) return transferFile(def, context, this.rootAbs, "copy");
    if ("move" in def) return transferFile(def, context, this.rootAbs, "move");
    return loadFile(def, context, this.rootAbs);
  }

  fileExists(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$fileExists, context, filePathValue =>
      fs.stat(resolvePath(filePathValue, this.rootAbs, getFileDir(context))).then(() => true, () => false));
  }

  fileStat(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$fileStat, context, async filePathValue => {
      const info = await fs.stat(resolvePath(filePathValue, this.rootAbs, getFileDir(context)));
      return {
        size: info.size,
        modified: info.mtime.toISOString(),
        created: info.birthtime.toISOString(),
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
      };
    });
  }

  fileDelete(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$fileDelete, context, async filePathValue => {
      // An absent file is reported rather than an error: a cleanup step should be
      // repeatable, and "it is not there" is the outcome the caller wanted. No
      // `recursive`, so a directory is an error rather than a silent tree wipe.
      try {
        await fs.rm(resolvePath(filePathValue, this.rootAbs, getFileDir(context)));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }

  directoryCreate(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$directoryCreate, context, async dirPathValue => {
      await fs.mkdir(resolvePath(dirPathValue, this.rootAbs, getFileDir(context)), { recursive: true });
      return null;
    });
  }

  directory(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll(
      [def.$directory, def.recursive ?? null, def.extension ?? null, def.subdirectories ?? null],
      context,
      async ([dirPathValue, recursiveRaw, extensionValue, subdirsRaw]) => {
        const recursive = toBoolean(recursiveRaw);
        const subdirs = toBoolean(subdirsRaw);
        const dirPath = resolvePath(dirPathValue, this.rootAbs, getFileDir(context));
        const entries = await listDir(dirPath, recursive, subdirs);
        if (!extensionValue) return entries;
        const exts = Array.isArray(extensionValue)
          ? extensionValue.map((e) => String(e))
          : [String(extensionValue)];
        return entries.filter((e) => exts.some((ext) => e.name.endsWith(`.${ext}`)));
      },
    );
  }

  disk(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$disk, context, diskPath => {
      const target = diskPath && diskPath !== true ? String(diskPath) : process.cwd();

      // Async statfs keeps the event loop free during the syscall; the resolve
      // family propagates the returned promise.
      return fs.statfs(target).then(stats => {
        const total = stats.bsize * stats.blocks;
        const free = stats.bsize * stats.bavail;
        return { total, free, used: total - free };
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
  return resolveAll([def.$file, def.raw ?? null, def.data ?? null], context, async ([filePathValue, rawRaw, dataRaw]) => {
    const raw = toBoolean(rawRaw);
    const data = toBoolean(dataRaw);
    const filePath = resolvePath(filePathValue, rootAbs, getFileDir(context));
    const kind = classifyExt(filePath);
    const wantBuffer = kind === "binary" && !raw;

    // A read failure carries the path in fs's own message (ENOENT: ..., open '<path>').
    const content = wantBuffer
      ? await fs.readFile(filePath)
      : await fs.readFile(filePath, "utf-8");

    if (wantBuffer) return content;
    if (raw) return content;
    if (kind === "text") return content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content as string);
    } catch (error) {
      throw new Error(`$file: ${filePath} is not valid JSON: ${(error as Error).message}`);
    }

    if (data) return parsed;

    // Run the loaded file's steps against a context that records ITS directory,
    // so nested relative `{ file }` / `{ directory }` loads resolve against this
    // file (not the caller's). Params, if any, merge on top. The context is
    // linked back to the caller (via `childContext`) so `$setVars` / `$as` with
    // `$bubble` inside the file can write state upward past the file boundary.
    const fileDir = path.dirname(filePath);
    let fileContext: Context = childContext(context, { [FILE_DIR]: fileDir });
    if (def.params !== undefined) {
      // A map, or a step resolving to one. Re-derive from the caller so params
      // merge on top AND the parent link (non-enumerable, so dropped by a plain
      // spread) still points at the caller.
      const params = await resolve(def.params, context);
      if (isObject(params)) fileContext = childContext(context, { [FILE_DIR]: fileDir, ...params });
    }

    // From here, anything that throws is application code — let it propagate.
    // An array runs as steps and anything else resolves as one expression, in
    // the file's own scope. `data: true` short-circuits this and returns the
    // parsed JSON as is: the knob for pure data and for definition trees (e.g.
    // routes) that should be walked, not eagerly evaluated by the resolver.
    return (await runSteps(parsed, fileContext)) ?? null;
  });
}

function writeFile(
  def: Record<string, unknown>,
  context: Context,
  rootAbs: string,
): unknown {
  return resolveAll([def.$file, def.write], context, async ([filePathValue, data]) => {
    const filePath = resolvePath(filePathValue, rootAbs, getFileDir(context));
    await fs.writeFile(filePath, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    return null;
  });
}

/**
 * `exists` and `stat` share a path because both only ask the filesystem about a
 * file rather than reading it. A failed stat is the ANSWER for `exists`; for
 * `stat` it is a real failure, and throws.
 */
function transferFile(
  def: Record<string, unknown>,
  context: Context,
  rootAbs: string,
  mode: "copy" | "move",
): unknown {
  return resolveAll([def.$file, def[mode]], context, async ([fromValue, toValue]) => {
    const fileDir = getFileDir(context);
    const from = resolvePath(fromValue, rootAbs, fileDir);
    // The destination resolves by the same rules as the source, so a relative
    // target lands next to the file that asked for the move, not next to `from`.
    const to = resolvePath(toValue, rootAbs, fileDir);

    if (mode === "copy") {
      await fs.copyFile(from, to);
      return null;
    }
    try {
      await fs.rename(from, to);
    } catch (error) {
      // EXDEV: rename cannot cross a drive or mount point, which on a desktop
      // is an ordinary move (C: to D:, or onto a USB stick) rather than a bug.
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.copyFile(from, to);
      await fs.rm(from, { force: true });
    }
    return null;
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
          modified: stat.mtime.toISOString(),
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
        modified: stat.mtime.toISOString(),
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
  /** ISO date-time. */
  modified: string;
}
