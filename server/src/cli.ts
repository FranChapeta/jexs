#!/usr/bin/env node
// jexs — the Jexs CLI.
//
//   jexs run <entry|package> [root] [--prod] [--watch] [--log=<to>] [-- <app args>]   run a JSON template
//
// `run` takes a file path OR an installed package name: a package is resolved via its
// package.json `"jexs"` entry field, so a pure-JSON package (no bin, no JS) is launched with
// `jexs run <package>`. The entry runs as steps relative to its own directory (a `/`-prefixed
// path anchors at `root`, default cwd), with `env` seeded so templates can branch on `env.*`.
// Tokens after a `--` sentinel are parsed into `args` (a key/value object), letting a JSON
// entry act as its own CLI — e.g. `jexs run @jexs/create -- my-app --env both --physics`.
// An HTTP app is just an entry whose `listen` step(s) bind ports — one `http.Server` per `listen`.
// `--prod` sets NODE_ENV=production (and process.env.prod); `--watch` restarts the app when a template (.json) under the app dir changes;
// `--log` sends the nodes' own messages to stderr (the default), stdout, or nowhere.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { createResolver, coreNodes, Context, type Logger } from "@jexs/core";
import { serverNodes } from "./index.js";
import { manifestOf } from "./manifest.js";
import { loadNodePackages } from "./discover.js";
import { buildProjectSchema, buildPackageSchemaFile } from "./schema-build.js";
import { bundleClient } from "./bundle.js";
import { entryContext } from "./nodes/File.js";

const [cmd, ...rest] = process.argv.slice(2);

const USAGE =
  "usage:\n" +
  "  jexs run <entry.json|package> [root] [--prod] [--watch] [--log stderr|stdout|silent] [-- <app args>]\n" +
  "                                run a JSON app; [root] anchors `/` paths (default: the current directory)\n" +
  "  jexs bundle [--watch]         build the project's browser bundle (client + discovered browser nodes)\n" +
  "  jexs schema [dir]             regenerate .jexs/ for a project (autocomplete + MCP)\n" +
  "  jexs schema --package [dir]   (package authors) prebuild a package's dist/schema.json\n" +
  "  jexs --help | --version\n";

/** Print the usage: asked for, to stdout; after a mistake, to stderr with a failing code. */
function usage(code: number): never {
  (code === 0 ? process.stdout : process.stderr).write(USAGE);
  process.exit(code);
}

/**
 * A command's own flags and positionals. Strict, so a misspelled flag or one
 * missing its value stops the command with a message naming it instead of
 * being ignored; `--log stdout` and `--log=stdout` both work.
 */
