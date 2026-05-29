import { Node, Context, NodeValue, resolve, resolveAll, resolveObj, createHttpError } from "@jexs/core";
import { Cache, CacheConfig } from "../cache/Cache.js";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

export class CacheNode extends Node {
  static schema: JexsNodeSchema = {
    "cache-connect": {
      type: "string",
      enum: ["redis", "memory", "memcached"],
      markdownDescription: "Initializes the cache singleton. The value selects the driver; connection details are siblings.",
      examples: [
        "{ \"cache-connect\": \"memory\" }",
        "{ \"cache-connect\": \"redis\", \"host\": \"localhost\", \"port\": 6379 }",
        "{ \"cache-connect\": \"memcached\", \"servers\": [\"localhost:11211\"] }",
      ],
      siblings: {
        host:         { type: "string", description: "Hostname (redis, memcached fallback)." },
        port:         { type: "number", description: "Port number." },
        password:     { type: "string", description: "Auth password (redis)." },
        db:           { type: "number", description: "Database index (redis)." },
        servers:      { type: "array",  description: "Server list as `host:port` strings (memcached)." },
        maxSize:      { type: "number", description: "Maximum entry count (memory)." },
        checkPeriod:  { type: "number", description: "Expiry sweep interval in seconds (memory)." },
        prefix:       { type: "string", description: "Key prefix applied to every operation." },
        defaultTtl:   { type: "number", description: "Default TTL in seconds when `ttl` is omitted on set." },
      },
    },
    "cache-close": {
      type: "boolean",
      output: "null",
      markdownDescription: "Closes the cache connection. Pass `true` to trigger.",
    },
    "cache-get": {
      type: "string",
      markdownDescription: "Reads the value stored under `key`. Returns the value or `null` if absent.",
      examples: [
        "{ \"cache-get\": \"user:42\" }",
      ],
    },
    "cache-set": {
      type: "string",
      markdownDescription: "Writes the `value` sibling under the given key. Optional `ttl` sibling sets expiry in seconds.",
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
      markdownDescription: "Removes the entry under `key`. Returns `true` if the key existed.",
      examples: [
        "{ \"cache-delete\": \"user:42\" }",
      ],
    },
    "cache-has": {
      type: "string",
      output: "boolean",
      markdownDescription: "Checks whether `key` is present in the cache.",
      examples: [
        "{ \"cache-has\": \"user:42\" }",
      ],
    },
    "cache-clear": {
      type: "boolean",
      output: "null",
      markdownDescription: "Removes every entry. Pass `true` to trigger.",
    },
    "cache-stats": {
      type: "boolean",
      output: "object",
      markdownDescription: "Returns driver-reported statistics (hit/miss counts, size, etc.).",
    },
    "cache-dump": {
      type: "boolean",
      output: "object",
      markdownDescription: "Returns a snapshot of the cache contents. Memory driver only; other drivers return an error.",
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {};

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

  ["cache-close"](_def: Record<string, unknown>, _context: Context): NodeValue {
    return Cache.close();
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

  ["cache-clear"](_def: Record<string, unknown>, _context: Context): NodeValue {
    return Cache.getInstance().clear();
  }

  ["cache-stats"](_def: Record<string, unknown>, _context: Context): NodeValue {
    return Cache.getInstance().stats();
  }

  ["cache-dump"](_def: Record<string, unknown>, _context: Context): NodeValue {
    const instance = Cache.getInstance() as unknown as Record<string, unknown>;
    if (typeof instance.dump === "function") return instance.dump();
    throw createHttpError(501, "cache-dump is only supported by the memory driver");
  }
}
