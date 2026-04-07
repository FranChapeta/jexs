import { CacheAdapter, CacheStats } from "./CacheAdapter.js";

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number | null; // null = no expiry
}

/**
 * In-memory cache adapter using Map.
 * Good for development and single-instance deployments.
 */
export class MemoryCache implements CacheAdapter {
  private cache = new Map<string, CacheEntry>();
  private prefix: string;
  private maxSize: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    options: { prefix?: string; maxSize?: number; checkPeriod?: number } = {},
  ) {
    this.prefix = options.prefix ?? "";
    this.maxSize = options.maxSize ?? 10000;

    // Periodic cleanup of expired entries
    const checkPeriod = options.checkPeriod ?? 60000; // 1 minute default
    if (checkPeriod > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), checkPeriod);
    }
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}:${k}` : k;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const k = this.key(key);
    const entry = this.cache.get(k);
    if (!entry) return undefined;

    // Check expiry
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      return undefined;
    }

    // Move to end for LRU ordering (most recently accessed = last)
    this.cache.delete(k);
    this.cache.set(k, entry);

    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    };

    this.cache.set(this.key(key), entry);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined;
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(this.key(key));
  }

  async deletePattern(pattern: string): Promise<number> {
    const fullPattern = this.key(pattern);
    const regex = this.patternToRegex(fullPattern);
    let count = 0;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  async clear(): Promise<void> {
    if (this.prefix) {
      // Only clear keys with our prefix
      await this.deletePattern("*");
    } else {
      this.cache.clear();
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
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }

  /**
   * Remove expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Convert glob pattern to regex
   * Supports: * (any chars), ? (single char)
   */
  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
      .replace(/\*/g, ".*") // * -> .*
      .replace(/\?/g, "."); // ? -> .
    return new RegExp(`^${escaped}$`);
  }

  async stats(): Promise<CacheStats> {
    return { type: "memory", size: this.cache.size, maxSize: this.maxSize };
  }

  dump(): Record<string, unknown> {
    const now = Date.now();
    const result: Record<string, unknown> = {};
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) continue;
      result[key] = entry.value;
    }
    return result;
  }
}