function flagsOf<T extends ParseArgsOptionsConfig>(command: string, args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`jexs ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return usage(1);
  }
}

// Parse an app's argument list (the tokens after the `--` sentinel) into a
// key/value object, seeded as `args` so a JSON entry can read its flags
// order-independently (`args.env`, `args.css`, ...). Named flags are the point
// here — the values are interchangeable in position. Unlike the CLI's own flags,
// any name is accepted, since the app decides what it takes. Supported forms:
//   --key value    -> { key: "value" }   (next token consumed unless it's a flag)
//   --key=value    -> { key: "value" }
//   --flag         -> { flag: true }     (no value follows)
//   --no-flag      -> { flag: false }
//   value          -> pushed onto `_` (bare positionals, e.g. a project name)
// All values are strings; the entry coerces (e.g. `{ "$eq": [{ "$var": "args.physics" }, "true"] }`).
function appArgsOf(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { _: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body.startsWith("no-")) {
        out[body.slice(3)] = false;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) { out[body] = next; i++; }
        else out[body] = true;
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

const LOG_TARGETS = ["stderr", "stdout", "silent"];

/**
 * Where `--log` sends the nodes' own messages. stderr by default, where a CLI's
 * diagnostics belong, so stdout is the app's alone: a stdio protocol, or output
 * piped to another program. `stdout` suits a platform that reads a server's log
 * from it and takes stderr for errors; `silent` drops them.
 */
function cliLogger(target: string): Logger {
  if (target === "silent") {
    const drop = () => {};
    return { info: drop, warn: drop, error: drop };
  }
  const write = target === "stdout" ? console.log : console.error;
  // Warnings and errors say so, as a compiler's do; information goes as it is.
  const at = (level: string) => (message: string, error?: unknown) => {
    const line = level ? `${level}: ${message}` : message;
    return error === undefined ? write(line) : write(line, error);
  };
  return { info: at(""), warn: at("warning"), error: at("error") };
}

async function run(args: string[]): Promise<void> {
  // Everything after the first `--` belongs to the JSON app, not the jexs CLI:
  // it's parsed into `args` and never treated as jexs positionals/flags (so an
  // app's `--env both` can't be mistaken for a `root` positional).
  const sep = args.indexOf("--");
  const cliArgs = sep === -1 ? args : args.slice(0, sep);
  const appArgs = sep === -1 ? [] : args.slice(sep + 1);

  const { values, positionals } = flagsOf("run", cliArgs, {
    prod: { type: "boolean" },
    watch: { type: "boolean" },
    log: { type: "string", default: "stderr" },
  });
  const [target, root, ...extra] = positionals;
  if (!target || extra.length > 0) usage(1);
  if (!LOG_TARGETS.includes(values.log)) {
    process.stderr.write(`jexs run: --log takes ${LOG_TARGETS.join(", ")}, not "${values.log}"\n`);
    process.exit(1);
  }
  if (values.prod) {
    process.env.prod = "1";
    process.env.NODE_ENV = "production";
  }
  const entry = resolveEntry(target);

  if (values.watch) {
    // Supervisor: run the app in a child and restart it on changes under the app dir
    // (templates are read at runtime, so a restart re-resolves them). Kept out of the
    // child — which runs `run` without --watch — so a bound port is fully released before
    // the replacement binds.
    const { spawn } = await import("node:child_process");
    const { watch, readdirSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const self = fileURLToPath(import.meta.url);
    // Only jexs's own `--watch` goes: an app's arguments after `--` pass through whole.
    const childArgs = ["run", ...cliArgs.filter((a) => a !== "--watch"), ...(sep === -1 ? [] : ["--", ...appArgs])];
    const watchDir = root ?? path.dirname(entry);

    let child: import("node:child_process").ChildProcess | null = null;
    const start = () => {
      const c = spawn(process.execPath, [self, ...childArgs], { stdio: "inherit" });
      child = c;
      // An app that stops on its own (a script finishing, a startup error) waits for
      // the next change; one a restart stopped is no longer `child`.
      c.on("exit", (code) => {
        if (child !== c) return;
        child = null;
        process.stderr.write(`jexs run: ${code ? `the app exited with code ${code}` : "the app finished"}, waiting for a template to change\n`);
      });
    };
    start();

    // Only a template changing needs a restart, to run the startup steps again. What
    // the app writes under the dir while it runs (a SQLite database and its journal,
    // `secret.key`, uploads) must not restart it, which would drop its memory: the
    // sessions, the cache, the open sockets. Nor may reading a template: Windows reports
    // the access time a read updates, when it writes it out, which can be long after the
    // read, so a template restarts the app only when its modification time moved. A
    // platform that names no file restarts.
    const mtimeOf = (file: string) => { try { return statSync(file).mtimeMs; } catch { return undefined; } };
    const mtimes = new Map<string, number | undefined>();
    for (const name of readdirSync(watchDir, { recursive: true, encoding: "utf8" })) {
      if (name.endsWith(".json")) mtimes.set(path.join(watchDir, name), mtimeOf(path.join(watchDir, name)));
    }
    let timer: NodeJS.Timeout | undefined;
    const changed = new Set<string>();
    watch(watchDir, { recursive: true }, (_event, filename) => {
      if (filename && !filename.toString().endsWith(".json")) return;
      if (filename) {
        const file = path.join(watchDir, filename.toString());
        const mtime = mtimeOf(file);
        if (mtime === mtimes.get(file)) return;
        mtimes.set(file, mtime);
        changed.add(path.relative(process.cwd(), file));
      } else changed.add("a file the platform did not name");
      clearTimeout(timer);
      timer = setTimeout(() => {
        process.stderr.write(`jexs run: restarting, ${[...changed].join(", ")} changed\n`);
        changed.clear();
        if (child) { const c = child; child = null; c.once("exit", start); c.kill(); }
        else start();
      }, 150);
    });
    return;
  }

  // Build a core+server resolver and run the entry as steps, seeding the entry's own directory
  // (relative `{ file }` loads resolve against it; a `/`-prefixed path anchors at `root`) and
  // `env` (so templates can branch on `env.*`). An HTTP app is just an entry with `listen` step(s).
  const abs = path.resolve(entry);
  // Discover every installed node package (core, server, third-party) for the
  // node runtime. Fall back to this package's own core+server set when discovery
  // finds nothing — e.g. running from the monorepo itself, not an installed
  // project; a scaffolded project always discovers @jexs/core + @jexs/server.
  let nodes = await loadNodePackages(process.cwd(), { root: root ?? ".", env: "node" });
  if (nodes.length === 0) nodes = [...coreNodes(), ...serverNodes({ root: root ?? "." })];
  const resolve = createResolver(nodes, { logger: cliLogger(values.log) });
  const context: Context = { ...entryContext(path.dirname(abs)), env: process.env as Record<string, string>, args: appArgsOf(appArgs) };
  await resolve({ $file: path.basename(abs) }, context);
}

// Resolve a `run` target to an entry file path: a local file/dir is used as-is; anything else is
// treated as an installed package and resolved via its package.json `"jexs"` field (relative to
// that package).
function resolveEntry(target: string): string {
  if (existsSync(path.resolve(target))) return target;
  let pkgJson: string;
  try {
    pkgJson = createRequire(import.meta.url).resolve(`${target}/package.json`);
  } catch {
    process.stderr.write(`jexs run: "${target}" is not a file or an installed package\n`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  const manifest = manifestOf(pkg);
  if (!manifest?.app) {
    process.stderr.write(`jexs run: package "${target}" has no "jexs" app entry in its package.json\n`);
    process.exit(1);
  }
  return path.join(path.dirname(pkgJson), manifest.app);
}

/**
 * Stop a command that failed with its message and a failing code. The stack is
 * printed only for the errors that point at a bug in Jexs or a package rather
 * than at the app (a TypeError, say); for a template's error it is Jexs's own
 * internals, which say nothing about where in the template it came from.
 */
function fail(command: string, error: unknown): never {
  const bug = error instanceof TypeError || error instanceof ReferenceError;
  process.stderr.write(`jexs ${command}: ${bug ? error.stack : error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

try {
  if (cmd === "run") {
    await run(rest);
  } else if (cmd === "bundle") {
    const { values } = flagsOf("bundle", rest, { watch: { type: "boolean" } });
    await bundleClient(process.cwd(), { watch: values.watch });
  } else if (cmd === "schema") {
    const { values, positionals } = flagsOf("schema", rest, { package: { type: "boolean" } });
    const dir = positionals[0] ?? process.cwd();
    if (values.package) {
      // A package author's prebuild of the package's own dist/schema.json.
      const { nodes, methods } = await buildPackageSchemaFile(path.resolve(dir));
      console.error(`jexs schema: ${nodes} nodes, ${methods} methods → ${path.join(dir, "dist", "schema.json")}`);
    } else {
      // Regenerate project-local autocomplete + MCP schema from installed packages.
      const { packages } = await buildProjectSchema(path.resolve(dir));
      console.error(`jexs schema: merged ${packages} package(s) → ${path.join(dir, ".jexs", "combined.schema.json")}`);
    }
  } else if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version);
  } else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage(0);
  } else {
    usage(1);
  }
} catch (error) {
  fail(cmd, error);
}
