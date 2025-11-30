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
        // Detect Azure Redis Cache and SSL requirements
        let redisUrl = process.env.REDIS_URL;
        const isAzureRedis = redisUrl.includes("cache.windows.net");
        const isSSLPort = redisUrl.includes(":6380");
        const usesRedissProtocol = redisUrl.startsWith("rediss://");
        const requiresTLS = isAzureRedis || isSSLPort || usesRedissProtocol;

        // If URL has embedded credentials, ensure password is properly URL-encoded
        if (redisUrl.includes("@")) {
          try {
            // Parse URL to extract and re-encode password if needed
            const urlMatch = redisUrl.match(
              /^(rediss?:\/\/)([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?(\/.*)?$/
            );
            if (urlMatch) {
              const [, protocol, username, password, host, port, path] =
                urlMatch;
              // Decode password to get original, then re-encode to ensure proper encoding
              const decodedPassword = decodeURIComponent(password);
              const encodedPassword = encodeURIComponent(decodedPassword);
              const portPart = port ? `:${port}` : "";
              const pathPart = path || "/0";
              redisUrl = `${protocol}${username}:${encodedPassword}@${host}${portPart}${pathPart}`;
            }
          } catch (error) {
            // If parsing fails, use URL as-is (may already be properly encoded)
            console.warn(
              "Redis PolicyCache: Could not parse REDIS_URL, using as-is"
            );
          }
        } else if (
          // For Azure Redis Cache, if username/password are provided separately and URL doesn't have credentials,
          // construct the URL with username:password (URL-encode password to handle special characters)
          isAzureRedis &&
          process.env.REDIS_USERNAME &&
          process.env.REDIS_PASSWORD
        ) {
          const protocol = requiresTLS ? "rediss://" : "redis://";
          const urlMatch = redisUrl.match(
            /^(?:rediss?:\/\/)?([^:\/]+)(?::(\d+))?/
          );
          if (urlMatch) {
            const host = urlMatch[1];
            const port = urlMatch[2] || (requiresTLS ? "6380" : "6379");
            // URL-encode password to handle special characters like =, @, :, /, etc.
            const encodedPassword = encodeURIComponent(
              process.env.REDIS_PASSWORD
            );
            redisUrl = `${protocol}${process.env.REDIS_USERNAME}:${encodedPassword}@${host}:${port}`;
          }
        }

        // Build socket config - only set TLS if URL uses redis:// but needs TLS
        // If URL uses rediss://, TLS is already indicated by protocol
        const socketConfig = {
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
          connectTimeout: 2000, // Reduced from 10s to 2s for faster failure
          keepAlive: 30000, // Keep connection alive
        };

        // Only set TLS option if URL uses redis:// but requires TLS (e.g., port 6380)
        // If URL uses rediss://, protocol already indicates TLS, don't set tls option
        if (requiresTLS && !usesRedissProtocol) {
          socketConfig.tls = {}; // Enable TLS encryption for redis:// URLs that need it
        }

        config = {
          url: redisUrl,
          socket: socketConfig,
          pingInterval: 60000, // Ping every 60 seconds
        };
      } else {
        // Fallback to individual config options
        const redisPort = parseInt(process.env.REDIS_PORT) || 6379;
        const isSSLPort = redisPort === 6380;
        const isAzureRedis = (process.env.REDIS_HOST || "").includes(
          "cache.windows.net"
        );
        const requiresTLS = isAzureRedis || isSSLPort;

        config = {
          host: process.env.REDIS_HOST || "localhost",
          port: redisPort,
          db: parseInt(process.env.REDIS_DB) || 0,
          socket: {
            tls: requiresTLS ? {} : undefined, // Enable TLS encryption for Azure Redis Cache (port 6380)
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
            connectTimeout: 2000, // Reduced from 10s to 2s for faster failure
            keepAlive: 30000,
          },
          pingInterval: 60000,
        };

        // Add username for Azure Redis Cache (usually the cache name or "default")
        if (isAzureRedis && process.env.REDIS_USERNAME) {
          config.username = process.env.REDIS_USERNAME;
        }

        // Add password if it exists
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
    // Wait for initialization with timeout (max 500ms)
    if (!this.initialized && this.initializing) {
      const startTime = Date.now();
      const maxWait = 500; // Max 500ms wait for initialization
      while (this.initializing && Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // If still initializing after timeout, skip Redis
      if (this.initializing) {
        console.warn("PolicyCache: Initialization timeout, using local cache");
        return this.getFromLocalCache(key);
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

      // Try Redis first with timeout (500ms max)
      const cached = await Promise.race([
        this.redis.get(this.prefix + key),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redis get timeout")), 500)
        ),
      ]);

      if (cached) {
        const result = JSON.parse(cached);
        // Also store in local cache for faster access
        this.setLocalCache(key, result);
        return result;
      }

      // Fallback to local cache
      return this.getFromLocalCache(key);
    } catch (error) {
      // On timeout or error, disable Redis temporarily and use local cache
      if (error.message === "Redis get timeout" || !this.redis?.isOpen) {
        console.warn("PolicyCache: Redis unavailable, using local cache");
        this.enabled = false;
        // Re-enable after 30 seconds
        setTimeout(() => {
          this.enabled = process.env.REDIS_ENABLED !== "false";
        }, 30000);
      } else {
        console.error("Redis get error:", error);
      }
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
    // Always store in local cache first (fast)
    this.setLocalCache(key, value);

    // Wait for initialization with timeout (max 200ms)
    if (!this.initialized && this.initializing) {
      const startTime = Date.now();
      const maxWait = 200; // Max 200ms wait for initialization
      while (this.initializing && Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // If still initializing after timeout, skip Redis
      if (this.initializing) {
        return; // Already stored in local cache
      }
    }

    if (!this.enabled || !this.redis) {
      return;
    }

    try {
      // Check again inside try block to handle race conditions
      if (!this.redis) {
        return;
      }

      // Store in Redis with timeout (300ms max) - fire and forget
      Promise.race([
        this.redis.setEx(this.prefix + key, ttl, JSON.stringify(value)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redis set timeout")), 300)
        ),
      ]).catch((error) => {
        // Silently fail - already stored in local cache
        if (error.message === "Redis set timeout" || !this.redis?.isOpen) {
          this.enabled = false;
          // Re-enable after 30 seconds
          setTimeout(() => {
            this.enabled = process.env.REDIS_ENABLED !== "false";
          }, 30000);
        }
      });
    } catch (error) {
      // Silently fail - already stored in local cache
      if (error.message === "Redis set timeout" || !this.redis?.isOpen) {
        this.enabled = false;
        setTimeout(() => {
          this.enabled = process.env.REDIS_ENABLED !== "false";
        }, 30000);
      }
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
