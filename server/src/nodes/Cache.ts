import { Node, Context, NodeValue, resolve, resolveAll, resolveObj, createHttpError } from "@jexs/core";
import { Cache, CacheConfig } from "../cache/Cache.js";
import type { JexsNodeSchema } from "@jexs/core";

export class CacheNode extends Node {
  static schema: JexsNodeSchema = {
    "cache-connect": {
      type: "string",
      enum: ["redis", "memory", "memcached"],
      output: "string",
      markdownDescription: "Initializes the cache singleton. The value selects the driver; connection details vary by driver.",
      outputDescription: "The connected driver name (`\"memory\"`, `\"redis\"`, or `\"memcached\"`).",
      examples: [
        "{ \"cache-connect\": \"memory\" }",
        "{ \"cache-connect\": \"redis\", \"host\": \"localhost\", \"port\": 6379 }",
        "{ \"cache-connect\": \"memcached\", \"servers\": [\"localhost:11211\"] }",
      ],
      siblings: {
        prefix:     { type: "string", description: "Key prefix applied to every operation." },
        defaultTtl: { type: "number", description: "Default TTL in seconds when `ttl` is omitted on set." },
      },
      variants: {
        redis: {
          markdownDescription: "Redis driver.",
          siblings: {
            host:     { type: "string", description: "Redis hostname." },
            port:     { type: "number", description: "Redis port." },
            password: { type: "string", description: "Auth password." },
            db:       { type: "number", description: "Database index." },
          },
        },
        memcached: {
          markdownDescription: "Memcached driver.",
          siblings: {
            servers: { type: "array",  description: "Server list as `host:port` strings." },
            host:    { type: "string", description: "Hostname (used to build one server when `servers` is omitted)." },
            port:    { type: "number", description: "Port (with `host`)." },
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
        "{ \"cache-get\": \"user:42\" }",
      ],
    },
    "cache-set": {
      type: "string",
      markdownDescription: "Writes the `value` sibling under the given key. Optional `ttl` sibling sets expiry in seconds.",
      outputDescription: "The driver's write result, resolved once the value is stored (truthy on success).",
      examples: [
        "{ \"cache-set\": \"user:42\", \"value\": { \"var\": \"$user\" }, \"ttl\": 3600 }",
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
        "{ \"cache-delete\": \"user:42\" }",
      ],
    },
    "cache-has": {
      type: "string",
      output: "boolean",
      markdownDescription: "Checks whether `key` is present in the cache.",
      outputDescription: "`true` if the key is present (and unexpired), otherwise `false`.",
      examples: [
        "{ \"cache-has\": \"user:42\" }",
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
        "{ \"cache\": \"stats\" }",
        "{ \"cache\": \"clear\" }",
      ],
      variants: {
        close: { output: "null", markdownDescription: "Closes the cache connection." },
        clear: { output: "null", markdownDescription: "Removes every entry.", outputDescription: "Always `null`." },
        stats: { output: "object", markdownDescription: "Reports driver statistics.", outputDescription: "A stats object (hit/miss counts, entry count/size, etc.) — exact fields depend on the driver." },
        dump:  { output: "object", markdownDescription: "Snapshots the cache contents (memory driver only).", outputDescription: "An object snapshot of all entries. Memory driver only — other drivers return an error object." },
      },
    },
  };

  ["cache-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const type = String(r["cache-connect"] ?? "memory") as CacheConfig["type"];
      const config: CacheConfig = { type };

      if (r.prefix) config.prefix = String(r.prefix);
      if (r.defaultTtl) config.defaultTtl = Number(r.defaultTtl);

      if (type === "redis") {
        config.redis = {};
        if (r.host) config.redis.host = String(r.host);
        if (r.port) config.redis.port = Number(r.port);
        if (r.password) config.redis.password = String(r.password);
        if (r.db) config.redis.db = Number(r.db);
      }

      if (type === "memcached") {
        config.memcached = {};
        if (r.servers && Array.isArray(r.servers)) {
          config.memcached.servers = r.servers.map((s) => String(s));
        } else if (r.host) {
          const p = r.port ? Number(r.port) : 11211;
          config.memcached.servers = [`${r.host}:${p}`];
        }
      }

      if (type === "memory") {
        config.memory = {};
        if (r.maxSize) config.memory.maxSize = Number(r.maxSize);
        if (r.checkPeriod) config.memory.checkPeriod = Number(r.checkPeriod);
      }

      Cache.init(config);
      console.log(`[CacheNode] Connected to cache (${type})`);
      return type;
    });
  }

  ["cache"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.cache, context, op => {
      switch (op) {
        case "close": return Cache.close();
        case "clear": return Cache.getInstance().clear();
        case "stats": return Cache.getInstance().stats();
        case "dump": {
          const instance = Cache.getInstance() as unknown as Record<string, unknown>;
          if (typeof instance.dump === "function") return instance.dump();
          throw createHttpError(501, "cache dump is only supported by the memory driver");
        }
        default:
          throw createHttpError(400, `Unknown cache op: ${String(op)}`);
      }
    });
  }

  ["cache-get"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["cache-get"], context, async key => Cache.getInstance().get(String(key)));
  }

  ["cache-set"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["cache-set"], def.value ?? null, def.ttl ?? null], context, async ([keyRaw, value, ttlRaw]) => {
      const key = String(keyRaw);
      const ttl = ttlRaw != null ? Number(ttlRaw) : undefined;
      return Cache.getInstance().set(key, value, ttl);
    });
  }

  ["cache-delete"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["cache-delete"], context, async keyRaw => Cache.getInstance().delete(String(keyRaw)));
  }

  ["cache-has"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["cache-has"], context, async keyRaw => Cache.getInstance().has(String(keyRaw)));
  }
}
