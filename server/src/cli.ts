#!/usr/bin/env node
// jexs — the Jexs CLI. Two subcommands:
//
//   jexs run <entry|package> [root]  run a JSON template (stdio/CLI apps)
//   jexs serve [root] [--prod] [--watch]   boot the HTTP Server for a web app
//
// `run` takes a file path OR an installed package name: a package is resolved
// via its package.json `"jexs"` entry field, so a pure-JSON package (no bin, no
// JS) is launched with `jexs run <package>`. The entry runs as steps relative to
// its own directory (a `/`-prefixed path anchors at `root`, default cwd). `serve`
// roots at `root` (default "app") and starts the HTTP Server (which resolves its
// entry file, whose `listen` binds the port). `--prod` sets process.env.prod;
// `--watch` restarts the server when files under `root` change.
import { createResolver, coreNodes } from "@jexs/core";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runApp, serverNodes, Server } from "./index.js";

const [cmd, ...rest] = process.argv.slice(2);

function usage(code: number): never {
  process.stderr.write(
    "usage:\n" +
    "  jexs run <entry.json> [root]\n" +
    "  jexs serve [root] [--prod] [--watch]\n",
  );
  process.exit(code);
}

async function serve(args: string[]): Promise<void> {
  if (args.includes("--prod")) process.env.prod = "1";
  const root = args.find((a) => !a.startsWith("--")) ?? "app";

  if (args.includes("--watch")) {
    // Supervisor: run the server in a child and restart it on changes under
    // `root` (templates are read at runtime, so a restart re-resolves them).
    // Kept out of the child — which runs `serve` without --watch — so the port
    // is fully released before the replacement binds.
    const { spawn } = await import("node:child_process");
    const { watch } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const self = fileURLToPath(import.meta.url);
    const childArgs = ["serve", ...args.filter((a) => a !== "--watch")];

    let child: import("node:child_process").ChildProcess | null = null;
    const start = () => {
      child = spawn(process.execPath, [self, ...childArgs], { stdio: "inherit" });
      child.on("exit", () => { child = null; });
    };
    start();

    let timer: NodeJS.Timeout | undefined;
    watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (child) { const c = child; child = null; c.once("exit", start); c.kill(); }
        else start();
      }, 150);
    });
    return;
  }

  const resolve = createResolver([...coreNodes, ...serverNodes({ root })]);
  await new Server(resolve).start();
}

// Resolve a `run` target to an entry file path: a local file/dir is used as-is;
// anything else is treated as an installed package and resolved via its
// package.json `"jexs"` field (relative to that package).
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
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [target, root] = positional;
  if (!target) usage(1);
  await Promise.resolve(runApp(resolveEntry(target), { root: root ?? "." }));
} else if (cmd === "serve") {
  await serve(rest);
} else {
  usage(cmd ? 1 : 1);
}
