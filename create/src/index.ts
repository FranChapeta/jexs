#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── CLI flags ─────────────────────────────────────────────────────────────────

interface CliFlags {
  projectName?: string;
  env?: "server" | "client" | "both" | "electron";
  physics?: boolean;
  css?: "tailwind" | "none";
  help?: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--env=")) {
      flags.env = arg.slice("--env=".length).toLowerCase() as CliFlags["env"];
    } else if (arg === "--env") {
      const v = argv[++i];
      if (v) flags.env = v.toLowerCase() as CliFlags["env"];
    } else if (arg === "--physics") {
      flags.physics = true;
    } else if (arg === "--no-physics") {
      flags.physics = false;
    } else if (arg.startsWith("--css=")) {
      flags.css = arg.slice("--css=".length).toLowerCase() as CliFlags["css"];
    } else if (arg === "--css") {
      const v = argv[++i];
      if (v) flags.css = v.toLowerCase() as CliFlags["css"];
    } else if (!arg.startsWith("-") && !flags.projectName) {
      flags.projectName = arg;
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`Usage: create-jexs [project-name] [options]

Scaffolds a new Jexs project.

Options:
  --env <server|client|both|electron>   Which environment to install (default: prompt)
  --physics                    Include @jexs/physics and @jexs/gl (off by default)
  --css <tailwind|none>        Styling setup (default: tailwind on server projects)
  -h, --help                   Show this help

Examples:
  create-jexs my-app                                # interactive
  create-jexs my-app --env both --physics           # non-interactive
  create-jexs my-app --env server --css none        # plain CSS / bring your own
`);
}

// ── Prompt queue that handles piped/redirected stdin correctly ────────────────
//
// Node's readline emits a 'line' event for every line on the input stream,
// regardless of whether anyone is awaiting one. When stdin is piped (non-TTY),
// all lines can arrive before the first `rl.question` is called — and any
// 'line' fired before its question's listener is attached is lost. This causes
// `await rl.question(...)` after the first prompt to hang forever on piped
// input.
//
// Fix: subscribe to 'line' once, buffer lines into a queue, and have `ask()`
// drain from the queue (or attach a waiter if the queue is empty). Also strip
// the UTF-8 BOM that PowerShell prepends to string-piped stdin, which would
// otherwise make parseInt("﻿3") return NaN.

class PromptQueue {
  private rl: Interface;
  private lines: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  closed = false;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("line", line => {
      // Strip UTF-8 BOM (U+FEFF) that PowerShell prepends to piped string input.
      const cleaned = line.charCodeAt(0) === 0xFEFF ? line.slice(1) : line;
      const waiter = this.waiters.shift();
      if (waiter) waiter(cleaned);
      else this.lines.push(cleaned);
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()!("");
    });
  }

  ask(question: string): Promise<string> {
    process.stdout.write(question);
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve("");
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close(): void {
    this.rl.close();
  }
}

// ── Interactive helpers ───────────────────────────────────────────────────────

async function chooseFromOptions(
  q: PromptQueue,
  question: string,
  options: string[],
  flagHint: string,
): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  while (true) {
    const raw = (await q.ask(`Choice [1-${options.length}]: `)).trim();
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= options.length) return n - 1;
    if (!raw && q.closed) {
      console.error(
        `\nMissing input for "${question}". Pass ${flagHint} to set this non-interactively.`,
      );
      process.exit(1);
    }
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

// ── CLAUDE.md content ─────────────────────────────────────────────────────────
//
// Concise, AI-focused project guide. The audience is a coding agent about to
// touch JSON in this project — surface the high-cost mistakes once so the agent
// doesn't have to learn them by trial. Kept terse; long-form docs live on the
// website. Sections gated on scaffold options stay out when they don't apply.

