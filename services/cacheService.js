/**
 * Redis Cache Service
 *
 * Provides a unified interface for Redis caching operations
 * with fallback to in-memory cache when Redis is unavailable
 */

const redis = require("redis");

class CacheService {
  constructor() {
    this.redisClient = null;
    this.memoryCache = new Map();
    this.memoryCacheTimeout = new Map();
    this.isConnected = false;
    this.connect();
  }

  async connect() {
    try {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      this.redisClient = redis.createClient({ url: redisUrl });

      this.redisClient.on("error", (err) => {
        console.error("Redis Client Error:", err);
        this.isConnected = false;
      });

      this.redisClient.on("connect", () => {
        console.log("Redis Client Connected");
        this.isConnected = true;
      });

      this.redisClient.on("disconnect", () => {
        console.log("Redis Client Disconnected");
        this.isConnected = false;
      });

      await this.redisClient.connect();
    } catch (error) {
      console.error("Failed to connect to Redis:", error);
      this.isConnected = false;
    }
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any>} Cached value or null
   */
  async get(key) {
    try {
      if (this.isConnected && this.redisClient) {
        const value = await this.redisClient.get(key);
        return value ? JSON.parse(value) : null;
      } else {
        // Fallback to memory cache
        const cached = this.memoryCache.get(key);
        if (cached) {
          const timeout = this.memoryCacheTimeout.get(key);
          if (timeout && Date.now() > timeout) {
            this.memoryCache.delete(key);
            this.memoryCacheTimeout.delete(key);
            return null;
          }
          return cached;
        }
        return null;
      }
    } catch (error) {
      console.error("Cache get error:", error);
      return null;
    }
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} timeout - Timeout in milliseconds (default: 5 minutes)
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, timeout = 300000) {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.setEx(
          key,
          Math.floor(timeout / 1000),
          JSON.stringify(value)
        );
        return true;
      } else {
        // Fallback to memory cache
        this.memoryCache.set(key, value);
        this.memoryCacheTimeout.set(key, Date.now() + timeout);
        return true;
      }
    } catch (error) {
      console.error("Cache set error:", error);
      return false;
    }
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} Success status
   */
  async del(key) {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(key);
        return true;
      } else {
        // Fallback to memory cache
        this.memoryCache.delete(key);
        this.memoryCacheTimeout.delete(key);
        return true;
      }
    } catch (error) {
      console.error("Cache delete error:", error);
      return false;
    }
  }

  /**
   * Delete multiple keys from cache
   * @param {...string} keys - Cache keys
   * @returns {Promise<boolean>} Success status
   */
  async del(...keys) {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.del(keys);
        return true;
      } else {
        // Fallback to memory cache
        keys.forEach((key) => {
          this.memoryCache.delete(key);
          this.memoryCacheTimeout.delete(key);
        });
        return true;
      }
    } catch (error) {
      console.error("Cache delete multiple error:", error);
      return false;
    }
  }

  /**
   * Get all keys matching pattern
   * @param {string} pattern - Key pattern
   * @returns {Promise<Array>} Array of matching keys
   */
  async keys(pattern) {
    try {
      if (this.isConnected && this.redisClient) {
        return await this.redisClient.keys(pattern);
      } else {
        // Fallback to memory cache
        const regex = new RegExp(pattern.replace(/\*/g, ".*"));
        return Array.from(this.memoryCache.keys()).filter((key) =>
          regex.test(key)
        );
      }
    } catch (error) {
      console.error("Cache keys error:", error);
      return [];
    }
  }

  /**
   * Clear all cache
   * @returns {Promise<boolean>} Success status
   */
  async clear() {
    try {
      if (this.isConnected && this.redisClient) {
        await this.redisClient.flushAll();
        return true;
      } else {
        // Fallback to memory cache
        this.memoryCache.clear();
        this.memoryCacheTimeout.clear();
        return true;
      }
    } catch (error) {
      console.error("Cache clear error:", error);
      return false;
    }
  }

  /**
   * Get cache statistics
   * @returns {Promise<Object>} Cache statistics
   */
  async getStats() {
    try {
      if (this.isConnected && this.redisClient) {
        const info = await this.redisClient.info("memory");
        return {
          type: "redis",
          connected: this.isConnected,
          info: info,
        };
      } else {
        return {
          type: "memory",
          connected: false,
          size: this.memoryCache.size,
          keys: Array.from(this.memoryCache.keys()),
        };
      }
    } catch (error) {
      console.error("Cache stats error:", error);
      return {
        type: "error",
        connected: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if cache is available
   * @returns {boolean} Cache availability
   */
  isAvailable() {
    return this.isConnected || this.memoryCache.size >= 0;
  }
}

// Create singleton instance
const cacheService = new CacheService();

module.exports = cacheService;
