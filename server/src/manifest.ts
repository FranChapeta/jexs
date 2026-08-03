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

/**
 * Normalize a parsed package.json's `jexs` field to a {@link JexsManifest}, or
 * `null` when the field is absent. String form `"jexs": "app.json"` becomes
 * `{ app: "app.json", env: "both" }`. `env` defaults to `"both"`; an invalid
 * `env` is treated as `"both"`. Non-string/non-object shapes yield `null`.
 */
export function manifestOf(pkgJson: unknown): JexsManifest | null {
  if (!pkgJson || typeof pkgJson !== "object") return null;
  const raw = (pkgJson as { jexs?: unknown }).jexs;
  if (raw === undefined || raw === null) return null;

  if (typeof raw === "string") return { app: raw, env: "both" };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const m = raw as Record<string, unknown>;
  const out: JexsManifest = { env: "both" };
  if (typeof m.app === "string") out.app = m.app;
  if (typeof m.nodes === "string") out.nodes = m.nodes;
  if (typeof m.schema === "string") out.schema = m.schema;
  if (m.env === "node" || m.env === "browser" || m.env === "both") out.env = m.env;
  if (m.discover === false) out.discover = false;
  return out;
}

/** True when this package should be loaded by node discovery for the given target env. */
export function contributesNodes(m: JexsManifest, target: Exclude<JexsEnv, "both">): boolean {
  return m.discover !== false && !!m.nodes && (m.env === "both" || m.env === target);
}
