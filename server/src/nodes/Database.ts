import Knex, { Knex as KnexType } from "knex";
import fs from "node:fs";
import path from "node:path";
import { Node, Context, NodeValue, resolve, resolveAll, resolveObj } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import {
  mergeTls, parseDbUrl, parseTls, TLS_STRINGS,
  DATABASE_TYPES, HOSTED_DATABASE_TYPES, isDatabaseType,
  type DatabaseConfig, type DatabaseType,
} from "../connection.js";

export type { DatabaseConfig };

/**
 * What an open connection remembers about itself — deliberately NOT the
 * `DatabaseConfig`.
 *
 * That config holds the password and the TLS private key, and nothing ever reads
 * them back: the driver takes them at dial time and keeps its own copy. Holding
 * a second one for the life of the process only widens what a stray log line, a
 * serialized error, or the public `getInstance` can expose. These three fields
 * are everything the rest of the node actually asks for, and all three are safe
 * to print.
 */
interface ConnectionInfo {
  type: DatabaseType;
  /** Where it points, with credentials stripped. For SQLite, the file path. */
  location: string;
  ssl: boolean;
}

// Internal connection wrapper
interface DatabaseConnection {
  knex: KnexType;
  info: ConnectionInfo;
}

/** Reduce a config to the parts that get read back, dropping the secrets. */
function describe(config: DatabaseConfig): ConnectionInfo {
  return {
    type: config.type,
    location:
      config.type === "sqlite"
        ? config.filename || "data.db"
        : `${config.host}:${config.port}/${config.database}`,
    ssl: Boolean(config.ssl),
  };
}

// Module-level state
const connections: Map<string, DatabaseConnection> = new Map();
let defaultConnectionName: string | null = null;

/**
 * DatabaseNode - Handles database connections and queries in JSON.
 *
 * Connect:
 * { "database": "connect", "name": "main", "type": "sqlite", "filename": "data.db" }
 *
 * Close:
 * { "database": "close", "name": "main" }
 *
 * Raw query:
 * { "database": "raw", "sql": "SELECT * FROM users WHERE id = ?", "bindings": [1] }
 *
 * Table operations:
 * { "database": "tableExists", "table": "users" }
 * { "database": "dropTable", "table": "users" }
 */
