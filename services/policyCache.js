const Redis = require("redis");

/**
 * Redis-based caching layer for Policy Evaluation Service
 * Provides high-performance caching for authorization decisions
 */

class PolicyCache {
  constructor(options = {}) {
    this.redis = null;
    this.enabled = options.enabled !== false;
    this.initialized = false;
    this.initializing = false;
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
    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    if (this.initializing) {
      // Wait for ongoing initialization
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.initializing = true;

    try {
      let config;

      // Use REDIS_URL if provided (similar to RABBITMQ_URL)
      if (process.env.REDIS_URL) {
        config = {
          url: process.env.REDIS_URL,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error(
                  "Redis PolicyCache: Max reconnection attempts reached"
                );
                return false;
              }
              const delay = Math.min(retries * 1000, 30000);
              console.log(
                `Redis PolicyCache: Reconnecting in ${delay}ms (attempt ${retries})`
              );
              return delay;
            },
            connectTimeout: 10000,
            keepAlive: 30000, // Keep connection alive
          },
          pingInterval: 60000, // Ping every 60 seconds
        };
      } else {
        // Fallback to individual config options
        config = {
          host: process.env.REDIS_HOST || "localhost",
          port: process.env.REDIS_PORT || 6379,
          db: process.env.REDIS_DB || 0,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 10) {
                console.error(
                  "Redis PolicyCache: Max reconnection attempts reached"
                );
                return false;
              }
              const delay = Math.min(retries * 1000, 30000);
              console.log(
                `Redis PolicyCache: Reconnecting in ${delay}ms (attempt ${retries})`
              );
              return delay;
            },
            connectTimeout: 10000,
            keepAlive: 30000,
          },
          pingInterval: 60000,
        };

        // Only add password if it exists
        if (process.env.REDIS_PASSWORD) {
          config.password = process.env.REDIS_PASSWORD;
        }
      }

      this.redis = Redis.createClient(config);

      this.redis.on("error", (err) => {
        // Don't disable Redis on connection reset - it will reconnect
        if (err.code === "ECONNRESET") {
          console.warn("Redis PolicyCache: Connection reset - will reconnect");
        } else {
          console.error("Redis PolicyCache connection error:", err.message);
        }
        // Don't disable on temporary errors
        if (!["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(err.code)) {
          this.enabled = false; // Only disable on persistent errors
        }
      });

      this.redis.on("connect", () => {
        console.log("Redis PolicyCache connected");
        this.enabled = true; // Re-enable when connected
      });

      this.redis.on("ready", () => {
        console.log("Redis PolicyCache ready");
        this.enabled = true;
      });

      this.redis.on("reconnecting", () => {
        console.log("Redis PolicyCache reconnecting...");
      });

      this.redis.on("end", () => {
        console.warn("Redis PolicyCache connection ended - will reconnect");
        // Don't set redis to null, let reconnectStrategy handle it
      });

      this.redis.on("close", () => {
        console.warn("Redis PolicyCache connection closed");
        // Don't set redis to null, let reconnectStrategy handle it
      });

      await this.redis.connect();
      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize Redis PolicyCache:", error.message);
      // Don't permanently disable - allow retry
      this.enabled = false;
      this.redis = null;
      this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Get cached policy decision
   * @param {string} key - Cache key
   * @returns {Promise<Object|null>} Cached result or null
   */
  async get(key) {
    // Wait for initialization if not complete
    if (!this.initialized && this.initializing) {
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    if (!this.enabled || !this.redis) {
      return this.getFromLocalCache(key);
    }

    try {
      // Check again inside try block to handle race conditions
      if (!this.redis) {
        return this.getFromLocalCache(key);
      }

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
    // Wait for initialization if not complete
    if (!this.initialized && this.initializing) {
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    if (!this.enabled || !this.redis) {
      this.setLocalCache(key, value);
      return;
    }

    try {
      // Check again inside try block to handle race conditions
      if (!this.redis) {
        this.setLocalCache(key, value);
        return;
      }

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
    if (!this.enabled || !this.redis) {
      this.localCache.delete(key);
      return;
    }

    try {
      // Check again inside try block to handle race conditions
      if (!this.redis) {
        this.localCache.delete(key);
        return;
      }

      await this.redis.del(this.prefix + key);
      this.localCache.delete(key);
    } catch (error) {
      console.error("Redis delete error:", error);
      this.localCache.delete(key);
    }
  }

  /**
   * Alias for delete method
   * @param {string} key - Cache key
   */
  async del(key) {
    return this.delete(key);
  }

  /**
   * Clear all cached policy decisions
   */
  async clear() {
    if (!this.enabled || !this.redis) {
      this.localCache.clear();
      return;
    }

    try {
      // Check again inside try block to handle race conditions
      if (!this.redis) {
        this.localCache.clear();
        return;
      }

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
   * Generate cache key for policy evaluation with tenant isolation
   * @param {string} tokenHash - Hashed token
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @param {Object} context - Additional context (must include tenantId)
   * @returns {string} Cache key
   */
  generateKey(tokenHash, resource, action, context = {}) {
    const tenantId = context.tenantId || "default";
    const contextStr = JSON.stringify(context);
    return `${tenantId}:${tokenHash}:${resource}:${action}:${this.hashString(
      contextStr
    )}`;
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
