import { Node, Context, NodeValue, resolve, resolveAll, resolveObj } from "@jexs/core";
import { Cache, CacheConfig } from "../cache/Cache.js";

/**
 * CacheNode - Handles cache connections and operations in JSON.
 *
 * Connect:
 * { "cache": "connect", "type": "redis", "host": "localhost", "port": 6379 }
 * { "cache": "connect", "type": "memory" }
 * { "cache": "connect", "type": "memcached", "servers": ["localhost:11211"] }
 *
 * Operations:
 * { "cache": "get", "key": "mykey" }
 * { "cache": "set", "key": "mykey", "value": {...}, "ttl": 3600 }
 * { "cache": "delete", "key": "mykey" }
 * { "cache": "has", "key": "mykey" }
 * { "cache": "clear" }
 *
 * Close:
 * { "cache": "close" }
 */
export class CacheNode extends Node {
  /**
   * Connects to or operates on a cache store.
   *
   * @param {"connect"|"get"|"set"|"delete"|"has"|"clear"|"close"|"stats"} cache Operation to perform.
   * @param {"redis"|"memory"|"memcached"} type Cache driver (used with `"connect"`).
   * @param {string} key Cache key (used with `"get"`, `"set"`, `"delete"`, `"has"`).
   * @param {expr} value Value to store (used with `"set"`).
   * @param {number} ttl Time-to-live in seconds (used with `"set"`).
   * @example
   * { "cache": "set", "key": "user:42", "value": { "var": "$user" }, "ttl": 3600 }
   */
  cache(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.cache, context, operation => {
      switch (String(operation)) {
        case "connect":
          return doConnect(def, context);
        case "close":
          return doClose();
        case "get":
          return doGet(def, context);
        case "set":
          return doSet(def, context);
        case "delete":
          return doDelete(def, context);
        case "has":
          return doHas(def, context);
        case "clear":
          return doClear();
        case "stats":
          return Cache.getInstance().stats();
        case "dump": {
          const instance = Cache.getInstance() as unknown as Record<string, unknown>;
          if (typeof instance.dump === "function") return instance.dump();
          return { error: "dump only supported for memory cache" };
        }
        default:
          console.error(`[CacheNode] Unknown operation: ${operation}`);
          return null;
      }
    });
  }
}

function doConnect(def: Record<string, unknown>, context: Context): unknown {
  return resolveObj(def, context, r => {
    const type = String(r.type ?? "memory") as CacheConfig["type"];
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

    return { type: "cache", action: "connect", cacheType: type };
  });
}

async function doClose(): Promise<unknown> {
  await Cache.close();
  console.log("[CacheNode] Cache connection closed");
  return { type: "cache", action: "close" };
}

function doGet(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.key, context, async key => Cache.getInstance().get(String(key)));
}

function doSet(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.key, def.value, def.ttl ?? null], context, async ([keyRaw, value, ttlRaw]) => {
    const key = String(keyRaw);
    const ttl = ttlRaw != null ? Number(ttlRaw) : undefined;
    await Cache.getInstance().set(key, value, ttl);
    return { type: "cache", action: "set", key };
  });
}

function doDelete(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.key, context, async keyRaw => {
    const key = String(keyRaw);
    const deleted = await Cache.getInstance().delete(key);
    return { type: "cache", action: "delete", key, deleted };
  });
}

function doHas(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.key, context, async keyRaw => Cache.getInstance().has(String(keyRaw)));
}

async function doClear(): Promise<unknown> {
  await Cache.getInstance().clear();
  return { type: "cache", action: "clear" };
}