export class DatabaseNode extends Node {
  static schema: JexsNodeSchema = {
    database: {
      type: "string",
      enum: [
        "connect",
        "close",
        "raw",
        "tableExists",
        "dropTable",
        "info",
      ],
      markdownDescription: "Manages database connections. Supports SQLite (`better-sqlite3`), MySQL (`mysql2`), and PostgreSQL (`pg`) via Knex. The operation is the primary value; each carries its own properties.",
      examples: [
        "{ \"database\": \"connect\", \"name\": \"main\", \"type\": \"sqlite\", \"filename\": \"app/data.db\" }",
      ],
      variants: {
        connect: {
          output: "object",
          markdownDescription: "Opens (and registers) a connection, from a `url` connection string or from discrete `host`/`port`/`user` properties. Returns a status object.",
          examples: [
            "{ \"database\": \"connect\", \"name\": \"main\", \"url\": { \"var\": \"$env.DATABASE_URL\" } }",
            "{ \"database\": \"connect\", \"type\": \"pg\", \"host\": \"db.example.com\", \"db\": \"app\", \"ssl\": { \"ca\": \"certs/root.pem\" } }",
          ],
          // Only the properties common to every way of connecting. Each of the
          // three ways to name an endpoint is a variant below, so the properties
          // that belong to one of them are scoped to it rather than sitting
          // flat here alongside the others.
          siblings: {
            name: { type: "string", description: "Connection name (default `\"default\"`)." },
            ssl: {
              type: ["boolean", "string", "object"],
              enum: TLS_STRINGS,
              markdownDescription: "TLS for the connection (MySQL / PostgreSQL), also spelled `tls`. `true` encrypts AND verifies against the system trust store — the strictest setting, which fails on the private CAs most managed databases use. `false` forces plaintext, and is the only way to say that: every object turns TLS on. An object takes `ca`, `cert`, `key`, `passphrase`, `servername`, `rejectUnauthorized`, `minVersion` and `ciphers`. The string forms (`\"true\"`, `\"1\"`, `\"require\"`, `\"false\"`, `\"0\"`, `\"disable\"`) are for a value arriving from `$env` as text.\n\nCertificates are PEM **content**, not paths: load the file first with `{ \"file\": \"/certs/ca.pem\", \"raw\": true, \"as\": \"ca\" }` and pass `{ \"var\": \"$ca\" }`, so one node owns file reading and one set of path rules applies. (A url's `sslrootcert=` stays a path — that is what the standard defines it as.)\n\nSays HOW to connect rather than where, so it applies to `url` and `host` alike, merging key-wise over whatever the url's `sslmode` implied.",
              examples: [
                "{ \"ca\": { \"var\": \"$ca\" } }",
                "{ \"rejectUnauthorized\": false }",
              ],
            },
          },
          // The three ways to name an endpoint. Each owns the properties that
          // only make sense with it, so `port`/`user`/`password`/`db` hang off
          // `host` rather than floating next to `url` and `filename`.
          variants: {
            url: {
              type: "string",
              markdownDescription: "Connection string, e.g. `postgres://user:pass@host:5432/app?sslmode=verify-full`, `mysql://user:pass@host/app?ssl-mode=VERIFY_CA`, or `sqlite:./data.db`. The scheme selects the driver. TLS query parameters are accepted in both standard spellings — libpq's `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword` and MySQL's `ssl-mode`, `ssl-ca`, `ssl-cert`, `ssl-key`, `ssl-cipher` — and apply to either driver. Following node-postgres rather than the libpq spec, every mode except `disable`/`DISABLED` verifies the server certificate; use `no-verify` to encrypt without verifying. Carries the whole endpoint, so it replaces `host` and `filename`.",
            },
            host: {
              type: "string",
              markdownDescription: "Server hostname, spelling the endpoint out instead of passing a `url` (MySQL / PostgreSQL).",
              siblings: {
                // `type` lives here rather than alongside the other two ways of
                // naming an endpoint, which each carry the driver themselves: a
                // url's scheme names it, and `filename` is a SQLite path. Only a
                // host leaves it open, so only a host has to say.
                type: {
                  type: "string",
                  enum: HOSTED_DATABASE_TYPES,
                  required: true,
                  description: "Database driver.",
                },
                port: { type: "number", description: "Server port (default 3306 for MySQL, 5432 for PostgreSQL)." },
                user: { type: "string", description: "Username." },
                password: { type: "string", description: "Password." },
                db: { type: "string", description: "Database name." },
              },
            },
            filename: {
              type: "string",
              markdownDescription: "SQLite file path, spelling the endpoint out instead of passing a `url`. It names the driver on its own, so no `type` is needed alongside it.",
            },
          },
        },
        close: {
          output: "object",
          outputDescription: "A status object, or `null` if closing failed.",
          markdownDescription: "Closes a named connection.",
          siblings: {
            name: { type: "string", description: "Connection name to close." },
          },
        },
        raw: {
          markdownDescription: "Runs a raw SQL string with positional bindings.",
          outputDescription: "The driver result: a rows array on SQLite, the first result set otherwise.",
          siblings: {
            sql: { type: "string", description: "Raw SQL string." },
            bindings: { type: "array", description: "Positional bindings for the SQL." },
            connection: { type: "string", description: "Named connection (default if omitted)." },
          },
        },
        tableExists: {
          output: "boolean",
          markdownDescription: "Returns whether a table exists.",
          siblings: {
            table: { type: "string", description: "Table name." },
            connection: { type: "string", description: "Named connection (default if omitted)." },
          },
        },
        dropTable: {
          output: "object",
          markdownDescription: "Drops a table if it exists. Returns a status object.",
          siblings: {
            table: { type: "string", description: "Table name." },
            connection: { type: "string", description: "Named connection (default if omitted)." },
          },
        },
        info: {
          output: "object",
          outputDescription: "A connection-info object, or `null` if unknown. Carries no credentials.",
          markdownDescription: "Reports connection info (type, location, whether TLS is on, size, table count).",
          siblings: {
            name: { type: "string", description: "Connection name." },
          },
        },
      },
    },
  };

