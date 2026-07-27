#!/usr/bin/env node
// jexs — the Jexs CLI.
//
//   jexs run <entry|package> [root] [--prod] [--watch] [-- <app args>]   run a JSON template
//
// `run` takes a file path OR an installed package name: a package is resolved via its
// package.json `"jexs"` entry field, so a pure-JSON package (no bin, no JS) is launched with
// `jexs run <package>`. The entry runs as steps relative to its own directory (a `/`-prefixed
// path anchors at `root`, default cwd), with `env` seeded so templates can branch on `$env.*`.
// Tokens after a `--` sentinel are parsed into `$args` (a key/value object), letting a JSON
// entry act as its own CLI — e.g. `jexs run @jexs/create -- my-app --env both --physics`.
// An HTTP app is just an entry whose `listen` step(s) bind ports — one `http.Server` per `listen`.
// `--prod` sets process.env.prod; `--watch` restarts the app when files under the app dir change.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createResolver, coreNodes, Context } from "@jexs/core";
import { serverNodes } from "./index.js";
import { entryContext } from "./nodes/File.js";

const [cmd, ...rest] = process.argv.slice(2);

function usage(code: number): never {
  process.stderr.write(
    "usage:\n" +
    "  jexs run <entry.json|package> [root] [--prod] [--watch] [-- <app args>]\n",
  );
  process.exit(code);
}

// Parse an app's argument list (the tokens after the `--` sentinel) into a
// key/value object, seeded as `$args` so a JSON entry can read its flags
// order-independently (`$args.env`, `$args.css`, ...). Named flags are the point
// here — the values are interchangeable in position. Supported forms:
//   --key value    -> { key: "value" }   (next token consumed unless it's a flag)
//   --key=value    -> { key: "value" }
//   --flag         -> { flag: true }     (no value follows)
//   --no-flag      -> { flag: false }
//   value          -> pushed onto `_` (bare positionals, e.g. a project name)
// All values are strings; the entry coerces (e.g. `{ "eq": [{ "var": "$args.physics" }, "true"] }`).
function parseArgs(argv: string[]): Record<string, unknown> {
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

async function run(args: string[]): Promise<void> {
  if (args.includes("--prod")) process.env.prod = "1";

  // Everything after the first `--` belongs to the JSON app, not the jexs CLI:
  // it's parsed into `$args` and never treated as jexs positionals/flags (so an
  // app's `--env both` can't be mistaken for a `root` positional).
  const sep = args.indexOf("--");
  const cliArgs = sep === -1 ? args : args.slice(0, sep);
  const appArgs = sep === -1 ? [] : args.slice(sep + 1);

  const positional = cliArgs.filter((a) => !a.startsWith("--"));
  const [target, root] = positional;
  if (!target) usage(1);
  const entry = resolveEntry(target);

  if (args.includes("--watch")) {
    // Supervisor: run the app in a child and restart it on changes under the app dir
    // (templates are read at runtime, so a restart re-resolves them). Kept out of the
    // child — which runs `run` without --watch — so a bound port is fully released before
    // the replacement binds.
    const { spawn } = await import("node:child_process");
    const { watch } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const self = fileURLToPath(import.meta.url);
    const childArgs = ["run", ...args.filter((a) => a !== "--watch")];
    const watchDir = root ?? path.dirname(entry);

    let child: import("node:child_process").ChildProcess | null = null;
    const start = () => {
      child = spawn(process.execPath, [self, ...childArgs], { stdio: "inherit" });
      child.on("exit", () => { child = null; });
    };
    start();

    let timer: NodeJS.Timeout | undefined;
    watch(watchDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (child) { const c = child; child = null; c.once("exit", start); c.kill(); }
        else start();
      }, 150);
    });
    return;
  }

  // Build a core+server resolver and run the entry as steps, seeding the entry's own directory
  // (relative `{ file }` loads resolve against it; a `/`-prefixed path anchors at `root`) and
  // `env` (so templates can branch on `$env.*`). An HTTP app is just an entry with `listen` step(s).
  const abs = path.resolve(entry);
  const resolve = createResolver([...coreNodes, ...serverNodes({ root: root ?? "." })]);
  const context: Context = { ...entryContext(path.dirname(abs)), env: process.env as Record<string, string>, args: parseArgs(appArgs) };
  await Promise.resolve(resolve({ file: path.basename(abs) }, context));
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
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { jexs?: unknown };
  if (typeof pkg.jexs !== "string") {
    process.stderr.write(`jexs run: package "${target}" has no string "jexs" entry in its package.json\n`);
    process.exit(1);
  }
  return path.join(path.dirname(pkgJson), pkg.jexs);
}

if (cmd === "run") {
  await run(rest);
} else {
  usage(1);
}
