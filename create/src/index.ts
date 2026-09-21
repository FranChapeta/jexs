#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── JSON output ───────────────────────────────────────────────────────────────

/** JSON print width from the `.prettierrc.json` override this scaffold writes. */
const JSON_PRINT_WIDTH = 320;

/**
 * Prettier gives an array one element per line, however short it is, once it
 * holds more than one element and every one of them is an object with more than
 * one key (or a multi-element array). A list of records reads as rows, so width
 * does not get a vote. Matching it matters because element trees hit this on
 * almost every `content` array.
 */
function alwaysBreaks(items: readonly unknown[]): boolean {
  if (items.length <= 1) return false;
  return items.every((item) => {
    if (item === null || typeof item !== "object") return false;
    return Array.isArray(item) ? item.length > 1 : Object.keys(item).length > 1;
  });
}

/**
 * Serialize the way the prettier config this scaffold ships would: a value goes
 * on one line when it fits the JSON print width at its indentation, and breaks
 * across lines with a two-space indent when it does not (`objectWrap: collapse`).
 *
 * `JSON.stringify(value, null, 2)` cannot express that, since it expands every
 * object and array unconditionally. The difference is not cosmetic: it means a
 * generated project is born unformatted by its own rules, so the first
 * `npm run format` or format-on-save rewrites files nobody edited.
 *
 * `package.json` is the exception and keeps `JSON.stringify`: prettier picks the
 * `json-stringify` parser from that filename, which never collapses.
 */
