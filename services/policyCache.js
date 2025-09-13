const Redis = require("redis");

/**
 * Redis-based caching layer for Policy Evaluation Service
 * Provides high-performance caching for authorization decisions
 */

class PolicyCache {
  constructor(options = {}) {
    this.redis = null;
    this.enabled = options.enabled !== false;
    this.ttl = options.ttl || 300; // 5 minutes default
    this.prefix = options.prefix || "policy:";
    this.localCache = new Map(); // Fallback local cache
    this.localCacheSize = options.localCacheSize || 1000;
    this.localCacheTimeout = options.localCacheTimeout || 60000; // 1 minute
  }

  /**
   * Initialize Redis connection
   */
  async initialize() {
    if (!this.enabled) return;

    try {
      let config;

      // Use REDIS_URL if provided (similar to RABBITMQ_URL)
      if (process.env.REDIS_URL) {
        config = {
          url: process.env.REDIS_URL,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3,
        };
      } else {
        // Fallback to individual config options
        config = {
          host: process.env.REDIS_HOST || "localhost",
          port: process.env.REDIS_PORT || 6379,
          db: process.env.REDIS_DB || 0,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3,
        };

        // Only add password if it exists
        if (process.env.REDIS_PASSWORD) {
          config.password = process.env.REDIS_PASSWORD;
        }
      }

      this.redis = Redis.createClient(config);

      this.redis.on("error", (err) => {
        console.error("Redis connection error:", err);
        this.enabled = false; // Disable Redis on error
      });

      this.redis.on("connect", () => {
        console.log("Redis connected for policy caching");
      });

      await this.redis.connect();
    } catch (error) {
      console.error("Failed to initialize Redis:", error);
      this.enabled = false;
    }
  }

  /**
   * Get cached policy decision
   * @param {string} key - Cache key
   * @returns {Promise<Object|null>} Cached result or null
   */
  async get(key) {
    if (!this.enabled) {
      return this.getFromLocalCache(key);
    }

    try {
      // Try Redis first
      const cached = await this.redis.get(this.prefix + key);
      if (cached) {
        const result = JSON.parse(cached);
        // Also store in local cache for faster access
        this.setLocalCache(key, result);
        return result;
      }

      // Fallback to local cache
      return this.getFromLocalCache(key);
    } catch (error) {
      console.error("Redis get error:", error);
      return this.getFromLocalCache(key);
    }
  }

  /**
   * Set cached policy decision
   * @param {string} key - Cache key
   * @param {Object} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  async set(key, value, ttl = this.ttl) {
    if (!this.enabled) {
      this.setLocalCache(key, value);
      return;
    }

    try {
      // Store in Redis
      await this.redis.setEx(this.prefix + key, ttl, JSON.stringify(value));

      // Also store in local cache
      this.setLocalCache(key, value);
    } catch (error) {
      console.error("Redis set error:", error);
      // Fallback to local cache
      this.setLocalCache(key, value);
    }
  }

  /**
   * Delete cached policy decision
   * @param {string} key - Cache key
   */
  async delete(key) {
    if (!this.enabled) {
      this.localCache.delete(key);
      return;
    }

    try {
      await this.redis.del(this.prefix + key);
      this.localCache.delete(key);
    } catch (error) {
      console.error("Redis delete error:", error);
      this.localCache.delete(key);
    }
  }

  /**
   * Clear all cached policy decisions
   */
  async clear() {
    if (!this.enabled) {
      this.localCache.clear();
      return;
    }

    try {
      const keys = await this.redis.keys(this.prefix + "*");
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
      this.localCache.clear();
    } catch (error) {
      console.error("Redis clear error:", error);
      this.localCache.clear();
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  async getStats() {
    const stats = {
      enabled: this.enabled,
      redisConnected: false,
      localCacheSize: this.localCache.size,
      ttl: this.ttl,
    };

    if (this.enabled && this.redis) {
      try {
        const info = await this.redis.info("memory");
        stats.redisConnected = true;
        stats.redisMemory = info;
      } catch (error) {
        stats.redisError = error.message;
      }
    }

    return stats;
  }

  /**
   * Generate cache key for policy evaluation
   * @param {string} tokenHash - Hashed token
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @param {Object} context - Additional context
   * @returns {string} Cache key
   */
  generateKey(tokenHash, resource, action, context = {}) {
    const contextStr = JSON.stringify(context);
    return `${tokenHash}:${resource}:${action}:${this.hashString(contextStr)}`;
  }

  /**
   * Hash string for cache key
   * @param {string} str - String to hash
   * @returns {string} Hash
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get from local cache
   * @private
   */
  getFromLocalCache(key) {
    const cached = this.localCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.localCacheTimeout) {
      return cached.value;
    }
    if (cached) {
      this.localCache.delete(key);
    }
    return null;
  }

  /**
   * Set in local cache
   * @private
   */
  setLocalCache(key, value) {
    // Limit local cache size
    if (this.localCache.size >= this.localCacheSize) {
      const firstKey = this.localCache.keys().next().value;
      this.localCache.delete(firstKey);
    }

    this.localCache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * Close Redis connection
   */
  async close() {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}

module.exports = PolicyCache;
