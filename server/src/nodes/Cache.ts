import { Node, Context, NodeValue, resolve } from "@jexs/core";
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
  async cache(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const operation = await resolve(def.cache, context);

    switch (operation) {
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
  }
}

async function doConnect(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const type = String(
    await resolve(def.type, context) ?? "memory",
  ) as CacheConfig["type"];
  const prefix = await resolve(def.prefix, context);
  const defaultTtl = await resolve(def.defaultTtl, context);

  const config: CacheConfig = { type };

  if (prefix) config.prefix = String(prefix);
  if (defaultTtl) config.defaultTtl = Number(defaultTtl);

  // Redis config
  if (type === "redis") {
    const host = await resolve(def.host, context);
    const port = await resolve(def.port, context);
    const password = await resolve(def.password, context);
    const db = await resolve(def.db, context);

    config.redis = {};
    if (host) config.redis.host = String(host);
    if (port) config.redis.port = Number(port);
    if (password) config.redis.password = String(password);
    if (db) config.redis.db = Number(db);
  }

  // Memcached config
  if (type === "memcached") {
    const servers = await resolve(def.servers, context);
    const host = await resolve(def.host, context);
    const port = await resolve(def.port, context);

    config.memcached = {};
    if (servers && Array.isArray(servers)) {
      config.memcached.servers = servers.map((s) => String(s));
    } else if (host) {
      const p = port ? Number(port) : 11211;
      config.memcached.servers = [`${host}:${p}`];
    }
  }

  // Memory config
  if (type === "memory") {
    const maxSize = await resolve(def.maxSize, context);
    const checkPeriod = await resolve(def.checkPeriod, context);

    config.memory = {};
    if (maxSize) config.memory.maxSize = Number(maxSize);
    if (checkPeriod) config.memory.checkPeriod = Number(checkPeriod);
  }

  Cache.init(config);
  console.log(`[CacheNode] Connected to cache (${type})`);

  return { type: "cache", action: "connect", cacheType: type };
}

async function doClose(): Promise<unknown> {
  await Cache.close();
  console.log("[CacheNode] Cache connection closed");
  return { type: "cache", action: "close" };
}

async function doGet(def: Record<string, unknown>, context: Context): Promise<unknown> {
  const key = String(await resolve(def.key, context));
  return Cache.getInstance().get(key);
}

async function doSet(def: Record<string, unknown>, context: Context): Promise<unknown> {
  const key = String(await resolve(def.key, context));
  const value = await resolve(def.value, context);
  const ttl = def.ttl ? Number(await resolve(def.ttl, context)) : undefined;
  await Cache.getInstance().set(key, value, ttl);
  return { type: "cache", action: "set", key };
}

async function doDelete(def: Record<string, unknown>, context: Context): Promise<unknown> {
  const key = String(await resolve(def.key, context));
  const deleted = await Cache.getInstance().delete(key);
  return { type: "cache", action: "delete", key, deleted };
}

async function doHas(def: Record<string, unknown>, context: Context): Promise<boolean> {
  const key = String(await resolve(def.key, context));
  return Cache.getInstance().has(key);
}

async function doClear(): Promise<unknown> {
  await Cache.getInstance().clear();
  return { type: "cache", action: "clear" };
}
