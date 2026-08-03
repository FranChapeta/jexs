// The client bundler — the build-time consumer of discovery. `jexs bundle` walks
// the project's browser node packages and produces a project-local dist/browser
// containing @jexs/client's runtime PLUS any third-party browser nodes, all
// sharing one @jexs/core (a single bundle, so the resolver singleton is one). The
// server prefers this local bundle over @jexs/client's prebuilt one when present.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as esbuild from "esbuild";
import { walkJexsPackages } from "./discover.js";
import { contributesNodes } from "./manifest.js";

/** Directory of the installed @jexs/client compiled output (dist/), for worker entries. */
function clientDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.resolve("@jexs/client")));
}

/**
 * Bundle the project's browser runtime into `dist/browser`. Generates an entry
 * that boots @jexs/client (which wires core/client/physics/gl) and then registers
 * every discovered `browser`/`both` third-party node package — @jexs/* packages
 * are skipped since @jexs/client already wires them. esbuild config mirrors
 * @jexs/client's own `build:browser` (ESM + splitting + the shared workers), so
 * the worker/service-worker cross-references resolve in the output dir.
 */
export async function bundleClient(
  projectDir: string,
  { outDir, watch = false }: { outDir?: string; watch?: boolean } = {},
): Promise<esbuild.BuildContext | void> {
  const clientDist = clientDistDir();
  const out = outDir ?? path.join(projectDir, "dist", "browser");

  const pkgs = walkJexsPackages(projectDir).filter(
    (p) => contributesNodes(p.manifest, "browser") && !p.name.startsWith("@jexs/"),
  );

  const imports = [`import "@jexs/client";`, `import { registerNode } from "@jexs/core";`];
  const regs: string[] = [];
  pkgs.forEach((p, i) => {
    imports.push(`import { nodes as n${i} } from ${JSON.stringify(p.name)};`);
    regs.push(`register(n${i});`);
  });
  const entrySrc =
    `${imports.join("\n")}\n` +
    `function register(c){ const list = typeof c === "function" ? c({}) : c; if (Array.isArray(list)) for (const n of list) registerNode(n); }\n` +
    // @jexs/client creates the resolver synchronously on import (when window exists),
    // so the resolver is ready before these registrations run.
    `if (typeof window !== "undefined") { ${regs.join(" ")} }\n`;

  const jexsDir = path.join(projectDir, ".jexs");
  mkdirSync(jexsDir, { recursive: true });
  const entryPath = path.join(jexsDir, "browser-entry.js");
  writeFileSync(entryPath, entrySrc);

  const buildOptions: esbuild.BuildOptions = {
    entryPoints: {
      client: entryPath,
      sw: path.join(clientDist, "sw.js"),
      physicsWorker: path.join(clientDist, "physicsWorker.js"),
      resolverWorker: path.join(clientDist, "resolverWorker.js"),
    },
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: out,
    entryNames: "[name]",
    chunkNames: "chunks/[hash]",
    minify: true,
    target: "es2022",
    absWorkingDir: projectDir,
    // Re-emit the HTML shells + raw templates after every (re)build.
    plugins: [{
      name: "jexs-pages",
      setup(build) { build.onEnd(() => { emitPages(projectDir, out); }); },
    }],
  };

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log(`jexs bundle: watching → ${out}`);
    return ctx;
  }

  rmSync(out, { recursive: true, force: true });
  await esbuild.build(buildOptions);
  console.log(`jexs bundle: ${pkgs.length} third-party browser package(s) → ${out}`);
}

/**
 * Emit the generated HTML shells — the only non-JS artifact in dist/browser.
 * There is NO build-time resolution: for each flat `src/*.json` (a window entry)
 * write a minimal shell whose #app has a `load` event that `file`-loads the
 * same-named template at runtime and sets it as innerHTML (DomNode hydrates it).
 * The templates themselves stay in src/ (source, read by the `file` node), so
 * dist/browser holds only compiled/generated output. A hand-written
 * public/index.html overrides the index shell.
 */
function emitPages(projectDir: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const srcDir = path.join(projectDir, "src");
  const custom = path.join(projectDir, "public", "index.html");
  const title = readPkgName(projectDir);

  const flat = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith(".json")) : [];
  if (flat.length === 0) {
    writeFileSync(path.join(outDir, "index.html"),
      existsSync(custom) ? readFileSync(custom, "utf8") : shellHtml(null, title));
    return;
  }
  for (const file of flat) {
    const name = file.slice(0, -".json".length);
    const dest = path.join(outDir, `${name}.html`);
    if (name === "index" && existsSync(custom)) { copyFileSync(custom, dest); continue; }
    writeFileSync(dest, shellHtml(name, title));
  }
}

/**
 * A minimal shell. With a `page`, #app carries a `load` event that fetches
 * `<page>.json` at runtime and mounts it (so context/params/logic resolve live);
 * without one, just an empty #app.
 */
function shellHtml(page: string | null, title: string): string {
  const events = page
    ? JSON.stringify([{ type: "load", do: [
        { file: `${page}.json`, as: "__root" },
        { setHtml: ["#app", { var: "$__root" }] },
      ] }])
    : null;
  const app = events ? `<div id="app" data-jexs-events='${events}'></div>` : `<div id="app"></div>`;
  return (
    `<!doctype html>\n<html>\n<head>\n` +
    `<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${title}</title>\n<script type="module" src="./client.js"></script>\n</head>\n` +
    `<body>${app}</body>\n</html>\n`
  );
}

function readPkgName(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as { name?: string };
    return pkg.name ?? "Jexs";
  } catch { return "Jexs"; }
}