function formatJson(value: unknown, indent = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  const pad = " ".repeat(indent);
  const padInner = " ".repeat(indent + 2);
  const fits = (line: string): boolean =>
    // A child that broke is already too wide at the deeper indent, so the parent
    // on one line (which is longer still) cannot fit either.
    indent + line.length <= JSON_PRINT_WIDTH && !line.includes("\n");

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((item) => formatJson(item, indent + 2));
    const oneLine = `[${parts.join(", ")}]`;
    if (!alwaysBreaks(value) && fits(oneLine)) return oneLine;
    return `[\n${parts.map((part) => padInner + part).join(",\n")}\n${pad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const parts = entries.map(([key, val]) => `${JSON.stringify(key)}: ${formatJson(val, indent + 2)}`);
  const oneLine = `{ ${parts.join(", ")} }`;
  if (fits(oneLine)) return oneLine;
  return `{\n${parts.map((part) => padInner + part).join(",\n")}\n${pad}}`;
}

/**
 * The Node floor a generated project declares, matching what the Jexs packages
 * themselves require. Without it a project installs cleanly on an older Node and
 * fails at runtime instead, with nothing pointing at the version as the cause.
 *
 * Travels with the release for the same reason the versions below do: it has to
 * track the floor those packages declare.
 */
const NODE_ENGINE = ">=24";

/**
 * What a generated project pins the Jexs packages to.
 *
 * Concrete ranges rather than "latest", so a project scaffolded today keeps
 * resolving to the line it was built against: "latest" writes itself into the
 * generated package.json verbatim, which means every later install silently
 * moves the project onto whatever has since been published, across majors.
 *
 * These travel with the release, so they belong to the release bump: whenever a
 * package's version changes, its entry here changes with it.
 */
const JEXS_VERSIONS = {
  "@jexs/core": "^1.3.0",
  "@jexs/server": "^1.1.0",
  "@jexs/client": "^1.0.0",
  "@jexs/electron": "^0.7.0",
  "@jexs/physics": "^0.6.0",
  "@jexs/gl": "^0.6.0",
  "@jexs/mcp": "^0.10.0",
} as const;

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
  --css <tailwind|none>        Styling setup (default: tailwind, except client-only, which has no page)
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

function buildClaudeMd(useServer: boolean, useTailwind: boolean, useElectron: boolean): string {
  const lines: string[] = [];

  lines.push(`# Jexs project`);
  lines.push(``);
  lines.push(`Almost everything in this project is JSON. The resolver in \`@jexs/core\` walks each object key and dispatches it to a typed Node class (e.g. \`if\`, \`foreach\`, \`tag\`, \`var\`, \`file\`, \`routes\`). Sibling keys are options for that Node.`);
  lines.push(``);
  lines.push(`## Pitfalls (read before authoring or editing JSON)`);
  lines.push(``);
  lines.push(`- **\`foreach\` returns only the LAST iteration's value.** Use \`map\` when you need an array of every result (rendering lists, building option arrays, etc.).`);
  lines.push(`- **\`if\` / \`switch\` branches that are arrays return only the LAST value** (they go through \`resolveSteps\`). When a branch needs to render multiple elements, wrap them in a single container, e.g. \`then: { tag: "div", content: [<h2>, <table>] }\`, not \`then: [<h2>, <table>]\`.`);
  if (useServer) {
    lines.push(`- **\`{ "file": "x.json" }\` resolves the file's contents as a Jexs expression by default.** Pass \`"data": true\` for raw parsed JSON, required for data files, route trees, schema dumps, anything you do NOT want the resolver to evaluate. Without \`data\`, an array file is run as a step sequence and an object file is resolved as a single expression.`);
  }
  lines.push(`- **Element content interpolates \`$identifier\` tokens.** Undefined vars become empty strings, so code samples like \`{ "var": "$result" }\` would display as \`{ "var": "" }\`. Wrap any literal-\`$\` content in \`{ "raw": "..." }\`:`);
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
  // Electron satisfies useServer (it runs a main-process resolver), so it has to
  // be tested first or it inherits the HTTP server's layout, which describes
  // neither its directories nor its commands.
  if (useElectron) {
    lines.push(`- \`src/\`: renderer templates. The main process resolves one to HTML and serves it over \`app://\`; \`src/index.json\` is the page the first window opens.`);
    lines.push(`- \`src/main.json\`: OPTIONAL main-process startup, run before any window exists (menus, tray, extra windows). Without it the runner just opens a window on \`src/index.json\`.`);
    lines.push(`- \`dist/browser/\`: \`jexs bundle\` output, and the only directory \`app://\` serves. Rebuilt from scratch on every bundle.`);
    lines.push(`- Main-process nodes (\`file\`, \`query\`, \`dialog\`, …) are forwarded from the renderer, so renderer JSON calls them directly. A relative \`{ "file": "x.json" }\` resolves against the calling page's own directory.`);
    lines.push(`- A \`/\`-prefixed path anchors at \`src/\`, from anywhere, including \`src/main.json\`, so main-process startup reaches a page with \`/index.json\`. Without the slash a path is relative to the file doing the loading.`);
    if (useTailwind) {
      lines.push(`- \`input.css\`: Tailwind entry. Add custom styles here (\`@layer base { ... }\`, \`@apply\`, etc.).`);
      lines.push(`- \`tailwind.config.js\`: scans \`./src/**/*.json\` for class names. The stylesheet builds to \`dist/browser/styles.css\` AFTER \`jexs bundle\`, which clears that directory, and the window shell links it.`);
    }
  } else if (useServer) {
    lines.push(`- \`src/\`: JSON templates the resolver loads. FileNode's default base directory.`);
    lines.push(`- \`public/\`: static assets (CSS, images, favicons, fonts). Auto-served by the HTTP server for any GET on a static-extension URL.`);
    lines.push(`- No JS bootstrap: \`npm run dev\` / \`npm start\` run \`jexs run src/index.json src\` (the \`jexs\` CLI from @jexs/server), which resolves \`src/index.json\`; its \`listen\` step(s) bind the port(s).`);
    if (useTailwind) {
      lines.push(`- \`input.css\`: Tailwind entry. Add custom styles here (\`@layer base { ... }\`, \`@apply\`, etc.).`);
      lines.push(`- \`tailwind.config.js\`: scans \`./src/**/*.json\` for class names.`);
    }
  } else {
    lines.push(`- \`src/index.json\`: your entry expression. Browser-side Jexs apps load this via \`@jexs/client\`.`);
  }
  lines.push(``);

  if (useElectron) {
    lines.push(`## Scripts`);
    lines.push(``);
    lines.push(`- \`npm run dev\`: bundles the renderer${useTailwind ? `, compiles Tailwind` : ``}, then runs \`jexs-electron --dev\`, which opens devtools on every window and reloads them when a template under \`src/\` changes. Editing \`src/main.json\` does NOT reload, since main-process startup cannot be re-run in place.`);
    lines.push(`- \`npm start\`: the same without devtools or watching.`);
    lines.push(`- \`npm run build\`: bundles${useTailwind ? ` and compiles Tailwind` : ``}, then packages a distributable with electron-builder.`);
    lines.push(`- \`npm run format\`: Prettier sweep over the JSON templates.`);
    lines.push(``);
  } else if (useServer) {
    lines.push(`## Scripts`);
    lines.push(``);
    lines.push(`- \`npm run dev\`: \`jexs run src/index.json src --watch\` (restarts on changes under \`src/\`)${useTailwind ? ` + \`tailwindcss --watch\` in parallel via \`concurrently\`` : ``}.`);
    if (useTailwind) {
      lines.push(`- \`npm run build\`: compiles Tailwind (minified). There is no JS build, the app is JSON run by \`jexs run\`.`);
    }
    lines.push(`- \`npm start\`: \`jexs run src/index.json src --prod\`. Run from the project root so FileNode and the static server find \`src/\` and \`public/\`. The \`--prod\` flag sets \`process.env.prod = "1"\`, so JSON templates can branch on \`{ "var": "$env.prod" }\` (e.g. picking port 80 in prod vs 3000 in dev).`);
    lines.push(`- \`npm run format\`: Prettier sweep over JSON templates.`);
    lines.push(``);
  }

  lines.push(`## Dev tools`);
  lines.push(``);
  lines.push(`\`.mcp.json\` registers \`@jexs/mcp\`: an MCP server that gives AI assistants live introspection into the Jexs runtime. It runs the copy installed in \`node_modules\`, and reads the \`.jexs/\` schemas that \`npm run schema\` generates. When editing JSON, prefer these tools over guessing:`);
  lines.push(``);
  lines.push(`- \`search_ops\`: find an operation by name or description. Start here.`);
  lines.push(`- \`describe_op\`: one operation's siblings, required keys, return type and examples. Also covers the global step keys (\`as\`, \`return\`, \`catch\`, \`then\`, \`bubble\`).`);
  lines.push(`- \`list_nodes\`: every registered handler key, grouped by Node class. Large; use \`search_ops\` unless you want the whole surface.`);
  lines.push(`- \`describe_def\`: a shared \`#/$defs/\` shape, e.g. \`_routeNode\`.`);
  lines.push(`- \`validate_file\`: check a template against the project schema (what the editor uses).`);
  lines.push(`- \`inspect_file\`: which handler keys a file uses, plus likely typos and dispatch foot-guns.`);
  lines.push(`- \`resolve_expression\`: evaluate a JSON expression against the live resolver.`);
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

