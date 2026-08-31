import fs from "node:fs";
import path from "node:path";
import type { ConnectionOptions, SecureVersion } from "node:tls";
import { Node } from "@jexs/core";

/**
 * Connection strings and TLS material, shared by DatabaseNode and the cache
 * adapters so both accept the same shapes: a `url` carrying the whole endpoint,
 * and an `ssl`/`tls` value that is a boolean or an object of Node TLS options.
 */

export type TlsConfig = ConnectionOptions;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strip the password out of a url so it can go in an error message or a log. */
export function redactUrl(raw: string): string {
  return String(raw).replace(/(:\/\/[^/@]*:)[^/@]*@/, "$1***@");
}

// ── TLS material ───────────────────────────────────────────────────────────────

// The boolean spellings the `ssl`/`tls` FIELD accepts as text, for a value that
// reaches it from `$env` as a string. Kept to the few that are actually written
// — the schema lists exactly these as an enum, so what the editor offers and
// what the runtime takes are the same set (the runtime also folds case).
export const TLS_STRINGS = ["true", "false", "1", "0", "require", "disable"] as const;
const TLS_ON = new Set(["true", "1", "require"]);
const TLS_OFF = new Set(["false", "0", "disable"]);
const SECURE_VERSIONS = new Set(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]);

/**
 * Certificate material for the `ssl` / `tls` FIELD: PEM text, never a path.
 * Templates load the PEM the one way Jexs loads anything:
 *   [ { "file": "/certs/ca.pem", "raw": true, "as": "ca" },
 *     { "database": "connect", "url": "...", "ssl": { "ca": { "var": "$ca" } } } ]
 */
function pemContent(value: unknown, field: string): string {
  const s = String(value).trim();
  if (s.includes("-----BEGIN")) return s;
  throw new Error(
    `TLS ${field} must be PEM content, not a path — load it first, e.g. ` +
    `{ "file": "/path/to/${field}.pem", "raw": true, "as": "${field}" } then { "${field}": { "var": "$${field}" } }`,
  );
}

function pemList(value: unknown, field: string): string | string[] {
  return Array.isArray(value) ? value.map(v => pemContent(v, field)) : pemContent(value, field);
}

/**
 * Certificate material named by a URL query parameter, which the standards
 * define as a FILE PATH — libpq reads `sslrootcert` off disk, and so does
 * `pg-connection-string`. A connection string is a foreign format we implement
 * faithfully, so paths stay paths here; they resolve against the cwd, as libpq's
 * do. The `ssl` field above is ours, and takes values instead.
 */
function pemFile(value: string, field: string): string {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), value), "utf8");
  } catch (error) {
    throw new Error(`Cannot read TLS ${field} from "${value}": ${(error as Error).message}`);
  }
}

function secureVersion(value: unknown): SecureVersion {
  const s = String(value).trim();
  const normalized = /^\d/.test(s) ? `TLSv${s}` : s.replace(/^tlsv?/i, "TLSv");
  if (!SECURE_VERSIONS.has(normalized)) {
    throw new Error(`Unknown TLS version "${s}" (expected TLSv1, TLSv1.1, TLSv1.2 or TLSv1.3)`);
  }
  return normalized as SecureVersion;
}

/**
 * Normalize an `ssl` / `tls` value into what the drivers accept.
 *
 * - `true` — TLS verifying against the system trust store. Identical to `{}`;
 *   kept because it is how pg and knex spell it (`boolean | ConnectionOptions`)
 *   and it is right whenever the server's certificate chains to a public root.
 * - `false` — plaintext. NOT expressible as an object (any object turns TLS on),
 *   so it is the only way to override a `sslmode` the url already set.
 * - a boolean-ish string (`"require"`, `"disable"`, `"1"`, `"off"`, ...) — the
 *   same two answers, for a value arriving from `$env` as text.
 * - an object — `ca`/`cert`/`key` as PEM content, the rest passed through.
 *
 * A bare PEM string is deliberately NOT accepted. It would make `{ "ssl": {
 * "var": "$x" } }` mean two different things depending on the runtime type of
 * `$x` — options if it held an object, a CA if it held a string — so material
 * always goes under a named key.
 *
 * `undefined` means "not specified", which is distinct from `false`: it leaves
 * the driver's own default in place rather than forcing plaintext.
 */