  database(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.database, context, operation => {
      switch (String(operation)) {
        case "connect":
          return doConnect(def, context);
        case "close":
          return doClose(def, context);
        case "raw":
          return doRaw(def, context);
        case "tableExists":
          return doTableExists(def, context);
        case "dropTable":
          return doDropTable(def, context);
        case "info":
          return doInfo(def, context);
        default:
          console.error(`[DatabaseNode] Unknown operation: ${operation}`);
          return null;
      }
    });
  }

  // ============================================
  // Static Connection Management
  // ============================================

  static getInstance(
    name: string = "default",
    config?: DatabaseConfig,
  ): DatabaseConnection {
    if (!connections.has(name)) {
      if (!config) {
        config = {
          type: "sqlite",
          filename: path.join(
            process.cwd(),
            name === "default" ? "data.db" : `${name}.db`,
          ),
        };
      }
      DatabaseNode.init(name, config);
    }
    return connections.get(name)!;
  }

  static init(name: string, config: DatabaseConfig): void {
    if (connections.has(name)) {
      connections.get(name)!.knex.destroy();
    }
    const knex = createConnection(config);
    // `config` goes no further than this call: knex has what it needs to dial.
    connections.set(name, { knex, info: describe(config) });
  }

  /** Omit `name` to get whichever connection opened first. */
  static getKnex(name?: string): KnexType {
    return requireConnection(name).knex;
  }

  /** Type, target and TLS state. Carries no credentials — none are kept. */
  static getInfo(name?: string): ConnectionInfo | null {
    const conn = connections.get(connectionName(name));
    return conn ? { ...conn.info } : null;
  }

  static async closeConnection(name: string): Promise<void> {
    const conn = connections.get(name);
    if (conn) {
      await conn.knex.destroy();
      connections.delete(name);
    }
  }

  static async closeAll(): Promise<void> {
    for (const conn of connections.values()) {
      await conn.knex.destroy();
    }
    connections.clear();
    defaultConnectionName = null;
  }

  static getDefaultConnection(): string | null {
    return defaultConnectionName;
  }

  static async transaction<T>(
    name: string,
    callback: (trx: KnexType.Transaction) => Promise<T>,
  ): Promise<T> {
    return requireConnection(name).knex.transaction(callback);
  }
}

// npm package per driver, for the "not installed" messages below.
const DRIVER_PACKAGE: Record<DatabaseType, string> = {
  sqlite: "better-sqlite3",
  mysql: "mysql2",
  pg: "pg",
};

/** Raised when the driver a config asked for is not installed. */
class MissingDriverError extends Error {
  constructor(readonly driver: DatabaseType, readonly pkg: string, cause?: unknown) {
    super(
      `The "${driver}" driver needs the ${pkg} package, which is not installed. Run: npm install ${pkg}`,
      { cause },
    );
    this.name = "MissingDriverError";
  }
}

/** A value a driver can bind to a `?` placeholder. */
function isBinding(value: unknown): value is KnexType.RawBinding {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
    || value instanceof Date
    || Buffer.isBuffer(value);
}

/**
 * Positional bindings for a raw statement, checked rather than asserted.
 *
 * Omitting them has to produce `undefined`, NOT `null`: knex reads a non-array
 * as a single binding, so `null` makes it expect a placeholder that isn't there
 * and fail with "Expected 1 bindings, saw 0" on a statement that has none.
 *
 * Element types are checked here because the driver reports them against the
 * compiled SQL ("SQLite3 can only bind numbers, strings...") rather than against
 * the step, which leaves the author hunting for which value was wrong.
 */
function toBindings(value: unknown): KnexType.RawBinding[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`"bindings" must be an array of values, got ${typeof value}`);
  }
  const bindings: KnexType.RawBinding[] = [];
  value.forEach((item, i) => {
    if (!isBinding(item)) {
      throw new Error(
        `"bindings" item ${i} is ${item === undefined ? "undefined" : typeof item} — ` +
        `bindings must be strings, numbers, booleans, bigints, null, Dates or Buffers`,
      );
    }
    bindings.push(item);
  });
  return bindings;
}

/**
 * Which connection a step meant: the name it gave, else whichever connected
 * first, else `"default"`. Every op taking an optional `connection` / `name`
 * resolves it here rather than repeating the fallback chain.
 */
function connectionName(nameRaw?: unknown): string {
  return String(nameRaw ?? defaultConnectionName ?? "default");
}

/**
 * The connection a step meant, or an error saying how to open one. Every op that
 * touches a connection lands here, so it is the message a template author
 * actually reads — and since the drivers are optional peers, "not connected"
 * on its own leaves out the half that is usually the real problem.
 */
