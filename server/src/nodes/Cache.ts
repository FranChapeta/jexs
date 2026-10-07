import { Node, Context, NodeValue, resolveAll, resolveFields, resolverFor, createHttpError } from "@jexs/core";
import type { CacheAdapter, CacheConfig } from "../cache/CacheAdapter.js";
import { MemoryCache } from "../cache/MemoryCache.js";
import { RedisCache } from "../cache/RedisCache.js";
import { MemcachedCache } from "../cache/MemcachedCache.js";
import { parseTls, TLS_STRINGS } from "../connection.js";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

/** One of the resolver's caches, which its sessions and translations use too.
 *  Omit `name` for the default: whichever connected first. */
export function cacheFor(context: Context, name?: string): CacheAdapter {
  const node = resolverFor(context).nodeFor("cache");
  if (!(node instanceof CacheNode)) {
    throw new Error("No CacheNode in this resolver; build it with serverNodes().");
  }
  return CacheNode.adapterOf(node, name);
}

/** The adapter a `$cache-connect` config asks for. */
function createAdapter(config: CacheConfig): CacheAdapter {
  switch (config.type) {
    case "redis":
      return new RedisCache({ ...config.redis, prefix: config.prefix });
    case "memcached":
      return new MemcachedCache({ ...config.memcached, prefix: config.prefix });
    case "memory":
    default:
      return new MemoryCache({ prefix: config.prefix, ...config.memory });
  }
}

export class CacheNode extends Node {
  /** This resolver's caches by name, and whichever connected first. Instance
   *  fields, so one resolver's `$cache-connect`, `close` or `clear` never touches
   *  another's; `dispose` closes them. */
  private readonly adapters = new Map<string, CacheAdapter>();
  private defaultName: string | null = null;

  /**
   * The cache under `name`, or the default without one. The default is an
   * in-memory cache until `$cache-connect` opens another; a named cache must have
   * been connected. Static, since every method on a Node registers as an op.
   */
  static adapterOf(node: CacheNode, name?: string): CacheAdapter {
    const key = name ?? node.defaultName ?? "default";
    const adapter = node.adapters.get(key);
    if (adapter) return adapter;
    if (name !== undefined) {
      throw new Error(`Cache "${name}" is not connected. Open it with { "$cache-connect": "memory", "connection": "${name}" }`);
    }
    console.warn("[Cache] Not connected, using memory cache");
    const fallback = new MemoryCache();
    node.adapters.set(key, fallback);
    node.defaultName ??= key;
    return fallback;
  }

  dispose(): void {
    for (const adapter of this.adapters.values()) void adapter.close().catch(() => {});
    this.adapters.clear();
    this.defaultName = null;
  }

