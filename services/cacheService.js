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
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000; // Start with 1 second
    this.isReconnecting = false;
    this.connect();
  }

  async connect() {
    if (this.isReconnecting) return; // Prevent multiple reconnection attempts
    
    try {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      
      // Detect Azure Redis Cache and SSL requirements
      const isAzureRedis = redisUrl.includes("cache.windows.net");
      const isSSLPort = redisUrl.includes(":6380") || redisUrl.startsWith("rediss://");
      const requiresTLS = isAzureRedis || isSSLPort;
      
      // Close existing connection if any
      if (this.redisClient) {
        try {
          await this.redisClient.quit();
        } catch (e) {
          // Ignore errors when closing old connection
        }
      }

      this.redisClient = redis.createClient({
        url: redisUrl,
        socket: {
          tls: requiresTLS, // Enable TLS for Azure Redis Cache (port 6380) or rediss:// URLs
          connectTimeout: 2000, // Reduced from 10s to 2s for faster failure
          keepAlive: 30000, // Send keepalive every 30 seconds
          reconnectStrategy: (retries) => {
            if (retries > this.maxReconnectAttempts) {
              console.error("Redis: Max reconnection attempts reached");
              return false; // Stop retrying
            }
            const delay = Math.min(retries * this.reconnectDelay, 30000); // Max 30 seconds
            console.log(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
            return delay;
          },
        },
        pingInterval: 60000, // Ping every 60 seconds to keep connection alive
      });

      this.redisClient.on("error", (err) => {
        // Don't log ECONNRESET errors too aggressively
        if (err.code === "ECONNRESET") {
          console.warn("Redis connection reset - will reconnect");
        } else {
          console.error("Redis Client Error:", err.message);
        }
        this.isConnected = false;
      });

      this.redisClient.on("connect", () => {
        console.log("Redis Client Connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000; // Reset delay on successful connection
      });

      this.redisClient.on("ready", () => {
        console.log("Redis Client Ready");
        this.isConnected = true;
      });

      this.redisClient.on("end", () => {
        console.log("Redis Client Connection Ended");
        this.isConnected = false;
      });

      this.redisClient.on("reconnecting", () => {
        console.log("Redis Client Reconnecting...");
        this.isReconnecting = true;
      });

      await this.redisClient.connect();
      this.isReconnecting = false;
    } catch (error) {
      console.error("Failed to connect to Redis:", error.message);
      this.isConnected = false;
      this.isReconnecting = false;
      
      // Retry connection with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        console.log(`Redis: Retrying connection in ${delay}ms`);
        setTimeout(() => {
          this.connect();
        }, delay);
      }
    }
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any>} Cached value or null
   */
  async get(key) {
    // Check memory cache first (fast path)
    const cached = this.memoryCache.get(key);
    if (cached) {
      const timeout = this.memoryCacheTimeout.get(key);
      if (timeout && Date.now() > timeout) {
        this.memoryCache.delete(key);
        this.memoryCacheTimeout.delete(key);
      } else {
        return cached;
      }
    }

    try {
      if (this.isConnected && this.redisClient) {
        // Add timeout to Redis operation (500ms max)
        const value = await Promise.race([
          this.redisClient.get(key),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Redis get timeout")), 500)
          )
        ]);
        if (value) {
          const parsed = JSON.parse(value);
          // Store in memory cache for faster access
          this.memoryCache.set(key, parsed);
          this.memoryCacheTimeout.set(key, Date.now() + 300000); // 5 min
          return parsed;
        }
        return null;
      } else {
        return null;
      }
    } catch (error) {
      // Handle connection errors gracefully
      if (error.message === "Redis get timeout" || error.code === "ECONNRESET" || error.code === "ENOTFOUND" || !this.isConnected) {
        // Mark as disconnected and try to reconnect
        this.isConnected = false;
        if (!this.isReconnecting) {
          this.connect();
        }
        return null;
      }
      console.error("Cache get error:", error.message);
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
    // Always store in memory cache first (fast)
    this.memoryCache.set(key, value);
    this.memoryCacheTimeout.set(key, Date.now() + timeout);

    try {
      if (this.isConnected && this.redisClient) {
        // Fire and forget with timeout (300ms max)
        Promise.race([
          this.redisClient.setEx(
            key,
            Math.floor(timeout / 1000),
            JSON.stringify(value)
          ),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Redis set timeout")), 300)
          )
        ]).catch((error) => {
          // Silently fail - already stored in memory cache
          if (error.message === "Redis set timeout" || error.code === "ECONNRESET" || error.code === "ENOTFOUND") {
            this.isConnected = false;
            if (!this.isReconnecting) {
              this.connect();
            }
          }
        });
        return true;
      } else {
        return true; // Already stored in memory cache
      }
    } catch (error) {
      // Silently fail - already stored in memory cache
      if (error.code === "ECONNRESET" || error.code === "ENOTFOUND" || !this.isConnected) {
        this.isConnected = false;
        if (!this.isReconnecting) {
          this.connect();
        }
      }
      return true; // Already stored in memory cache
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
