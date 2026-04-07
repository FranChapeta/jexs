/**
 * Cache adapter interface.
 * All cache backends implement this interface.
 */
export interface CacheAdapter {
  /**
   * Get a value from cache
   * @returns The cached value, or undefined if not found/expired
   */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /**
   * Set a value in cache
   * @param key Cache key
   * @param value Value to cache
   * @param ttl Time-to-live in seconds (0 = no expiry)
   */
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;

  /**
   * Check if a key exists in cache
   */
  has(key: string): Promise<boolean>;

  /**
   * Delete a key from cache
   */
  delete(key: string): Promise<boolean>;

  /**
   * Delete all keys matching a pattern
   * @param pattern Glob pattern (e.g., "routes:*")
   */
  deletePattern(pattern: string): Promise<number>;

  /**
   * Clear all cache entries
   */
  clear(): Promise<void>;

  /**
   * Get or set: return cached value, or compute and cache if missing
   */
  remember<T>(key: string, ttl: number, factory: () => Promise<T>): Promise<T>;

  /**
   * Close connection (for adapters that need cleanup)
   */
  close(): Promise<void>;

  /**
   * Get cache statistics
   */
  stats(): Promise<CacheStats>;
}

export interface CacheStats {
  type: string;
  size: number;
  maxSize?: number;
  bytes?: number;
  maxBytes?: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  type: "memory" | "redis" | "memcached";
  prefix?: string;
  defaultTtl?: number;

  // Redis-specific
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };

  // Memcached-specific
  memcached?: {
    servers?: string[];
  };

  // Memory-specific
  memory?: {
    maxSize?: number; // Max entries
    checkPeriod?: number; // Cleanup interval in ms
  };
}