  static schema: JexsNodeSchema = {
    "cache-connect": {
      type: "string",
      enum: ["redis", "memory", "memcached"],
      output: "string",
      markdownDescription: "Opens a named cache, replacing any already open under that name. The first one opened is the default, which the other `cache-*` ops, sessions and translations use unless told otherwise. The value selects the driver; connection details vary by driver. Redis also accepts a `url` connection string in place of the discrete host/port properties — memcached does not, because its connection format is the server list itself.",
      outputDescription: "The connected driver name (`\"memory\"`, `\"redis\"`, or `\"memcached\"`).",
      examples: [
        "{ \"$cache-connect\": \"memory\" }",
        "{ \"$cache-connect\": \"redis\", \"host\": \"localhost\", \"port\": 6379 }",
        "{ \"$cache-connect\": \"redis\", \"url\": { \"$var\": \"env.REDIS_URL\" } }",
        "{ \"$cache-connect\": \"memcached\", \"servers\": [\"localhost:11211\"] }",
        "{ \"$cache-connect\": \"redis\", \"connection\": \"sessions\", \"url\": { \"$var\": \"env.REDIS_URL\" } }",
      ],
      siblings: {
        prefix:     { type: "string", description: "Key prefix applied to every operation." },
        defaultTtl: { type: "number", description: "Default TTL in seconds when `ttl` is omitted on set." },
      },
      variants: {
        redis: {
          markdownDescription: "Redis driver.",
          siblings: {
            tls: {
              type: ["boolean", "string", "object"],
              enum: TLS_STRINGS,
              markdownDescription: "TLS for the connection, also spelled `ssl`. `true` encrypts AND verifies against the system trust store — the strictest setting, which fails on a private CA. An object takes `ca`, `cert`, `key`, `passphrase`, `servername`, `rejectUnauthorized`, `minVersion` and `ciphers`. The string forms (`\"true\"`, `\"1\"`, `\"require\"`, `\"false\"`, `\"0\"`, `\"disable\"`) are for a value arriving from `env` as text. Implied by a `rediss://` url.\n\nCertificates are PEM **content**, not paths: load the file first with `{ \"$file\": \"/certs/redis-ca.pem\", \"raw\": true, \"$as\": \"ca\" }` and pass `{ \"$var\": \"ca\" }`.",
              examples: [
                "true",
                "{ \"ca\": { \"$var\": \"ca\" }, \"servername\": \"cache.internal\" }",
              ],
            },
          },
          variants: {
            url: {
              type: "string",
              markdownDescription: "Connection string, e.g. `rediss://user:pass@host:6379/0`. `redis://` is plaintext, `rediss://` negotiates TLS. Carries host, port, credentials and database index, so it replaces `host`.",
            },
            host: {
              type: "string",
              markdownDescription: "Redis hostname, spelling the endpoint out instead of passing a `url`.",
              siblings: {
                port:     { type: "number", description: "Redis port (default 6379)." },
                username: { type: "string", description: "ACL username (Redis 6+)." },
                password: { type: "string", description: "Auth password." },
                db:       { type: "number", description: "Database index." },
              },
            },
          },
        },
        memcached: {
          markdownDescription: "Memcached driver. There is no `url` here as there is for `redis`: memcached's connection format is the `host:port` server list itself, with credentials alongside, which is what providers hand you. TLS is not supported by the underlying `memjs` client — tunnel it (stunnel, a service mesh) or use Redis where the traffic must be encrypted.",
          variants: {
            servers: {
              type: "array",
              items: { type: "string" },
              markdownDescription: "Server list as `host:port` strings.",
              siblings: {
                username: { type: "string", description: "SASL username." },
                password: { type: "string", description: "SASL password." },
              },
            },
            host: {
              type: "string",
              markdownDescription: "Hostname of a single server, the shorthand for a one-entry `servers`.",
              siblings: {
                port:     { type: "number", description: "Port (default 11211)." },
                username: { type: "string", description: "SASL username." },
                password: { type: "string", description: "SASL password." },
              },
            },
          },
        },
        memory: {
          markdownDescription: "In-memory driver.",
          siblings: {
            maxSize:     { type: "number", description: "Maximum entry count." },
            checkPeriod: { type: "number", description: "Expiry sweep interval in seconds." },
          },
        },
      },
    },
    "cache-get": {
      type: "string",
      markdownDescription: "Reads the value stored under `key`.",
      outputDescription: "The stored value (any JSON type), or `null` if the key is absent or expired.",
      examples: [
        "{ \"$cache-get\": \"user:42\" }",
      ],
    },
    "cache-set": {
      type: "string",
      markdownDescription: "Writes the `value` sibling under the given key. Optional `ttl` sibling sets expiry in seconds.",
      outputDescription: "The driver's write result, resolved once the value is stored (truthy on success).",
      examples: [
        "{ \"$cache-set\": \"user:42\", \"value\": { \"$var\": \"user\" }, \"ttl\": 3600 }",
      ],
      siblings: {
        value: { description: "Value to store." },
        ttl:   { type: "number", description: "Time-to-live in seconds." },
      },
    },
    "cache-delete": {
      type: "string",
      output: "boolean",
      markdownDescription: "Removes the entry under `key`.",
      outputDescription: "`true` if the key existed and was removed, otherwise `false`.",
      examples: [
        "{ \"$cache-delete\": \"user:42\" }",
      ],
    },
    "cache-has": {
      type: "string",
      output: "boolean",
      markdownDescription: "Checks whether `key` is present in the cache.",
      outputDescription: "`true` if the key is present (and unexpired), otherwise `false`.",
      examples: [
        "{ \"$cache-has\": \"user:42\" }",
      ],
    },
    // Keyless lifecycle / bulk ops fold into the bare `cache` key (value-mode):
    // their value carries no key, so the op name takes the value slot. Keyed CRUD
    // (`cache-get`/`set`/`has`/`delete`) and the driver-valued `cache-connect`
    // keep their prefix.
    cache: {
      type: "string",
      enum: ["close", "clear", "stats", "dump"],
      markdownDescription: "Cache lifecycle / bulk operation (the value is the op).",
      examples: [
        "{ \"$cache\": \"stats\" }",
        "{ \"$cache\": \"clear\" }",
      ],
      variants: {
        close: { output: "null", markdownDescription: "Closes a cache. Closing the default leaves an in-memory default until another cache is opened." },
        clear: { output: "null", markdownDescription: "Removes every entry.", outputDescription: "Always `null`." },
        stats: {
          output: {
            type: "object",
            properties: {
              type: { type: "string", description: "The driver: `memory`, `redis` or `memcached`." },
              size: { type: "number", description: "How many entries it holds." },
              maxSize: { type: "number", description: "Memory driver: its entry limit." },
              bytes: { type: "number", description: "Redis and memcached: the memory in use." },
              maxBytes: { type: "number", description: "The memory limit, where the driver reports one." },
            },
          },
          markdownDescription: "Reports driver statistics.",
          outputDescription: "The entry count and, where the driver knows them, its limits and memory use.",
        },
        dump:  { output: "object", markdownDescription: "Snapshots the cache contents (memory driver only).", outputDescription: "An object snapshot of all entries. Memory driver only; other drivers fail with a 501." },
      },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    connection: {
      type: "string",
      description: "Name of the cache connection (default `\"default\"`, or whichever cache connected first).",
    },
  };

  ["cache-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, r => {
      const type = cacheDriver(r["$cache-connect"]);
      const config: CacheConfig = { type };

      if (r.prefix) config.prefix = String(r.prefix);
      if (r.defaultTtl) config.defaultTtl = Number(r.defaultTtl);
      requireOneEndpoint(r, type);

      if (type === "redis") {
        config.redis = {};
        if (r.url) {
          config.redis.url = String(r.url);
        } else {
          if (r.host) config.redis.host = String(r.host);
          if (r.port) config.redis.port = Number(r.port);
          if (r.username) config.redis.username = String(r.username);
          if (r.password) config.redis.password = String(r.password);
          if (r.db) config.redis.db = Number(r.db);
        }
        const tls = parseTls(r.tls ?? r.ssl);
        if (tls !== undefined) config.redis.tls = tls;
      }

      if (type === "memcached") {
        // memjs dials over a plain socket, so silently accepting a `tls` here
        // would ship unencrypted traffic while the template says otherwise.
        if (r.tls != null || r.ssl != null) {
          throw createHttpError(501, "the memcached driver does not support TLS; tunnel it or use redis");
        }
        config.memcached = {};
        if (r.servers && Array.isArray(r.servers)) {
          config.memcached.servers = r.servers.map((s) => String(s));
        } else if (r.host) {
          const p = r.port ? Number(r.port) : 11211;
          config.memcached.servers = [`${r.host}:${p}`];
        }
        if (r.username) config.memcached.username = String(r.username);
        if (r.password) config.memcached.password = String(r.password);
      }

      if (type === "memory") {
        config.memory = {};
        if (r.maxSize) config.memory.maxSize = Number(r.maxSize);
        if (r.checkPeriod) config.memory.checkPeriod = Number(r.checkPeriod);
      }

      // Replacing a name closes the cache it had.
      const name = optionalName(r.connection) ?? "default";
      void this.adapters.get(name)?.close().catch(() => {});
      this.adapters.set(name, createAdapter(config));
      this.defaultName ??= name;
      console.log(`[CacheNode] Connected to cache "${name}" (${type})`);
      return type;
    });
  }

  ["cache"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$cache, def.connection ?? null], context, ([op, nameRaw]) => {
      const name = optionalName(nameRaw);
      switch (op) {
        case "close": {
          const key = name ?? this.defaultName ?? "default";
          const adapter = this.adapters.get(key);
          this.adapters.delete(key);
          if (this.defaultName === key) this.defaultName = null;
          return adapter?.close() ?? null;
        }
        case "clear": return CacheNode.adapterOf(this, name).clear();
        case "stats": return CacheNode.adapterOf(this, name).stats();
        case "dump": {
          const instance = CacheNode.adapterOf(this, name) as unknown as Record<string, unknown>;
          if (typeof instance.dump === "function") return instance.dump();
          throw createHttpError(501, "cache dump is only supported by the memory driver");
        }
        default:
          throw createHttpError(400, `Unknown cache op: ${String(op)}`);
      }
    });
  }

  ["cache-get"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$cache-get"], def.connection ?? null], context, async ([key, connection]) =>
      CacheNode.adapterOf(this, optionalName(connection)).get(String(key)));
  }

  ["cache-set"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$cache-set"], def.value ?? null, def.ttl ?? null, def.connection ?? null], context, async ([keyRaw, value, ttlRaw, connection]) => {
      const key = String(keyRaw);
      const ttl = ttlRaw != null ? Number(ttlRaw) : undefined;
      return CacheNode.adapterOf(this, optionalName(connection)).set(key, value, ttl);
    });
  }

  ["cache-delete"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$cache-delete"], def.connection ?? null], context, async ([keyRaw, connection]) =>
      CacheNode.adapterOf(this, optionalName(connection)).delete(String(keyRaw)));
  }

  ["cache-has"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$cache-has"], def.connection ?? null], context, async ([keyRaw, connection]) =>
      CacheNode.adapterOf(this, optionalName(connection)).has(String(keyRaw)));
  }
}