function buildClaudeMd(useServer: boolean, useTailwind: boolean): string {
  const lines: string[] = [];

  lines.push(`# Jexs project`);
  lines.push(``);
  lines.push(`Almost everything in this project is JSON. The resolver in \`@jexs/core\` walks each object key and dispatches it to a typed Node class (e.g. \`if\`, \`foreach\`, \`tag\`, \`var\`, \`file\`, \`routes\`). Sibling keys are options for that Node.`);
  lines.push(``);
  lines.push(`## Pitfalls (read before authoring or editing JSON)`);
  lines.push(``);
  lines.push(`- **\`foreach\` returns only the LAST iteration's value.** Use \`map\` when you need an array of every result (rendering lists, building option arrays, etc.).`);
  lines.push(`- **\`if\` / \`switch\` branches that are arrays return only the LAST value** (they go through \`resolveSteps\`). When a branch needs to render multiple elements, wrap them in a single container — e.g. \`then: { tag: "div", content: [<h2>, <table>] }\` — not \`then: [<h2>, <table>]\`.`);
  if (useServer) {
    lines.push(`- **\`{ "file": "x.json" }\` resolves the file's contents as a Jexs expression by default.** Pass \`"data": true\` for raw parsed JSON — required for data files, route trees, schema dumps, anything you do NOT want the resolver to evaluate. Without \`data\`, an array file is run as a step sequence and an object file is resolved as a single expression.`);
  }
  lines.push(`- **Element content interpolates \`$identifier\` tokens.** Undefined vars become empty strings — code samples like \`{ "var": "$result" }\` would display as \`{ "var": "" }\`. Wrap any literal-\`$\` content in \`{ "raw": "..." }\`:`);
  lines.push(`  \`\`\`json`);
  lines.push(`  { "tag": "code", "content": { "raw": "{ \\"var\\": \\"$result\\" }" } }`);
  lines.push(`  \`\`\``);
  lines.push(`- **DOM event bindings use the \`events\` object**, not inline \`onclick\`/\`oninput\` attributes. The steps inside \`do\` run through the client resolver when the event fires:`);
  lines.push(`  \`\`\`json`);
  lines.push(`  { "tag": "button", "events": { "click": { "do": [...] } }, "content": "Run" }`);
  lines.push(`  \`\`\``);
  lines.push(``);

  lines.push(`## Layout`);
  lines.push(``);
  if (useServer) {
    lines.push(`- \`app/\` — JSON templates the resolver loads. FileNode's default base directory.`);
    lines.push(`- \`public/\` — static assets (CSS, images, favicons, fonts). Auto-served by the HTTP server for any GET on a static-extension URL.`);
    lines.push(`- No JS bootstrap — \`npm run dev\` / \`npm start\` run \`jexs run app/index.json app\` (the \`jexs\` CLI from @jexs/server), which resolves \`app/index.json\`; its \`listen\` step(s) bind the port(s).`);
    if (useTailwind) {
      lines.push(`- \`input.css\` — Tailwind entry. Add custom styles here (\`@layer base { ... }\`, \`@apply\`, etc.).`);
      lines.push(`- \`tailwind.config.js\` — scans \`./app/**/*.json\` for class names.`);
    }
  } else {
    lines.push(`- \`src/app.json\` — your entry expression. Browser-side Jexs apps load this via \`@jexs/client\`.`);
  }
  lines.push(``);

  if (useServer) {
    lines.push(`## Scripts`);
    lines.push(``);
    lines.push(`- \`npm run dev\` — \`jexs run app/index.json app --watch\` (restarts on changes under \`app/\`)${useTailwind ? ` + \`tailwindcss --watch\` in parallel via \`concurrently\`` : ``}.`);
    if (useTailwind) {
      lines.push(`- \`npm run build\` — compiles Tailwind (minified). There's no JS build — the app is JSON run by \`jexs run\`.`);
    }
    lines.push(`- \`npm start\` — \`jexs run app/index.json app --prod\`. Run from the project root so FileNode and the static server find \`app/\` and \`public/\`. The \`--prod\` flag sets \`process.env.prod = "1"\`, so JSON templates can branch on \`{ "var": "$env.prod" }\` (e.g. picking port 80 in prod vs 3000 in dev).`);
    lines.push(`- \`npm run format\` — Prettier sweep over JSON templates.`);
    lines.push(``);
  }

  lines.push(`## Dev tools`);
  lines.push(``);
  lines.push(`\`.mcp.json\` registers \`@jexs/mcp\` — an MCP server that gives AI assistants live introspection into the Jexs runtime. When editing JSON, prefer these tools over guessing:`);
  lines.push(``);
  lines.push(`- \`list_nodes\` — every registered handler key, grouped by Node class.`);
  lines.push(`- \`inspect_file\` — shows which handler keys a JSON file uses (and which are unknown).`);
  lines.push(`- \`resolve_expression\` — evaluates an arbitrary JSON expression against the live resolver.`);
  lines.push(``);
  lines.push(`MCP-compatible clients (Claude Code, Claude Desktop) pick the config up automatically.`);
  lines.push(``);

  return lines.join("\n");
}

