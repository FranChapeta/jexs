#!/usr/bin/env node
// jexs — the Jexs CLI. Two subcommands:
//
//   jexs run <entry.json> [root]     run a JSON template (stdio/CLI apps)
//   jexs serve [root] [--prod] [--watch]   boot the HTTP Server for a web app
//
// `run` resolves `entry` as steps relative to its own directory (a `/`-prefixed
// path inside anchors at `root`, default cwd). `serve` roots at `root` (default
// "app") and starts the HTTP Server (which resolves its entry file, whose
// `listen` binds the port). `--prod` sets process.env.prod; `--watch` restarts
// the server when files under `root` change.
import { createResolver, coreNodes } from "@jexs/core";
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

if (cmd === "run") {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [entry, root] = positional;
  if (!entry) usage(1);
  await Promise.resolve(runApp(entry, { root: root ?? "." }));
} else if (cmd === "serve") {
  await serve(rest);
} else {
  usage(cmd ? 1 : 1);
}
