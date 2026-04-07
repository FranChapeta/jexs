import { Client } from "memjs";
import { CacheAdapter, CacheStats } from "./CacheAdapter.js";

/**
 * Memcached cache adapter using memjs.
 * Good for distributed caching with simple key-value needs.
 */
export class MemcachedCache implements CacheAdapter {
  private client: Client;
  private prefix: string;

  constructor(
    options: {
      servers?: string[];
      prefix?: string;
      username?: string;
      password?: string;
    } = {},
  ) {
    this.prefix = options.prefix ?? "";

    // memjs expects servers as comma-separated string
    const serverString = options.servers?.join(",") ?? "127.0.0.1:11211";

    this.client = Client.create(serverString, {
      username: options.username,
      password: options.password,
      retries: 2,
      timeout: 1,
      failover: true,
    });
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      this.client.get(
        this.key(key),
        (err: Error | null, value: Buffer | null) => {
          if (err || value === null) {
            resolve(undefined);
            return;
          }

          try {
            const str = value.toString("utf8");
            resolve(JSON.parse(str) as T);
          } catch {
            resolve(value.toString("utf8") as T);
          }
        },
      );
    });
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const serialized = JSON.stringify(value);
      const expiry = ttl && ttl > 0 ? ttl : 0;

      this.client.set(
        this.key(key),
        serialized,
        { expires: expiry },
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined;
  }

  async delete(key: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.client.delete(this.key(key), (err: Error | null) => {
        resolve(!err);
      });
    });
  }

  async deletePattern(_pattern: string): Promise<number> {
    // Memcached doesn't support pattern deletion
    // Would need to track keys separately or use flush
    console.warn(
      "[MemcachedCache] deletePattern not supported, use clear() instead",
    );
    return 0;
  }

  async clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.flush((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    this.client.close();
  }

  async stats(): Promise<CacheStats> {
    type StatsCallback = (err: Error | null, server: string, stats: Record<string, string>) => void;
    const client = this.client as typeof this.client & { stats(cb: StatsCallback): void };
    return new Promise((resolve) => {
      client.stats((err: Error | null, _server: string, stats: Record<string, string>) => {
        if (err || !stats) {
          resolve({ type: "memcached", size: 0 });
          return;
        }
        resolve({
          type: "memcached",
          size: parseInt(stats.curr_items ?? "0", 10),
          bytes: parseInt(stats.bytes ?? "0", 10),
          maxBytes: parseInt(stats.limit_maxbytes ?? "0", 10),
        });
      });
    });
  }

  /**
   * Get the underlying memjs client for advanced operations
   */
  getClient(): Client {
    return this.client;
  }
}
