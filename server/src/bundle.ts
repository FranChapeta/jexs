// The client bundler — the build-time consumer of discovery. `jexs bundle` walks
// the project's browser node packages and produces a project-local dist/browser
// containing @jexs/client's runtime PLUS any third-party browser nodes, all
// sharing one @jexs/core (a single bundle, so they register into the one page
// resolver @jexs/client builds rather than each getting their own). It is the
// bundle a listener with `client` serves; no prebuilt one ships.

import { rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import path from "node:path";
import * as esbuild from "esbuild";
import { walkJexsPackages } from "./discover.js";
import { contributesNodes } from "./manifest.js";

/** A worker script @jexs/client exports (`sw`, `resolver-worker`, `physics-worker`), as a path for esbuild. */
function clientFile(subpath: string): string {
  return fileURLToPath(import.meta.resolve(`@jexs/client/${subpath}`));
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

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The outputs worth compressing: text. A binary the bundle emits is left as is. */
const COMPRESSIBLE = /\.(js|css|map|svg)$/;

/**
 * Write `<file>.br` and `<file>.gz` beside each compressible file, at the
 * highest levels: they are made once per build, not per request, so the time
 * is spent where it costs nothing. A copy no smaller than its file is not kept,
 * and one a previous build left beside it is removed, so a copy on disk is
 * always the current bytes and always worth sending.
 */
async function precompress(files: string[]): Promise<void> {
  await Promise.all(files.filter((file) => COMPRESSIBLE.test(file)).map(async (file) => {
    const content = await readFile(file);
    const [br, gz] = await Promise.all([
      brotliAsync(content, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
        },
      }),
      gzipAsync(content, { level: constants.Z_BEST_COMPRESSION }),
    ]);
    const keep = (copy: string, bytes: Buffer) =>
      bytes.length < content.length ? writeFile(copy, bytes) : rm(copy, { force: true });
    await Promise.all([keep(`${file}.br`, br), keep(`${file}.gz`, gz)]);
  }));
}

/**
 * Bundle the project's browser runtime into `dist/browser`. Generates an entry
 * that boots @jexs/client (which wires core/client/physics/gl) with the nodes of
 * every discovered `browser`/`both` third-party node package — @jexs/* packages
 * are skipped since @jexs/client already wires them. The workers and the service
 * worker are entries beside the page's, so their cross-references resolve in
 * the output dir.
 *
 * Emits only compiled output (no HTML): pages are JSON templates in `src/`,
 * resolved to HTML at runtime. The @jexs/server SSR path renders them directly,
 * and the electron runner resolves a shell template that `{ file }`-imports the
 * page over `app://` — neither needs a build-time page file.
 *
 * With `compress`, every build (each rebuild too, when watching) also writes a
 * brotli and a gzip copy beside each script, for a server to send in its place.
 */
export async function bundleClient(
  projectDir: string,
  { outDir, watch = false, compress = false }: { outDir?: string; watch?: boolean; compress?: boolean } = {},
): Promise<esbuild.BuildContext | void> {
  const out = outDir ?? path.join(projectDir, "dist", "browser");

  const pkgs = walkJexsPackages(projectDir).filter(
    (p) => contributesNodes(p.manifest, "browser") && !p.name.startsWith("@jexs/"),
  );

  // Each package's nodes module, as discovery loads it: its default export is a
  // factory or an array of nodes. They go to boot(), which registers them before
  // hydrating, so a `mount` handler can use them.
  const imports = [`import { boot } from "@jexs/client";`];
  const lists: string[] = [];
  pkgs.forEach((p, i) => {
    const modPath = path.join(p.dir, p.manifest.nodes!).split(path.sep).join("/");
    imports.push(`import n${i} from ${JSON.stringify(modPath)};`);
    lists.push(`...list(n${i})`);
  });
  const entrySrc =
    `${imports.join("\n")}\n` +
    `const list = (c) => typeof c === "function" ? c({}) : c;\n` +
    `boot({ nodes: [${lists.join(", ")}] });\n`;

  // The page's entry exists only in memory: a plugin answers for its name with
  // the source above, resolving its imports from the project.
  const pageEntry: esbuild.Plugin = {
    name: "jexs-page-entry",
    setup(build) {
      build.onResolve({ filter: /^jexs:page$/ }, () => ({ path: "page", namespace: "jexs" }));
      build.onLoad({ filter: /.*/, namespace: "jexs" }, () => ({ contents: entrySrc, resolveDir: projectDir, loader: "js" }));
    },
  };

  // After each build, from the files the build says it wrote, so a rebuild
  // compresses what it emitted and nothing older.
  const precompressOutputs: esbuild.Plugin = {
    name: "jexs-precompress",
    setup(build) {
      build.onEnd(async (result) => {
        if (!result.metafile) return;
        await precompress(Object.keys(result.metafile.outputs).map((file) => path.resolve(projectDir, file)));
      });
    },
  };

  const entryPoints: Record<string, string> = {
    client: "jexs:page",
    "sw-runtime": clientFile("sw"),
    resolverWorker: clientFile("resolver-worker"),
  };
  // The physics worker STATICALLY imports @jexs/physics, so unlike the lazy
  // registrations it cannot be rescued by a `.catch()` — listing it as an entry
  // in an app without physics fails the entire bundle. Nothing references the
  // emitted file unless a physics op runs, which needs the package anyway.
  if (isInstalled("@jexs/physics")) {
    entryPoints.physicsWorker = clientFile("physics-worker");
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
    metafile: compress,
    plugins: compress ? [pageEntry, precompressOutputs] : [pageEntry],
  };

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.error(`jexs bundle: watching → ${out}`);
    return ctx;
  }

  rmSync(out, { recursive: true, force: true });
  await esbuild.build(buildOptions);
  console.error(`jexs bundle: ${pkgs.length} third-party browser package(s) → ${out}${compress ? " (with .br and .gz copies)" : ""}`);
}

