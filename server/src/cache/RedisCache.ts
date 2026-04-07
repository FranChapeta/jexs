import { Redis } from "ioredis";
import { CacheAdapter, CacheStats } from "./CacheAdapter.js";

/**
 * Redis cache adapter using ioredis.
 * Best for production multi-instance deployments.
 */
export class RedisCache implements CacheAdapter {
  private client: Redis;
  private prefix: string;

  constructor(
    options: {
      host?: string;
      port?: number;
      password?: string;
      db?: number;
      prefix?: string;
    } = {},
  ) {
    this.prefix = options.prefix ?? "";

    this.client = new Redis({
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 6379,
      password: options.password,
      db: options.db ?? 0,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 3) return null; // Stop retrying after 3 attempts
        return Math.min(times * 200, 2000);
      },
    });
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const data = await this.client.get(this.key(key));
    if (data === null) return undefined;

    try {
      return JSON.parse(data) as T;
    } catch {
      return data as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const fullKey = this.key(key);

    if (ttl && ttl > 0) {
      await this.client.setex(fullKey, ttl, serialized);
    } else {
      await this.client.set(fullKey, serialized);
    }
  }

  async has(key: string): Promise<boolean> {
    const exists = await this.client.exists(this.key(key));
    return exists === 1;
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.client.del(this.key(key));
    return deleted > 0;
  }

  async deletePattern(pattern: string): Promise<number> {
    const fullPattern = this.key(pattern);
    let cursor = "0";
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        fullPattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        const deleted = await this.client.del(...keys);
        totalDeleted += deleted;
      }
    } while (cursor !== "0");

    return totalDeleted;
  }

  async clear(): Promise<void> {
    if (this.prefix) {
      await this.deletePattern("*");
    } else {
      await this.client.flushdb();
    }
  }

  async remember<T>(
    key: string,
    ttl: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  async stats(): Promise<CacheStats> {
    const size = await this.client.dbsize();
    const infoStr = await this.client.info("memory");
    const usedMatch = infoStr.match(/used_memory:(\d+)/);
    const maxMatch = infoStr.match(/maxmemory:(\d+)/);
    return {
      type: "redis",
      size,
      bytes: usedMatch ? parseInt(usedMatch[1], 10) : undefined,
      maxBytes: maxMatch ? parseInt(maxMatch[1], 10) : undefined,
    };
  }

  /**
   * Get the underlying Redis client for advanced operations
   */
  getClient(): Redis {
    return this.client;
  }
}