function requireConnection(nameRaw?: unknown): DatabaseConnection {
  const name = connectionName(nameRaw);
  const conn = connections.get(name);
  if (conn) return conn;
  throw new Error(
    `Database "${name}" is not connected. Open it with ` +
    `{ "database": "connect", "url": "postgres://user:pass@host/app" } ` +
    `and install its driver:\n${driverOptions()}`,
  );
}

/** Every driver and the package that provides it, one per line. */
function driverOptions(): string {
  const width = Math.max(...Object.values(DRIVER_PACKAGE).map(p => p.length));
  return (Object.keys(DRIVER_PACKAGE) as DatabaseType[])
    .map(t => `  npm install ${DRIVER_PACKAGE[t].padEnd(width)}  for { "type": "${t}" }`)
    .join("\n");
}

/**
 * Open a knex instance, turning a missing driver into an instruction.
 *
 * The three drivers are OPTIONAL peers — knex declares them that way too, and
 * shipping all of them would make every install compile better-sqlite3 (64 MB,
 * native) to run a Postgres app. knex requires the driver lazily, so the failure
 * only ever reaches someone who asked for that database; its own message talks
 * about knex, which means nothing to someone writing JSON.
 */
function createConnection(config: DatabaseConfig): KnexType {
  try {
    return knexFor(config);
  } catch (error) {
    const pkg = DRIVER_PACKAGE[config.type];
    const message = (error as Error).message ?? "";
    if (pkg && (message.includes("Cannot find module") || message.includes(`npm install ${pkg}`))) {
      throw new MissingDriverError(config.type, pkg, error);
    }
    throw error;
  }
}

function knexFor(config: DatabaseConfig): KnexType {
  switch (config.type) {
    case "sqlite":
      return Knex({
        client: "better-sqlite3",
        connection: {
          filename: config.filename || path.join(process.cwd(), "data.db"),
        },
        useNullAsDefault: true,
      });

    case "mysql":
      return Knex({
        client: "mysql2",
        connection: {
          host: config.host || "localhost",
          port: config.port || 3306,
          user: config.user || "root",
          password: config.password || "",
          database: config.database || "cms",
          // mysql2 feeds `ssl` straight to tls.createSecureContext, so the bare
          // `true` shorthand has to become an options object; a falsy value is
          // dropped entirely rather than sent as `false`. Knex types the field
          // against the narrower mysql (not mysql2) shape, which omits
          // servername/passphrase/minVersion — all valid for mysql2 at runtime.
          ...(config.ssl
            ? { ssl: (config.ssl === true ? {} : config.ssl) as KnexType.MariaSslConfiguration }
            : {}),
        },
      });

    case "pg":
      return Knex({
        client: "pg",
        connection: {
          host: config.host || "localhost",
          port: config.port || 5432,
          user: config.user || "postgres",
          password: config.password || "",
          database: config.database || "cms",
          // pg takes the boolean and the options object as-is.
          ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
        },
      });

    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}

// The discrete way of naming WHERE to connect. A `url` says the same thing, so
// the two are alternatives, not layers — see the guard in `doConnect`.
const ENDPOINT_SIBLINGS = ["host", "port", "user", "password", "db", "filename"] as const;

function doConnect(def: Record<string, unknown>, context: Context): unknown {
  return resolveObj(def, context, r => {
    const name = String(r.name ?? "default");
    // A `url` supplies the whole endpoint and picks the driver via its scheme.
    const fromUrl = r.url ? parseDbUrl(String(r.url)) : null;
    if (fromUrl) {
      // Both spellings of the endpoint at once leaves "which wins" to guesswork,
      // and the loser fails as a connection error far from the typo. `ssl`/`tls`
      // are exempt: they say HOW to connect, not where, and layering a local CA
      // over a url from the environment is the point.
      const also = ENDPOINT_SIBLINGS.filter(k => r[k] != null);
      if (also.length > 0) {
        throw new Error(
          `[DatabaseNode] "url" already carries the endpoint — drop ${also.map(k => `"${k}"`).join(", ")}, or drop the url and spell it out`,
        );
      }
    }
    const declared = r.type == null ? undefined : String(r.type);
    if (declared !== undefined && !isDatabaseType(declared)) {
      throw new Error(
        `[DatabaseNode] unknown database "type": "${declared}" (expected ${DATABASE_TYPES.join(", ")})`,
      );
    }
    const type = declared ?? fromUrl?.type ?? (r.filename != null ? "sqlite" : undefined);
    if (!type) {
      throw new Error("[DatabaseNode] connect needs a \"type\" (or a \"url\" whose scheme names one, or a \"filename\" for SQLite)");
    }
    // Two drivers named at once means one of them is a mistake, and the losing
    // one would only surface as a confusing protocol error at dial time.
    if (fromUrl && fromUrl.type !== type) {
      throw new Error(
        `[DatabaseNode] type "${type}" contradicts the url scheme, which names "${fromUrl.type}"`,
      );
    }
    // A url parses into a finished config, so it IS the config. The discrete
    // properties spell out the same shape by hand, and the guard above has
    // already ruled out a step carrying both.
    const config: DatabaseConfig = fromUrl ?? { type };
    if (!fromUrl) {
      if (r.filename) config.filename = String(r.filename);
      if (r.host) config.host = String(r.host);
      if (r.port) config.port = Number(r.port);
      if (r.user) config.user = String(r.user);
      if (r.password) config.password = String(r.password);
      if (r.db) config.database = String(r.db);
    }

    // TLS layers over either spelling: the url may carry `sslmode`, the sibling
    // refines it. SQLite has no transport to secure, so it never reports one.
    if (type !== "sqlite") {
      const ssl = mergeTls(config.ssl, parseTls(r.ssl ?? r.tls));
      if (ssl !== undefined) config.ssl = ssl;
    }

    DatabaseNode.getInstance(name, config);

    if (!defaultConnectionName) {
      defaultConnectionName = name;
    }

    return {
      type: "database",
      action: "connect",
      name,
      info: DatabaseNode.getInfo(name),
    };
  });
}

function doClose(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.name ?? null, context, async nameRaw => {
    const name = connectionName(nameRaw);

    try {
      await DatabaseNode.closeConnection(name);

      if (defaultConnectionName === name) {
        defaultConnectionName = null;
      }

      console.log(`[DatabaseNode] Closed connection: ${name}`);

      return { type: "database", action: "close", name };
    } catch (error) {
      console.error(`[DatabaseNode] Error closing ${name}:`, error);
      return null;
    }
  });
}

