/**
 * Core Policy Client for Centralized RBAC Policy Evaluation
 * Framework-agnostic implementation that can be used across platforms
 *
 * Usage in Node.js/Express microservices:
 * const PolicyClient = require('./policy-client');
 * const policy = new PolicyClient('http://user-service:3000');
 */

class PolicyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = options.timeout || 5000;
    this.retries = options.retries || 3;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 300000; // 5 minutes
  }

  /**
   * Evaluate a single authorization request
   * @param {string} token - JWT token
   * @param {string} resource - Resource being accessed
   * @param {string} action - Action being performed
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} Policy decision
   */
  async evaluate(token, resource, action, context = {}) {
    const cacheKey = this.getCacheKey(token, resource, action, context);

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.result;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const response = await this.makeRequest("/policy/evaluate", {
        method: "POST",
        body: JSON.stringify({ token, resource, action, context }),
        headers: { "Content-Type": "application/json" },
      });

      // Cache successful results
      if (response.success) {
        this.cache.set(cacheKey, {
          result: response,
          timestamp: Date.now(),
        });
      }

      return response;
    } catch (error) {
      return {
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      };
    }
  }

  /**
   * Evaluate multiple authorization requests
   * @param {Array} requests - Array of {token, resource, action, context}
   * @returns {Promise<Array>} Array of policy decisions
   */
  async evaluateBatch(requests) {
    try {
      const response = await this.makeRequest("/policy/evaluate-batch", {
        method: "POST",
        body: JSON.stringify({ requests }),
        headers: { "Content-Type": "application/json" },
      });

      return response.results || [];
    } catch (error) {
      return requests.map(() => ({
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
        error: error.message,
      }));
    }
  }

  /**
   * Get effective permissions for a resource
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @returns {Promise<Object>} Effective permissions
   */
  async getPermissions(token, resource) {
    try {
      const response = await this.makeRequest(
        `/policy/permissions/${resource}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      return response;
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Quick authorization check
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @param {Object} context - Additional context
   * @returns {Promise<boolean>} Authorization result
   */
  async check(token, resource, action, context = {}) {
    try {
      const queryParams = new URLSearchParams(context);
      const response = await this.makeRequest(
        `/policy/check/${resource}/${action}?${queryParams}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * Middleware for Express.js applications
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @returns {Function} Express middleware
   */
  middleware(resource, action) {
    return async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).json({
            success: false,
            error: "Authorization header required",
          });
        }

        const token = authHeader.substring(7);
        const result = await this.evaluate(token, resource, action, req.query);

        if (result.success) {
          req.user = result.user;
          req.tenantId = result.user?.tenantId;
          next();
        } else {
          res.status(403).json({
            success: false,
            error: "Access denied",
            reason: result.reason,
          });
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: "Authorization check failed",
        });
      }
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
    };
  }

  /**
   * Make HTTP request with retry logic
   * @private
   */
  async makeRequest(endpoint, options) {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError;

    for (let i = 0; i < this.retries; i++) {
      try {
        // Use fetch if available (Node 18+, browsers), otherwise use http/https modules
        if (typeof fetch !== "undefined") {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.timeout);

          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          return await response.json();
        } else {
          // Fallback for Node.js environments without fetch
          return await this.makeNodeRequest(url, options);
        }
      } catch (error) {
        lastError = error;
        if (i < this.retries - 1) {
          await this.delay(1000 * Math.pow(2, i)); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  /**
   * Node.js HTTP request fallback
   * @private
   */
  async makeNodeRequest(url, options) {
    return new Promise((resolve, reject) => {
      // Dynamic import to avoid issues in browser environments
      const urlModule = require("url");
      const parsedUrl = new urlModule.URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");

      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: this.timeout,
      };

      const req = httpModule.request(requestOptions, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          } catch (error) {
            reject(new Error("Invalid JSON response"));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  }

  /**
   * Generate cache key
   * @private
   */
  getCacheKey(token, resource, action, context) {
    const tokenHash = this.hashToken(token);
    return `${tokenHash}:${resource}:${action}:${JSON.stringify(context)}`;
  }

  /**
   * Hash token for cache key (first 8 chars)
   * @private
   */
  hashToken(token) {
    return token.substring(0, 8);
  }

  /**
   * Delay utility
   * @private
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Support both CommonJS and ES modules
module.exports = PolicyClient;
module.exports.default = PolicyClient;
module.exports.PolicyClient = PolicyClient;

// For environments that support ES modules
if (typeof exports !== "undefined") {
  exports.default = PolicyClient;
  exports.PolicyClient = PolicyClient;
}
