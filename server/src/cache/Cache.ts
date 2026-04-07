import { CacheAdapter, CacheConfig } from "./CacheAdapter.js";
import { MemoryCache } from "./MemoryCache.js";
import { RedisCache } from "./RedisCache.js";
import { MemcachedCache } from "./MemcachedCache.js";

/**
 * Cache factory and singleton manager.
 *
 * Usage:
 *   Cache.init({ type: 'redis', redis: { host: 'localhost' } });
 *   const cache = Cache.getInstance();
 *   await cache.set('key', 'value', 300);
 */
export class Cache {
  private static instance: CacheAdapter | null = null;
  private static config: CacheConfig | null = null;

  /**
   * Initialize cache with configuration
   */
  static init(config: CacheConfig): CacheAdapter {
    if (this.instance) {
      console.warn("[Cache] Already initialized, closing previous instance");
      this.instance.close().catch(() => {});
    }

    this.config = config;
    this.instance = this.createAdapter(config);
    return this.instance;
  }

  /**
   * Get cache instance (init with memory if not initialized)
   */
  static getInstance(): CacheAdapter {
    if (!this.instance) {
      console.warn("[Cache] Not initialized, using memory cache");
      this.instance = new MemoryCache();
    }
    return this.instance;
  }

  /**
   * Create adapter based on config
   */
  private static createAdapter(config: CacheConfig): CacheAdapter {
    switch (config.type) {
      case "redis":
        return new RedisCache({
          ...config.redis,
          prefix: config.prefix,
        });

      case "memcached":
        return new MemcachedCache({
          ...config.memcached,
          prefix: config.prefix,
        });

      case "memory":
      default:
        return new MemoryCache({
          prefix: config.prefix,
          ...config.memory,
        });
    }
  }

  /**
   * Close cache connection
   */
  static async close(): Promise<void> {
    if (this.instance) {
      await this.instance.close();
      this.instance = null;
    }
  }

  /**
   * Check if cache is initialized
   */
  static isInitialized(): boolean {
    return this.instance !== null;
  }

  /**
   * Get current config
   */
  static getConfig(): CacheConfig | null {
    return this.config;
  }
}

// Export types
export type { CacheAdapter, CacheConfig } from "./CacheAdapter.js";
