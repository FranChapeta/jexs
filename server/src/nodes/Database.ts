import Knex, { Knex as KnexType } from "knex";
import fs from "node:fs";
import path from "node:path";
import { Node, Context, NodeValue, resolve, resolveAll, resolveObj } from "@jexs/core";

// Database configuration interface
export interface DatabaseConfig {
  type: "sqlite" | "mysql" | "pg";
  // SQLite
  filename?: string;
  // MySQL / PostgreSQL
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

// Internal connection wrapper
interface DatabaseConnection {
  knex: KnexType;
  config: DatabaseConfig;
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
  /**
   * Manages database connections. Operations: `"connect"`, `"close"`, `"raw"`, `"tableExists"`, `"dropTable"`, `"info"`.
   * Supports SQLite (`better-sqlite3`), MySQL (`mysql2`), and PostgreSQL (`pg`) via Knex.
   *
   * @example
   * { "database": "connect", "name": "main", "type": "sqlite", "filename": "app/data.db" }
   */
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
    connections.set(name, { knex, config });
  }

  static getKnex(name: string = "default"): KnexType {
    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);
    return conn.knex;
  }

  static getInfo(
    name: string = "default",
  ): { type: string; location: string } | null {
    const conn = connections.get(name);
    if (!conn) return null;

    return {
      type: conn.config.type,
      location:
        conn.config.type === "sqlite"
          ? conn.config.filename || "data.db"
          : `${conn.config.host}:${conn.config.port}/${conn.config.database}`,
    };
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

  static async raw<T = unknown>(
    name: string,
    sql: string,
    bindings?: readonly unknown[],
  ): Promise<T> {
    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);

    const result = await conn.knex.raw(
      sql,
      bindings as readonly KnexType.RawBinding[],
    );
    return conn.config.type === "sqlite" ? result : result[0];
  }

  static async hasTable(name: string, tableName: string): Promise<boolean> {
    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);
    return conn.knex.schema.hasTable(tableName);
  }

  static async transaction<T>(
    name: string,
    callback: (trx: KnexType.Transaction) => Promise<T>,
  ): Promise<T> {
    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);
    return conn.knex.transaction(callback);
  }
}

function createConnection(config: DatabaseConfig): KnexType {
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
        },
      });

    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}

function doConnect(def: Record<string, unknown>, context: Context): unknown {
  return resolveObj(def, context, r => {
    const name = String(r.name ?? "default");
    const type = String(r.type) as DatabaseConfig["type"];
    const config: DatabaseConfig = { type };

    if (type === "sqlite") {
      if (r.filename) config.filename = String(r.filename);
    }

    if (type === "mysql" || type === "pg") {
      if (r.host) config.host = String(r.host);
      if (r.port) config.port = Number(r.port);
      if (r.user) config.user = String(r.user);
      if (r.password) config.password = String(r.password);
      if (r.db) config.database = String(r.db);
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
    const name = String(nameRaw ?? "default");

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
    const name = String(connectionRaw ?? defaultConnectionName ?? "default");
    const sql = String(sqlRaw);
    const bindings = bindingsRaw as unknown[] | undefined;

    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);

    const result = await conn.knex.raw(
      sql,
      bindings as readonly KnexType.RawBinding[],
    );
    return conn.config.type === "sqlite" ? result : result[0];
  });
}

function doTableExists(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.connection ?? null, def.table], context, async ([connectionRaw, tableRaw]) => {
    const name = String(connectionRaw ?? defaultConnectionName ?? "default");
    const table = String(tableRaw);

    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);

    return conn.knex.schema.hasTable(table);
  });
}

function doDropTable(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.connection ?? null, def.table], context, async ([connectionRaw, tableRaw]) => {
    const name = String(connectionRaw ?? defaultConnectionName ?? "default");
    const table = String(tableRaw);

    const conn = connections.get(name);
    if (!conn) throw new Error(`Database "${name}" not connected`);

    await conn.knex.schema.dropTableIfExists(table);
    return { type: "database", action: "dropTable", table };
  });
}

function doInfo(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.name ?? null, context, async nameRaw => {
    const name = String(nameRaw ?? defaultConnectionName ?? "default");
    const basic = DatabaseNode.getInfo(name);
    if (!basic) return null;

    const conn = connections.get(name);
    if (!conn) return basic;

    const result: Record<string, unknown> = { ...basic };

    if (conn.config.type === "sqlite") {
      try {
        const stat = fs.statSync(conn.config.filename || "data.db");
        result.size = stat.size;
      } catch { /* ignore */ }
    }

    try {
      if (conn.config.type === "sqlite") {
        const tables = await conn.knex.raw("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        result.tables = tables[0]?.count ?? 0;
      } else if (conn.config.type === "mysql") {
        const tables = await conn.knex.raw("SELECT count(*) as count FROM information_schema.tables WHERE table_schema = database()");
        result.tables = tables[0]?.[0]?.count ?? 0;
      } else if (conn.config.type === "pg") {
        const tables = await conn.knex.raw("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'");
        result.tables = parseInt(tables.rows?.[0]?.count ?? "0", 10);
      }
    } catch { /* ignore */ }

    return result;
  });
}