/**
 * The starter page. With tailwind on it carries a few utility classes, because
 * a content glob that matches no classes at all makes the very first build warn
 * that none were detected, and emits a stylesheet of reset rules and nothing
 * else. A couple of real classes make the pipeline visible instead.
 */
function pageTemplate(title: string, description: string, styled = false): unknown {
  return {
    tag: "main",
    ...(styled ? { class: "p-8" } : {}),
    content: [
      { tag: "h1", ...(styled ? { class: "text-3xl font-bold" } : {}), content: title },
      { tag: "p", ...(styled ? { class: "mt-2 text-gray-600" } : {}), content: description },
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

  // CSS: default to tailwind wherever the project renders a page of its own, so
  // server, both, and electron (whose renderer is served over app://). Default to
  // none for client-only, which ships JSON and no page. Flag overrides either
  // way. `--css` not prompted for: assume the default is fine.
  let useTailwind: boolean;
  if (flags.css === "tailwind") {
    // A client-only project has no HTML of its own: whatever hosts the bundle
    // supplies the page, so the scaffold has nowhere to build a stylesheet to and
    // nothing to link it from. Refuse rather than install tailwindcss and wire up
    // neither.
    if (!useServer) {
      console.error(`--css=tailwind needs a project that renders its own page. A client-only project is hosted by something else, which owns the HTML. Use --env=server, --env=both or --env=electron.`);
      process.exit(1);
    }
    useTailwind = true;
  } else if (flags.css === "none") {
    useTailwind = false;
  } else if (flags.css !== undefined) {
    console.error(`Invalid --css value "${flags.css}". Expected tailwind or none.`);
    process.exit(1);
  } else {
    useTailwind = useServer;
  }

  // Where the compiled stylesheet lands, and the URL a page links it by. A server
  // serves public/ at the root; electron's app:// handler serves dist/browser and
  // nothing else, which is also why the electron build has to run tailwind AFTER
  // `jexs bundle`, since that clears the directory before each build.
  const cssOut = useElectron ? "dist/browser/styles.css" : "public/styles.css";
  const cssHref = "/styles.css";

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
    // the template at runtime. The runner opens the index.json window; add a
    // src/main.json only for custom main-process startup.
    mkdirSync(join(dir, "src"));
  } else if (useServer) {
    // src/ holds the JSON templates the resolver loads via FileNode (its default
    // base directory). public/ is auto-served by the HTTP server for static
    // assets (CSS, images, favicons, fonts). The TS bootstrap and tailwind
    // entry CSS both live at the root.
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "public"));
  } else {
    mkdirSync(join(dir, "src"));
  }

  const deps: Record<string, string> = { "@jexs/core": JEXS_VERSIONS["@jexs/core"] };
  if (useServer) deps["@jexs/server"] = JEXS_VERSIONS["@jexs/server"];
  if (useClient) deps["@jexs/client"] = JEXS_VERSIONS["@jexs/client"];
  if (useElectron) deps["@jexs/electron"] = JEXS_VERSIONS["@jexs/electron"];
  if (usePhysics) {
    deps["@jexs/physics"] = JEXS_VERSIONS["@jexs/physics"];
    deps["@jexs/gl"] = JEXS_VERSIONS["@jexs/gl"];
  }

  // The `jexs` CLI (from @jexs/server) provides `jexs schema` (autocomplete) and
  // `jexs bundle` (the browser build). Server/both projects already depend on it;
  // client-only projects pull it in as a devDep for those two commands.
  // prettier >=3.5 is a real floor, not a tidy-up: the `.prettierrc.json` written
  // below sets `objectWrap`, which 3.4 and earlier warn about and ignore.
  // tailwind stays on 3.x deliberately. v4 moved the CLI out to @tailwindcss/cli
  // and replaced the JS config with CSS directives, so it is a migration rather
  // than a version bump.
  // @jexs/mcp is pinned rather than fetched with `npx -y` at launch: the MCP
  // server reads the `.jexs/` schemas this project's own @jexs/server generated,
  // so the two have to be the same release. Installing it also means the server
  // starts offline and without a registry round-trip on every editor launch.
  const devDeps: Record<string, string> = { prettier: "^3.5.0", "@jexs/mcp": JEXS_VERSIONS["@jexs/mcp"] };
  if (!useServer) devDeps["@jexs/server"] = JEXS_VERSIONS["@jexs/server"];
  if (useServer && !useElectron) devDeps.concurrently = "^10.0.0";
  if (useTailwind) devDeps.tailwindcss = "^3.4.0";
  if (useElectron) { devDeps.electron = "^44.0.0"; devDeps["electron-builder"] = "^26.0.0"; }

  const scripts: Record<string, string> = {};
  if (useElectron) {
    // No JS bootstrap: `jexs bundle` builds the renderer (dist/browser, served
    // over app://), then `jexs-electron` (from @jexs/electron) opens the window
    // showing src/index.json, or runs src/main.json against the main-process
    // resolver if present.
    // dev:   `--dev` opens devtools on every window and reloads them when a
    //        template under src/ changes.
    // start: the same run without it, i.e. what a user sees.
    // build: packages a distributable with electron-builder.
    // With tailwind the CSS is compiled into the bundle output, so it rides along
    // in every script that bundles, and always after it.
    const bundle = useTailwind
      ? `jexs bundle && tailwindcss -i input.css -o ${cssOut} --minify`
      : "jexs bundle";
    scripts.dev = `${bundle} && jexs-electron --dev`;
    scripts.bundle = bundle;
    scripts.build = `${bundle} && electron-builder`;
    scripts.start = `${bundle} && jexs-electron`;
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"src/**/*.json\"";
  } else if (useServer) {
    // There is no JS bootstrap: `jexs run` (the `jexs` CLI from @jexs/server) resolves
    // src/index.json as steps; its `listen` step(s) bind the port(s). Passing `src` as the
    // resolver root makes `/`-anchored file loads resolve under src/. cwd = project root, so
    // FileNode and the static server find src/ and public/ where they live.
    // dev:    `jexs run src/index.json src --watch` restarts the app on changes under src/.
    //         With tailwind, the CSS compiler runs in --watch alongside it via
    //         concurrently, so new class names in JSON produce updated CSS.
    // build:  only the CSS step (when tailwind is on). No JS build.
    // start:  `jexs run src/index.json src --prod`.
    // format: prettier sweep over the JSON templates, the bulk of a Jexs app.
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
      `"jexs run src/index.json src --watch"`,
    ].filter(Boolean).join(" ");
    scripts.dev = `jexs bundle && concurrently -k -n ${names} ${cmds}`;
    scripts.bundle = "jexs bundle";
    scripts.build = useTailwind ? `${tailwindBuild} && jexs bundle` : "jexs bundle";
    scripts.start  = "jexs run src/index.json src --prod";
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"src/**/*.json\"";
  } else {
    scripts.dev = "jexs bundle --watch";
    scripts.build = "jexs bundle";
    scripts.schema = "jexs schema";
    scripts.postinstall = "jexs schema";
    scripts.format = "prettier --write \"src/**/*.json\"";
  }

  // package.json — the one JSON file that is NOT written through formatJson.
  // Prettier infers the `json-stringify` parser from the filename, which prints
  // exactly what `JSON.stringify(value, null, 2)` does and never collapses, so
  // matching it here means matching prettier.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: projectName,
      type: "module",
      engines: { node: NODE_ENGINE },
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
    formatJson({ $ref: "./.jexs/combined.schema.json" }) + "\n",
  );

  // .vscode/settings.json — wires JSON schema for autocomplete + disables VS Code's
  // built-in JSON formatter so prettier handles it (consistent with the `format` script).
  // Every layout keeps its templates in src/.
  // Electron gets both, matching its `format` script: renderer templates in src/,
  const jsonGlobs = useElectron
    ? ["/src/**/*.json"]
    : ["/src/**/*.json"];
  writeFileSync(
    join(dir, ".vscode", "settings.json"),
    formatJson({
      "editor.detectIndentation": false,
      "json.format.enable": false,
      "[json]":  { "editor.defaultFormatter": "esbenp.prettier-vscode" },
      "[jsonc]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },
      "json.schemas": [{ "fileMatch": jsonGlobs, "url": "./.jexs-schema.json" }],
    }) + "\n",
  );

  // .prettierrc.json — printWidth 320 for JSON lets short objects collapse to one
  // line. Wide JSON templates are easier to scan than tall ones.
  writeFileSync(
    join(dir, ".prettierrc.json"),
    formatJson({
      "$schema": "https://json.schemastore.org/prettierrc",
      objectWrap: "collapse",
      printWidth: 220,
      tabWidth: 2,
      useTabs: false,
      overrides: [{
        files: ["*.json", "*.jsonc"],
        options: { printWidth: 320, objectWrap: "collapse", tabWidth: 2 },
      }],
    }) + "\n",
  );

  // .gitignore — node_modules, generated schema (.jexs/), the browser bundle
  // (dist/), and the tailwind CSS artifact. .jexs-schema.json is deliberately NOT
  // ignored: it's the stable $ref the committed .vscode/settings.json depends on,
  // so it must be tracked or a fresh clone loses autocomplete until the first
  // `npm install` regenerates the .jexs/ content it points to.
  // An electron project's stylesheet is built into dist/browser, which `dist/`
  // already covers, so only a served project needs the extra line.
  writeFileSync(
    join(dir, ".gitignore"),
    "node_modules/\n.jexs/\ndist/\n" + (useTailwind && !useElectron ? `${cssOut}\n` : ""),
  );

  // .gitattributes — GitHub Linguist treats JSON as a "data" language by default
  // and hides it from the repo language stats. In a Jexs project the JSON files
  // under src/ are the actual source code, so we mark
  // them detectable and reclassify them as JSON source. Config JSON at the root
  // (package.json, etc.) is intentionally left alone.
  const templateDir = "src";
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
  //
  // Both packages are devDependencies, so this runs the INSTALLED copies rather
  // than whatever `npx -y` would fetch. That matters because the server reads the
  // `.jexs/` schemas this project's @jexs/server generated on postinstall: fetched
  // latest against a pinned generator is exactly how the two drift apart. The
  // relative path is deliberate too, since MCP clients launch the server with the
  // project root as cwd, which is also what roots the resolver.
  writeFileSync(
    join(dir, ".mcp.json"),
    formatJson({
      mcpServers: {
        "jexs-dev": { command: "node", args: ["node_modules/@jexs/server/dist/cli.js", "run", "@jexs/mcp"] },
      },
    }) + "\n",
  );

  // .claude/settings.json — pre-approves the jexs-dev MCP server so Claude Code
  // doesn't prompt for each introspection call. The @jexs/mcp tools only read
  // (search/describe/list/inspect/validate); `resolve_expression` evaluates against
  // a live resolver, so it can do whatever a template can.
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    formatJson({
      permissions: { allow: ["mcp__jexs-dev"] },
    }) + "\n",
  );

  // CLAUDE.md — the conventions + gotchas an AI assistant should know before
  // editing JSON in this project. Read automatically by Claude Code and many
  // other AI coding tools. Kept terse on purpose; the long-form docs live on
  // the website.
  writeFileSync(
    join(dir, "CLAUDE.md"),
    buildClaudeMd(useServer, useTailwind, useElectron),
  );

  if (useElectron) {
    // Electron: jexs-electron opens the window and runs the main-process resolver;
    // the renderer loads the bundle from dist/browser. The app is just the renderer
    // page — src/index.json. For custom main-process startup (menus, extra windows,
    // tray) add an optional src/main.json and the runner will run it instead.

    // src/index.json — the renderer page, authored as a JSON Element tree. Opening
    // a window resolves a shell that `{ file }`-imports this template in the main
    // process (ElementNode → HTML, doctype + client script included) and serves it
    // over app://; the client hydrates any `events`. Main-process nodes (query,
    // file, dialog, …) are auto-forwarded, so call them directly from renderer JSON.
    writeFileSync(
      join(dir, "src", "index.json"),
      formatJson(
        pageTemplate(projectName, "Edit src/index.json to change this page. Main-process nodes like query and dialog are auto-forwarded, so call them directly from here.", useTailwind),
      ) + "\n",
    );

    // electron-builder.yml — packaging config. Native modules (better-sqlite3,
    // bcrypt from @jexs/server) must be unpacked from the asar to load.
    writeFileSync(
      join(dir, "electron-builder.yml"),
      `appId: com.example.${projectName.replace(/[^a-z0-9]/gi, "").toLowerCase() || "app"}\n` +
      `productName: ${projectName}\n` +
      `files:\n  - dist/browser/**\n  - src/**/*.json\n  - node_modules/**\n` +
      `asarUnpack:\n  - "**/*.node"\n` +
      `directories:\n  output: release\n`,
    );
  } else if (useServer) {
    // No JS bootstrap: `npm run dev` / `npm start` invoke `jexs run src/index.json src` (the
    // `jexs` CLI from @jexs/server) which builds the resolver, roots FileNode at src/, and
    // resolves src/index.json, its `listen` step(s) bind the port(s).

    // src/index.json: minimal listener that returns a greeting from query string.
    writeFileSync(
      join(dir, "src", "index.json"),
      formatJson([
        {
          listen: { "if": { var: "$env.prod" }, then: 80, else: 3000 },
          client: true,
          do: [
            { var: "$request.query.name" },
            { "if": { var: "$result" }, then: { concat: ["Hello, ", { var: "$result" }, "!"] }, else: "Hello, world!" },
            // With tailwind the greeting becomes a page, because a bare string
            // response has no <head> to link the compiled stylesheet from and the
            // CSS would be built on every run and loaded by nothing.
            ...(useTailwind
              ? [{
                  tag: "html",
                  content: [
                    { tag: "head", content: [{ tag: "meta", charset: "utf-8" }, { tag: "link", rel: "stylesheet", href: cssHref }] },
                    { tag: "body", class: "p-8", content: [{ tag: "h1", class: "text-3xl font-bold", content: { var: "$result" } }] },
                  ],
                }]
              : []),
          ],
        },
      ]) + "\n",
    );

    // public/.gitkeep — preserves the empty directory in git so users have
    // somewhere obvious to drop CSS, images, favicons.
    writeFileSync(join(dir, "public", ".gitkeep"), "");

  } else {
    // Client-only: the page as a JSON Element tree. `jexs bundle` compiles the
    // renderer to dist/browser (JS only); serve it behind a host that resolves the
    // template into HTML and injects the client script (electron, or a @jexs
    // server) — the client then hydrates it.
    writeFileSync(
      join(dir, "src", "index.json"),
      formatJson(
        pageTemplate(projectName, "Edit src/index.json to change this page. The host resolves it to HTML and the client hydrates it. Add interactivity with the events key."),
      ) + "\n",
    );
  }

  if (useTailwind) {
    // input.css — the Tailwind entry at the project root. Classes are extracted
    // from the JSON templates at build time per the content glob below. This is
    // also where custom styles go (@layer, @apply, @font-face, and the rest).
    writeFileSync(
      join(dir, "input.css"),
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
    );

    // tailwind.config.js — ESM (package.json has "type":"module"). Scans wherever
    // this project's templates live, which is the one thing that moves between
    // layouts, though every layout now keeps them in src/.
    writeFileSync(
      join(dir, "tailwind.config.js"),
      `/** @type {import('tailwindcss').Config} */\n` +
      `export default {\n` +
      `  content: ["./src/**/*.json"],\n` +
      `  darkMode: "class",\n` +
      `  theme: { extend: {} },\n` +
      `  plugins: [],\n` +
      `};\n`,
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
    console.log(`  src/index.json`);
    console.log(`  public/.gitkeep`);
  } else {
    console.log(`  src/index.json`);
  }
  if (useTailwind) {
    console.log(`  input.css`);
    console.log(`  tailwind.config.js`);
  }
  console.log(`\nDone. Run:\n  cd ${projectName} && npm install${useServer ? " && npm run dev" : ""}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
