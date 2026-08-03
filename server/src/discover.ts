// Manifest-driven package discovery — the single mechanism by which Jexs finds
// the node packages a project pulls in. It walks the project's declared
// dependency graph (not a raw node_modules scan), reads each package's `"jexs"`
// manifest, and feeds three consumers: the Node runtime (`jexs run`), the schema
// build (`jexs schema`), and the client bundler (`jexs bundle`). All fs/Node —
// browser code never runs this; the browser's node set is decided at bundle time.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Node } from "@jexs/core";
import { manifestOf, contributesNodes, type JexsEnv, type JexsManifest } from "./manifest.js";

export interface DiscoveredPackage {
  /** Package name (from its package.json). */
  name: string;
  /** Absolute path to the package root (dir containing its package.json). */
  dir: string;
  manifest: JexsManifest;
}

/** Read + parse a package.json, or null if missing/unparseable. */
function readPkg(pkgJsonPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a dependency's package.json from a base package.json by walking up
 * `node_modules`. A filesystem lookup (not `require.resolve`) — the Jexs packages
 * are ESM-only, so their `exports` expose no CJS/`package.json` subpath the CJS
 * resolver could use; and package.json always exists at the package root
 * regardless of `exports`. Handles hoisted, nested, and (via symlinks) pnpm
 * layouts. Checks the base dir first, then each parent.
 */
function resolvePkgJson(fromPkgJson: string, name: string): string | null {
  const parts = name.split("/"); // "@scope/pkg" -> ["@scope","pkg"]
  let cur = path.dirname(fromPkgJson);
  for (;;) {
    const candidate = path.join(cur, "node_modules", ...parts, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Walk `projectDir`'s dependency graph and return every package carrying a
 * `"jexs"` manifest. Deterministic: reads declared deps, resolves each via
 * `createRequire`, recurses only THROUGH jexs packages (so the whole non-jexs
 * tree isn't traversed), and dedupes by realpath. Reproducible across
 * npm/pnpm/yarn hoisting.
 *
 * @param includeDev seed from devDependencies too (schema wants them; runtime
 *   doesn't). Transitive recursion always follows prod deps only.
 */
export function walkJexsPackages(projectDir: string, { includeDev = false } = {}): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  const seen = new Set<string>();

  interface QueueItem { name: string; fromPkgJson: string }
  const queue: QueueItem[] = [];

  const seed = (pkg: Record<string, unknown>, fromPkgJson: string, withDev: boolean): void => {
    const fields = withDev
      ? ["dependencies", "optionalDependencies", "devDependencies"]
      : ["dependencies", "optionalDependencies"];
    for (const f of fields) {
      const deps = pkg[f];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as object)) queue.push({ name, fromPkgJson });
      }
    }
  };

  const rootPkgJson = path.join(projectDir, "package.json");
  const rootPkg = readPkg(rootPkgJson);
  if (!rootPkg) return out;
  seed(rootPkg, rootPkgJson, includeDev);

  while (queue.length > 0) {
    const { name, fromPkgJson } = queue.shift()!;
    const resolved = resolvePkgJson(fromPkgJson, name);
    if (!resolved) continue; // unresolvable (e.g. an uninstalled optional peer) — soft skip
    let real: string;
    try { real = realpathSync(resolved); } catch { real = resolved; }
    if (seen.has(real)) continue;
    seen.add(real);

    const pkg = readPkg(resolved);
    if (!pkg) continue;
    const manifest = manifestOf(pkg);
    if (manifest && manifest.discover !== false) {
      out.push({ name: typeof pkg.name === "string" ? pkg.name : name, dir: path.dirname(resolved), manifest });
      // Recurse only through jexs packages so transitive contributors are found
      // without traversing the entire non-jexs dependency tree.
      seed(pkg, resolved, false);
    }
  }
  return out;
}

/** Order @jexs/core first, then other @jexs/*, then third-party — so first-party
 *  keys win the resolver's first-registration-wins on any collision. */
function rank(name: string): number {
  if (name === "@jexs/core") return 0;
  if (name.startsWith("@jexs/")) return 1;
  return 2;
}

/**
 * Discover and instantiate every node package that applies to the given runtime
 * `env` (`"node"` or `"browser"`). Imports each package's `nodes` entry, taking
 * `mod.default ?? mod.nodes` (a `Node[]` or a `(opts) => Node[]` factory invoked
 * with `{ root }`). One broken/host-incompatible package warns and is skipped.
 */
export async function loadNodePackages(
  projectDir: string,
  { root, env }: { root: string; env: Exclude<JexsEnv, "both"> },
): Promise<Node[]> {
  const pkgs = walkJexsPackages(projectDir).sort((a, b) => rank(a.name) - rank(b.name));
  const out: Node[] = [];
  for (const pkg of pkgs) {
    if (!contributesNodes(pkg.manifest, env)) continue;
    try {
      const modPath = path.join(pkg.dir, pkg.manifest.nodes!);
      const mod = (await import(pathToFileURL(modPath).href)) as Record<string, unknown>;
      const contribution = mod.default ?? mod.nodes;
      if (!contribution) continue;
      const nodes =
        typeof contribution === "function"
          ? await (contribution as (o: { root: string }) => Node[] | Promise<Node[]>)({ root })
          : contribution;
      if (Array.isArray(nodes)) out.push(...(nodes as Node[]));
    } catch (err) {
      console.warn(`jexs: could not load nodes from "${pkg.name}": ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Collect the Node classes compiled under a package's `dist/nodes` directory by
 * reading each module's exports and keeping those with a `static schema`. Used by
 * schema derivation — reads classes only, constructs nothing. Missing dir → `[]`.
 */
export async function enumerateNodeClasses(distNodesDir: string): Promise<Array<typeof Node>> {
  if (!existsSync(distNodesDir)) return [];
  const classes: Array<typeof Node> = [];
  for (const file of readdirSync(distNodesDir)) {
    if (!file.endsWith(".js") || file === "Node.js") continue;
    const mod = (await import(pathToFileURL(path.join(distNodesDir, file)).href)) as Record<string, unknown>;
    for (const exp of Object.values(mod)) {
      if (typeof exp !== "function") continue;
      const schema = (exp as { schema?: unknown }).schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        classes.push(exp as typeof Node);
      }
    }
  }
  return classes;
}