function doRaw(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.connection ?? null, def.sql, def.bindings ?? null], context, async ([connectionRaw, sqlRaw, bindingsRaw]) => {
    const conn = requireConnection(connectionRaw);
    const sql = String(sqlRaw);
    const bindings = toBindings(bindingsRaw);
    // knex has no "bindings: undefined" overload — omitted means the 1-arg call.
    const result = await (bindings ? conn.knex.raw(sql, bindings) : conn.knex.raw(sql));
    // SQLite hands back the rows; the others wrap them in a result-set array.
    return conn.info.type === "sqlite" ? result : result[0];
  });
}

function doTableExists(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.connection ?? null, def.table], context, async ([connectionRaw, tableRaw]) => {
    const table = String(tableRaw);
    return requireConnection(connectionRaw).knex.schema.hasTable(table);
  });
}

function doDropTable(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.connection ?? null, def.table], context, async ([connectionRaw, tableRaw]) => {
    const table = String(tableRaw);
    await requireConnection(connectionRaw).knex.schema.dropTableIfExists(table);
    return { type: "database", action: "dropTable", table };
  });
}

function doInfo(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.name ?? null, context, async nameRaw => {
    // `info` reports on an unknown connection with `null` rather than throwing,
    // so it resolves the name but does not go through `requireConnection`.
    const conn = connections.get(connectionName(nameRaw));
    if (!conn) return null;

    const result: Record<string, unknown> = { ...conn.info };

    if (conn.info.type === "sqlite") {
      try {
        // For SQLite the location IS the file path.
        const stat = fs.statSync(conn.info.location);
        result.size = stat.size;
      } catch { /* ignore */ }
    }

    try {
      if (conn.info.type === "sqlite") {
        const tables = await conn.knex.raw("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        result.tables = tables[0]?.count ?? 0;
      } else if (conn.info.type === "mysql") {
        const tables = await conn.knex.raw("SELECT count(*) as count FROM information_schema.tables WHERE table_schema = database()");
        result.tables = tables[0]?.[0]?.count ?? 0;
      } else if (conn.info.type === "pg") {
        const tables = await conn.knex.raw("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'");
        result.tables = parseInt(tables.rows?.[0]?.count ?? "0", 10);
      }
    } catch { /* ignore */ }

    return result;
  });
}
