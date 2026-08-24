// The client bundler — the build-time consumer of discovery. `jexs bundle` walks
// the project's browser node packages and produces a project-local dist/browser
// containing @jexs/client's runtime PLUS any third-party browser nodes, all
// sharing one @jexs/core (a single bundle, so the resolver singleton is one). The
// server prefers this local bundle over @jexs/client's prebuilt one when present.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as esbuild from "esbuild";
import { walkJexsPackages } from "./discover.js";
import { contributesNodes } from "./manifest.js";

/** Directory of the installed @jexs/client compiled output (dist/), for worker entries. */
function clientDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.resolve("@jexs/client")));
}

/** Whether an optional package is installed in this project. */
function isInstalled(pkg: string): boolean {
  try {
    import.meta.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bundle the project's browser runtime into `dist/browser`. Generates an entry
 * that boots @jexs/client (which wires core/client/physics/gl) and then registers
 * every discovered `browser`/`both` third-party node package — @jexs/* packages
 * are skipped since @jexs/client already wires them. esbuild config mirrors
 * @jexs/client's own `build:browser` (ESM + splitting + the shared workers), so
 * the worker/service-worker cross-references resolve in the output dir.
 *
 * Emits only compiled output (no HTML): pages are JSON templates in `src/`,
 * resolved to HTML at runtime. The @jexs/server SSR path renders them directly,
 * and the electron runner resolves a shell template that `{ file }`-imports the
 * page over `app://` — neither needs a build-time page file.
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

  const entryPoints: Record<string, string> = {
    client: entryPath,
    sw: path.join(clientDist, "sw.js"),
    resolverWorker: path.join(clientDist, "resolverWorker.js"),
  };
  // The physics worker STATICALLY imports @jexs/physics, so unlike the lazy
  // registrations it cannot be rescued by a `.catch()` — listing it as an entry
  // in an app without physics fails the entire bundle. Nothing references the
  // emitted file unless a physics op runs, which needs the package anyway.
  if (isInstalled("@jexs/physics")) {
    entryPoints.physicsWorker = path.join(clientDist, "physicsWorker.js");
  }

  const buildOptions: esbuild.BuildOptions = {
    entryPoints,
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: out,
    entryNames: "[name]",
    chunkNames: "chunks/[hash]",
    minify: true,
    target: "es2022",
    absWorkingDir: projectDir,
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

