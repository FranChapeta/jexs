// The `"jexs"` package.json manifest — the single declaration by which any package
// (first-party or third-party) plugs into Jexs. A bare string is shorthand for
// `{ app }` (a JSON app entry runnable via `jexs run <pkg>`); the object form
// additionally declares runtime `nodes` and/or a prebuilt `schema`, plus which
// environment(s) those nodes target. This module is pure — no fs, no Node APIs —
// so the same normalization is shared by discovery, the schema build, and the CLI.

/** Which resolver(s) a package's `nodes` apply to. */
export type JexsEnv = "node" | "browser" | "both";

export interface JexsManifest {
  /** JSON app entry (relative to the package), runnable via `jexs run <pkg>`. */
  app?: string;
  /** JS module exporting the package's Node classes: a `Node[]` or a `(opts) => Node[]` factory. */
  nodes?: string;
  /**
   * Prebuilt PackageSchema (e.g. `dist/schema.json`). Optional — schema is derived
   * from `nodes` by default; a prebuilt file is only needed when the `nodes` module
   * cannot be imported under plain Node (e.g. it imports a host lib like `electron`),
   * or when the author prefers shipping static JSON over consume-time derivation.
   */
  schema?: string;
  /** Which resolver(s) the `nodes` apply to. Defaults to "both". */
  env: JexsEnv;
  /** Set `false` in a package's manifest to exclude it from node discovery. */
  discover?: boolean;
}

const ENVS: readonly JexsEnv[] = ["node", "browser", "both"];

/**
 * Normalize a parsed package.json's `jexs` field to a {@link JexsManifest}, or
 * `null` when the field is absent. String form `"jexs": "app.json"` becomes
 * `{ app: "app.json", env: "both" }`, and `env` defaults to `"both"`. A field
 * that is there but malformed throws, naming the package: read any other way,
 * its nodes would load where they don't belong, or not at all, without a word.
 */
export function manifestOf(pkgJson: unknown): JexsManifest | null {
  if (!pkgJson || typeof pkgJson !== "object") return null;
  const { jexs: raw, name } = pkgJson as { jexs?: unknown; name?: unknown };
  if (raw === undefined || raw === null) return null;
  const fail = (problem: string): never => {
    throw new Error(`${typeof name === "string" ? name : "A package"}: the "jexs" field in package.json ${problem}`);
  };

  if (typeof raw === "string") return { app: raw, env: "both" };
  if (typeof raw !== "object" || Array.isArray(raw)) fail("must be an app entry's path or an object");

  const m = raw as Record<string, unknown>;
  const out: JexsManifest = { env: "both" };
  for (const key of ["app", "nodes", "schema"] as const) {
    const value = m[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return fail(`has a \`${key}\` that is not a path`);
    out[key] = value;
  }
  if (m.env !== undefined) {
    if (!ENVS.includes(m.env as JexsEnv)) fail(`has \`env\` ${JSON.stringify(m.env)}; it takes ${ENVS.map(e => `"${e}"`).join(", ")}`);
    out.env = m.env as JexsEnv;
  }
  if (m.discover !== undefined) {
    if (typeof m.discover !== "boolean") fail("has a `discover` that is not true or false");
    if (m.discover === false) out.discover = false;
  }
  return out;
}

/** True when this package should be loaded by node discovery for the given target env. */
export function contributesNodes(m: JexsManifest, target: Exclude<JexsEnv, "both">): boolean {
  return m.discover !== false && !!m.nodes && (m.env === "both" || m.env === target);
}