// ── Renderer page template ──────────────────────────────────────────────────
//
// The root UI as a JSON Element tree (body content). It stays raw JSON in src/;
// a shell template `{ file }`-imports it and the whole document is resolved at
// RUNTIME (in the electron main process, or the @jexs server), so `{var: ...}`,
// `if`, and nested `{file: ...}` includes all resolve with live context/params.
// The client then hydrates it. Add interactivity with the `events` key; load
// nested components with `{ "file": "components/card.json" }`.

function pageTemplate(title: string, description: string): unknown {
  return {
    tag: "main",
    content: [
      { tag: "h1", content: title },
      { tag: "p", content: description },
    ],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) { printHelp(); return; }

  const queue = new PromptQueue();

  let projectName = flags.projectName ?? "";
  if (!projectName) {
    projectName = (await queue.ask("Project name: ")).trim();
  }
  if (!projectName) {
    console.error("Project name is required.");
    process.exit(1);
  }

  let env: "server" | "client" | "both" | "electron";
  if (flags.env === "server" || flags.env === "client" || flags.env === "both" || flags.env === "electron") {
    env = flags.env;
  } else {
    if (flags.env !== undefined) {
      console.error(`Invalid --env value "${flags.env}". Expected server, client, both, or electron.`);
      process.exit(1);
    }
    const idx = await chooseFromOptions(queue, "Which environment?", [
      "Server    (HTTP, DB, auth, routing)",
      "Client    (browser DOM, fetch, audio)",
      "Both",
      "Electron  (desktop app: window + IPC + client + server)",
    ], "--env <server|client|both|electron>");
    env = idx === 0 ? "server" : idx === 1 ? "client" : idx === 2 ? "both" : "electron";
  }

  // Physics + GL are off by default — most projects don't need a 3D engine.
  // Opt in with `--physics`; `--no-physics` is accepted but redundant.
  const usePhysics = flags.physics === true;

  queue.close();

  // Electron needs both runtimes: the main-process resolver (server nodes: files,
  // SQLite saves, ...) and the renderer bundle (client). It adds @jexs/electron
  // (window/dialog/app nodes) and the jexs-electron runner on top.
  const useElectron = env === "electron";
  const useServer = env === "server" || env === "both" || useElectron;
  const useClient = env === "client" || env === "both" || useElectron;

  // CSS: default to tailwind on server projects (since they serve HTML and need
  // a styles.css), default to none for client-only (which ships JSON-only). Flag
  // overrides either way. `--css` not prompted for — assume the default is fine.
  let useTailwind: boolean;
  if (flags.css === "tailwind") {
    useTailwind = true;
  } else if (flags.css === "none") {
    useTailwind = false;
  } else if (flags.css !== undefined) {
    console.error(`Invalid --css value "${flags.css}". Expected tailwind or none.`);
    process.exit(1);
  } else {
    useTailwind = useServer && !useElectron;
  }

  const dir = join(process.cwd(), projectName);
  if (existsSync(dir)) {
    console.error(`Directory "${projectName}" already exists.`);
    process.exit(1);
  }

  mkdirSync(dir);
  mkdirSync(join(dir, ".vscode"));
  mkdirSync(join(dir, ".claude"));
  if (useElectron) {
    // src/ holds the renderer's page templates (index.json, …). `jexs bundle`
    // compiles only JS; the runner serves a generated shell over app:// that mounts
    // the template at runtime. No app/ by default — the runner opens the index.json
    // window; add app/main.json only for custom main-process startup.
    mkdirSync(join(dir, "src"));
  } else if (useServer) {
    // app/ holds the JSON templates the resolver loads via FileNode (its default
    // base directory). public/ is auto-served by the HTTP server for static
    // assets (CSS, images, favicons, fonts). The TS bootstrap and tailwind
    // entry CSS both live at the root.
    mkdirSync(join(dir, "app"));
    mkdirSync(join(dir, "public"));
  } else {
    mkdirSync(join(dir, "src"));
  }

  const deps: Record<string, string> = { "@jexs/core": "latest" };
  if (useServer) deps["@jexs/server"] = "latest";
  if (useClient) deps["@jexs/client"] = "latest";
  if (useElectron) deps["@jexs/electron"] = "latest";
  if (usePhysics) { deps["@jexs/physics"] = "latest"; deps["@jexs/gl"] = "latest"; }

  // The `jexs` CLI (from @jexs/server) provides `jexs schema` (autocomplete) and
  // `jexs bundle` (the browser build). Server/both projects already depend on it;
  // client-only projects pull it in as a devDep for those two commands.
  const devDeps: Record<string, string> = { prettier: "^3.4.0" };
  if (!useServer) devDeps["@jexs/server"] = "latest";
  if (useServer && !useElectron) devDeps.concurrently = "^8.2.0";
  if (useTailwind) devDeps.tailwindcss = "^3.4.0";
  if (useElectron) { devDeps.electron = "^30.0.0"; devDeps["electron-builder"] = "^24.13.0"; }

  const scripts: Record<string, string> = {};
  if (useElectron) {
    // No JS bootstrap: `jexs bundle` builds the renderer (dist/browser, served
    // over app://), then `jexs-electron` (from @jexs/electron) opens the window
    // showing src/index.json — or runs app/main.json against the main-process
    // resolver if present. `build` packages a distributable with electron-builder.
    scripts.dev = "jexs bundle && jexs-electron";
    scripts.bundle = "jexs bundle";
    scripts.build = "jexs bundle && electron-builder";
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"app/**/*.json\"";
  } else if (useServer) {
    // There is no JS bootstrap — `jexs run` (the `jexs` CLI from @jexs/server) resolves
    // app/index.json as steps; its `listen` step(s) bind the port(s). Passing `app` as the
    // resolver root makes `/`-anchored file loads resolve under app/. cwd = project root, so
    // FileNode and the static server find app/ and public/ where they live.
    // dev:    `jexs run app/index.json app --watch` restarts the app on changes under app/.
    //         With tailwind, the CSS compiler runs in --watch alongside it via
    //         concurrently, so new class names in JSON produce updated CSS.
    // build:  only the CSS step (when tailwind is on). No JS build.
    // start:  `jexs run app/index.json app --prod`.
    // format: prettier sweep over the JSON templates — the bulk of a Jexs app.
    const tailwindWatch = "tailwindcss -i input.css -o public/styles.css --watch --minify";
    const tailwindBuild = "tailwindcss -i input.css -o public/styles.css --minify";

    // dev builds the browser bundle once (so the server can serve it immediately),
    // then runs the client bundler, the app, and (with tailwind) the CSS compiler
    // in parallel. `jexs bundle` produces ./dist/browser (client + any browser
    // nodes) served at /jexs — there is no prebuilt @jexs/client bundle.
    const names = [useTailwind ? "css" : null, "bundle", "app"].filter(Boolean).join(",");
    const cmds = [
      useTailwind ? `"${tailwindWatch}"` : null,
      `"jexs bundle --watch"`,
      `"jexs run app/index.json app --watch"`,
    ].filter(Boolean).join(" ");
    scripts.dev = `jexs bundle && concurrently -k -n ${names} ${cmds}`;
    scripts.bundle = "jexs bundle";
    scripts.build = useTailwind ? `${tailwindBuild} && jexs bundle` : "jexs bundle";
    scripts.start  = "jexs run app/index.json app --prod";
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"app/**/*.json\"";
  } else {
    scripts.dev = "jexs bundle --watch";
    scripts.build = "jexs bundle";
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"src/**/*.json\"";
  }

  // package.json
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: projectName,
      type: "module",
      ...(useElectron ? { main: "node_modules/@jexs/electron/dist/runner.js" } : {}),
      ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
      dependencies: deps,
      devDependencies: devDeps,
    }, null, 2) + "\n",
  );

  // .jexs-schema.json — a stable $ref to the project-local schema that `jexs schema`
  // generates into .jexs/ from the actually-installed packages (first- AND
  // third-party). Regenerated by the `postinstall` hook on every `npm install`.
  writeFileSync(
    join(dir, ".jexs-schema.json"),
    JSON.stringify({ $ref: "./.jexs/combined.schema.json" }, null, 2) + "\n",
  );

  // .vscode/settings.json — wires JSON schema for autocomplete + disables VS Code's
  // built-in JSON formatter so prettier handles it (consistent with the `format` script).
  // electron/client author the renderer page in src/; server (and both) use app/.
  const jsonGlobs = useElectron ? ["/src/**/*.json"] : useServer ? ["/app/**/*.json"] : ["/src/**/*.json"];
  writeFileSync(
    join(dir, ".vscode", "settings.json"),
    JSON.stringify({
      "editor.detectIndentation": false,
      "json.format.enable": false,
      "[json]":  { "editor.defaultFormatter": "esbenp.prettier-vscode" },
      "[jsonc]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },
      "json.schemas": [{ "fileMatch": jsonGlobs, "url": "./.jexs-schema.json" }],
    }, null, 2) + "\n",
  );

  // .prettierrc.json — printWidth 320 for JSON lets short objects collapse to one
  // line. Wide JSON templates are easier to scan than tall ones.
  writeFileSync(
    join(dir, ".prettierrc.json"),
    JSON.stringify({
      "$schema": "https://json.schemastore.org/prettierrc",
      objectWrap: "collapse",
      printWidth: 220,
      tabWidth: 2,
      useTabs: false,
      overrides: [{
        files: ["*.json", "*.jsonc"],
        options: { printWidth: 320, objectWrap: "collapse", tabWidth: 2 },
      }],
    }, null, 2) + "\n",
  );

  // .gitignore — node_modules, generated schema (.jexs/), the browser bundle
  // (dist/), and the tailwind CSS artifact. .jexs-schema.json is deliberately NOT
  // ignored: it's the stable $ref the committed .vscode/settings.json depends on,
  // so it must be tracked or a fresh clone loses autocomplete until the first
  // `npm install` regenerates the .jexs/ content it points to.
  writeFileSync(
    join(dir, ".gitignore"),
    "node_modules/\n.jexs/\ndist/\n" + (useTailwind ? "public/styles.css\n" : ""),
  );

  // .gitattributes — GitHub Linguist treats JSON as a "data" language by default
  // and hides it from the repo language stats. In a Jexs project the JSON files
  // under app/ (or src/ for client-only) are the actual source code, so we mark
  // them detectable and reclassify them as JSON source. Config JSON at the root
  // (package.json, etc.) is intentionally left alone.
  const templateDir = useServer ? "app" : "src";
  writeFileSync(
    join(dir, ".gitattributes"),
    `${templateDir}/**/*.json linguist-detectable=true\n` +
    `${templateDir}/**/*.json linguist-language=JSON\n`,
  );

  // .mcp.json — registers @jexs/mcp so MCP-compatible AI clients (Claude Code,
  // Claude Desktop, etc.) can introspect this project's Jexs node registry.
  // @jexs/mcp is a 100% JSON package (no bin), so it's launched via the `jexs`
  // CLI from @jexs/server: `jexs run @jexs/mcp` resolves the package's `jexs`
  // entry and runs it, rooted at the project (cwd) for schema discovery.
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "jexs-dev": { command: "npx", args: ["-y", "-p", "@jexs/server", "-p", "@jexs/mcp", "jexs", "run", "@jexs/mcp"] },
      },
    }, null, 2) + "\n",
  );

  // .claude/settings.json — pre-approves the jexs-dev MCP server so Claude Code
  // doesn't prompt for each introspection call. The @jexs/mcp tools are all
  // read-only (resolve/describe/list/inspect), so allowing them wholesale is safe.
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["mcp__jexs-dev"] },
    }, null, 2) + "\n",
  );

  // CLAUDE.md — the conventions + gotchas an AI assistant should know before
  // editing JSON in this project. Read automatically by Claude Code and many
  // other AI coding tools. Kept terse on purpose; the long-form docs live on
  // the website.
  writeFileSync(
    join(dir, "CLAUDE.md"),
    buildClaudeMd(useServer, useTailwind),
  );

  if (useElectron) {
    // Electron: jexs-electron opens the window and runs the main-process resolver;
    // the renderer loads the bundle from dist/browser. The app is just the renderer
    // page — src/index.json. For custom main-process startup (menus, extra windows,
    // tray) add an optional app/main.json and the runner will run it instead.

    // src/index.json — the renderer page, authored as a JSON Element tree. Opening
    // a window resolves a shell that `{ file }`-imports this template in the main
    // process (ElementNode → HTML, doctype + client script included) and serves it
    // over app://; the client hydrates any `events`. Main-process nodes (query,
    // file, dialog, …) are auto-forwarded, so call them directly from renderer JSON.
    writeFileSync(
      join(dir, "src", "index.json"),
      JSON.stringify(
        pageTemplate(projectName, "Edit src/index.json — the renderer page. Main-process nodes like query and dialog are auto-forwarded, so call them directly from here."),
        null, 2,
      ) + "\n",
    );

    // electron-builder.yml — packaging config. Native modules (better-sqlite3,
    // bcrypt from @jexs/server) must be unpacked from the asar to load.
    writeFileSync(
      join(dir, "electron-builder.yml"),
      `appId: com.example.${projectName.replace(/[^a-z0-9]/gi, "").toLowerCase() || "app"}\n` +
      `productName: ${projectName}\n` +
      `files:\n  - dist/browser/**\n  - src/**/*.json\n  - app/**/*.json\n  - node_modules/**\n` +
      `asarUnpack:\n  - "**/*.node"\n` +
      `directories:\n  output: release\n`,
    );
  } else if (useServer) {
    // No JS bootstrap: `npm run dev` / `npm start` invoke `jexs run app/index.json app` (the
    // `jexs` CLI from @jexs/server) which builds the resolver, roots FileNode at app/, and
    // resolves app/index.json — its `listen` step(s) bind the port(s).

    // app/index.json — minimal listener that returns a greeting from query string.
    writeFileSync(
      join(dir, "app", "index.json"),
      JSON.stringify([
        {
          listen: { "if": { var: "$env.prod" }, then: 80, else: 3000 },
          client: true,
          do: [
            { var: "$request.query.name" },
            { "if": { var: "$result" }, then: { concat: ["Hello, ", { var: "$result" }, "!"] }, else: "Hello, world!" },
          ],
        },
      ], null, 2) + "\n",
    );

    // public/.gitkeep — preserves the empty directory in git so users have
    // somewhere obvious to drop CSS, images, favicons.
    writeFileSync(join(dir, "public", ".gitkeep"), "");

    if (useTailwind) {
      // input.css — the Tailwind entry at the project root. Classes get extracted
      // from app/**/*.json at build time per the content glob in tailwind.config.js.
      // This is also where you add custom styles (@layer, @apply, @font-face, etc.).
      writeFileSync(
        join(dir, "input.css"),
        "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
      );

      // tailwind.config.js — ESM (package.json has "type":"module"). Scans the
      // JSON templates the resolver renders.
      writeFileSync(
        join(dir, "tailwind.config.js"),
        `/** @type {import('tailwindcss').Config} */\n` +
        `export default {\n` +
        `  content: ["./app/**/*.json"],\n` +
        `  darkMode: "class",\n` +
        `  theme: { extend: {} },\n` +
        `  plugins: [],\n` +
        `};\n`,
      );
    }
  } else {
    // Client-only: the page as a JSON Element tree. `jexs bundle` compiles the
    // renderer to dist/browser (JS only); serve it behind a host that resolves the
    // template into HTML and injects the client script (electron, or a @jexs
    // server) — the client then hydrates it.
    writeFileSync(
      join(dir, "src", "index.json"),
      JSON.stringify(
        pageTemplate(projectName, "Edit src/index.json — the page template, resolved to HTML by the host and hydrated by the client. Add interactivity with the events key."),
        null, 2,
      ) + "\n",
    );
  }

  console.log(`\nCreated ${projectName}/`);
  console.log(`  package.json`);
  console.log(`  .jexs-schema.json`);
  console.log(`  .vscode/settings.json`);
  console.log(`  .prettierrc.json`);
  console.log(`  .mcp.json`);
  console.log(`  .claude/settings.json`);
  console.log(`  .gitignore`);
  console.log(`  .gitattributes`);
  console.log(`  CLAUDE.md`);
  if (useElectron) {
    console.log(`  src/index.json`);
    console.log(`  electron-builder.yml`);
  } else if (useServer) {
    console.log(`  app/index.json`);
    console.log(`  public/.gitkeep`);
    if (useTailwind) {
      console.log(`  input.css`);
      console.log(`  tailwind.config.js`);
    }
  } else {
    console.log(`  src/index.json`);
  }
  console.log(`\nDone. Run:\n  cd ${projectName} && npm install${useServer ? " && npm run dev" : ""}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