export function parseTls(value: unknown): boolean | TlsConfig | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  if (typeof value === "string") {
    const s = value.trim();
    const lower = s.toLowerCase();
    if (TLS_ON.has(lower)) return true;
    if (TLS_OFF.has(lower)) return false;
    const hint = s.includes("-----BEGIN")
      ? "certificate material goes under a key, e.g. { \"ca\": ... }"
      : "load a certificate with { \"file\": \"/certs/ca.pem\", \"raw\": true, \"as\": \"ca\" } and pass { \"ca\": { \"var\": \"$ca\" } }";
    throw new Error(
      `"${s.slice(0, 40)}" is not a TLS setting — use an object, or one of ${TLS_STRINGS.join(", ")}; ${hint}`,
    );
  }

  if (!isObject(value)) return undefined;

  const out: TlsConfig = {};
  if (value.ca != null) out.ca = pemList(value.ca, "ca");
  if (value.cert != null) out.cert = pemContent(value.cert, "cert");
  if (value.key != null) out.key = pemContent(value.key, "key");
  if (value.passphrase != null) out.passphrase = String(value.passphrase);
  if (value.servername != null) out.servername = String(value.servername);
  // The resolver's own truthiness rules, so `rejectUnauthorized` reads the same
  // way as every other boolean a template can write.
  if (value.rejectUnauthorized != null) out.rejectUnauthorized = Node.toBooleanValue(value.rejectUnauthorized);
  if (value.minVersion != null) out.minVersion = secureVersion(value.minVersion);
  if (value.ciphers != null) out.ciphers = String(value.ciphers);
  // An empty object still means "use TLS, all defaults" — same as `true`.
  return out;
}

/** Layer an explicit `ssl`/`tls` sibling over whatever the url implied. */
export function mergeTls(
  base: boolean | TlsConfig | undefined,
  override: boolean | TlsConfig | undefined,
): boolean | TlsConfig | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  if (typeof base === "object" && typeof override === "object") return { ...base, ...override };
  return override;
}

// ── Database urls ──────────────────────────────────────────────────────────────

/** Drivers dialed over the network, so these are the ones a `host` can name.
 *  SQLite is a file and never has one, which is why it is not in this list. */
export const HOSTED_DATABASE_TYPES = ["mysql", "pg"] as const;
/** Every driver. Shared by the schema `enum`s and the runtime guard below, so
 *  the two cannot drift. */
export const DATABASE_TYPES = ["sqlite", ...HOSTED_DATABASE_TYPES] as const;
export type DatabaseType = (typeof DATABASE_TYPES)[number];

export function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === "string" && DATABASE_TYPES.some(t => t === value);
}

const DB_SCHEMES: Record<string, DatabaseType> = {
  sqlite: "sqlite",
  sqlite3: "sqlite",
  file: "sqlite",
  mysql: "mysql",
  mysql2: "mysql",
  mariadb: "mysql",
  postgres: "pg",
  postgresql: "pg",
  pg: "pg",
};

/**
 * Everything needed to open a connection. Lives here rather than in the node
 * because it is also exactly what a url parses INTO — the two spellings of an
 * endpoint produce the same shape, so `parseDbUrl` hands back a finished config
 * instead of parts the caller has to transcribe field by field.
 */
export interface DatabaseConfig {
  type: DatabaseType;
  /** SQLite file path. */
  filename?: string;
  /** MySQL / PostgreSQL endpoint. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** TLS: `true` for the default trust store, `false` for plaintext, or options. */
  ssl?: boolean | TlsConfig;
}

/**
 * TLS modes, keyed by the libpq spelling after normalization (lower-cased, `_`
 * folded to `-`) so MySQL's `VERIFY_CA` and libpq's `verify-ca` both land here.
 *
 * The MAPPING follows node-postgres rather than the libpq spec: libpq treats
 * `require` as "encrypt, don't verify", but the driver verifies on every mode
 * except `disable` and adds `no-verify` as the explicit opt-out, so a
 * certificate that can't be verified fails loudly instead of silently
 * downgrading. MySQL's `PREFERRED` is likewise treated as verifying.
 */
const SSL_MODES: Record<string, false | { rejectUnauthorized: boolean }> = {
  // libpq (PostgreSQL docs §34.1.2)
  disable: false,
  allow: { rejectUnauthorized: true },
  prefer: { rejectUnauthorized: true },
  require: { rejectUnauthorized: true },
  "verify-ca": { rejectUnauthorized: true },
  "verify-full": { rejectUnauthorized: true },
  // node-postgres extension
  "no-verify": { rejectUnauthorized: false },
  // MySQL URI syntax (MySQL Reference Manual §6.2.5)
  disabled: false,
  preferred: { rejectUnauthorized: true },
  required: { rejectUnauthorized: true },
  "verify-identity": { rejectUnauthorized: true },
};