/** A resolved cache-name sibling: absent (or resolving to nothing) means the default. */
export function optionalName(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

const CACHE_DRIVERS = ["memory", "redis", "memcached"] as const;

function cacheDriver(value: unknown): CacheConfig["type"] {
  const type = String(value ?? "memory");
  if ((CACHE_DRIVERS as readonly string[]).includes(type)) {
    return type as CacheConfig["type"];
  }
  throw createHttpError(
    400,
    `Unknown cache driver "${type}" (expected ${CACHE_DRIVERS.join(", ")})`,
  );
}

// Per driver, the properties a `url` already carries
// Only redis takes a `url`, so it is the only driver with a second spelling of
// the endpoint to rule out.
const ENDPOINT_SIBLINGS: Record<string, readonly string[]> = {
  redis: ["host", "port", "username", "password", "db"],
};

/**
 * Refuse a `url` given alongside the discrete endpoint properties
 */
function requireOneEndpoint(r: Record<string, unknown>, type: string): void {
  if (!r.url) return;
  const also = (ENDPOINT_SIBLINGS[type] ?? []).filter(k => r[k] != null);
  if (also.length > 0) {
    throw createHttpError(
      400,
      `"url" already carries the endpoint — drop ${also.map(k => `"${k}"`).join(", ")}, or drop the url and spell it out`,
    );
  }
}