/** First present value among several spellings of the same parameter. */
function sslParam(q: URLSearchParams, ...names: string[]): string | null {
  for (const name of names) {
    const value = q.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * TLS query parameters, accepted in both standard spellings and applied to both
 * drivers: libpq's unhyphenated `sslmode` / `sslrootcert` / `sslcert` / `sslkey`
 * / `sslpassword`, and MySQL's hyphenated `ssl-mode` / `ssl-ca` / `ssl-cert` /
 * `ssl-key` / `ssl-cipher`. Neither driver's own url handling covers both, and
 * knex ignores `sslmode` on the MySQL path entirely.
 */
function sslFromQuery(q: URLSearchParams): boolean | TlsConfig | undefined {
  const material: TlsConfig = {};
  const ca = sslParam(q, "sslrootcert", "sslca", "ssl-ca");
  if (ca) material.ca = pemFile(ca, "ca");
  const cert = sslParam(q, "sslcert", "ssl-cert");
  if (cert) material.cert = pemFile(cert, "cert");
  const key = sslParam(q, "sslkey", "ssl-key");
  if (key) material.key = pemFile(key, "key");
  const passphrase = sslParam(q, "sslpassword", "ssl-password");
  if (passphrase) material.passphrase = passphrase;
  const ciphers = sslParam(q, "ssl-cipher", "sslcipher");
  if (ciphers) material.ciphers = ciphers;
  const hasMaterial = Object.keys(material).length > 0;

  const rawMode = sslParam(q, "sslmode", "ssl-mode");
  if (rawMode) {
    // libpq lower-cases and hyphenates (`verify-ca`); MySQL upper-cases and
    // underscores (`VERIFY_CA`). Normalize to the libpq spelling.
    const mode = rawMode.trim().toLowerCase().replace(/_/g, "-");
    const mapped = SSL_MODES[mode];
    if (mapped === undefined) {
      throw new Error(
        `Unknown sslmode "${rawMode}" (expected disable, allow, prefer, require, verify-ca, verify-full, no-verify, or the MySQL spellings DISABLED, PREFERRED, REQUIRED, VERIFY_CA, VERIFY_IDENTITY)`,
      );
    }
    if (mapped === false) return false;
    return { ...material, ...mapped };
  }

  const ssl = q.get("ssl");
  if (ssl !== null) {
    // mysql2's url idiom puts a JSON object in `ssl=`; libpq-style urls use
    // `ssl=true` / `ssl=0`. Only a url carries the JSON-in-a-string form — the
    // `ssl` FIELD takes a real object, so `parseTls` does not accept it.
    const raw = ssl.trim();
    let parsed: boolean | TlsConfig | undefined;
    if (raw.startsWith("{")) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new Error(`ssl url parameter is not valid JSON: ${raw}`);
      }
      parsed = parseTls(decoded);
    } else {
      parsed = parseTls(raw);
    }
    if (parsed === false) return false;
    if (parsed === true) return hasMaterial ? material : true;
    if (parsed !== undefined) return { ...material, ...parsed };
  }

  return hasMaterial ? material : undefined;
}

/**
 * Parse a database connection string into discrete connection settings.
 *
 * `postgres://user:pass@host:5432/app?sslmode=verify-full`
 * `mysql://user:pass@host:3306/app?ssl=true`
 * `sqlite:./data.db`, `sqlite:///var/lib/app.db`, `sqlite::memory:`
 *
 * The scheme selects the driver, so `type` becomes optional when a url is given.
 */
export function parseDbUrl(raw: string): DatabaseConfig {
  const s = String(raw).trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1].toLowerCase();
  if (!scheme) {
    throw new Error(`Database url has no scheme: "${redactUrl(s)}"`);
  }
  const type = DB_SCHEMES[scheme];
  if (!type) {
    throw new Error(
      `Unsupported database url scheme "${scheme}" (expected sqlite/sqlite3/file, mysql/mysql2/mariadb, or postgres/postgresql/pg)`,
    );
  }

  if (type === "sqlite") {
    // Not really a url: everything after the scheme (minus an optional `//`) is
    // the path verbatim, so `sqlite:./data.db`, `sqlite:///var/lib/app.db` and
    // `sqlite::memory:` all land on the right filename.
    let filename = s.slice(scheme.length + 1);
    if (filename.startsWith("//")) filename = filename.slice(2);
    return filename ? { type, filename } : { type };
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Malformed database url: "${redactUrl(s)}"`);
  }

  const parts: DatabaseConfig = { type };
  // `hostname` keeps the brackets on an IPv6 literal; the drivers want it bare.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host) parts.host = host;
  if (url.port) parts.port = Number(url.port);
  if (url.username) parts.user = decodeURIComponent(url.username);
  if (url.password) parts.password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database) parts.database = database;

  const ssl = sslFromQuery(url.searchParams);
  if (ssl !== undefined) parts.ssl = ssl;
  return parts;
}