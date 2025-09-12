/**
 * React Native SDK for Centralized RBAC Policy Evaluation
 *
 * Usage in React Native applications:
 * import PolicyClient from './policy-client';
 * const policy = new PolicyClient('http://user-service:3000');
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

class PolicyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = options.timeout || 10000; // Longer timeout for mobile
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 600000; // 10 minutes for mobile
    this.onTokenExpired = options.onTokenExpired || null;
    this.storageKey = options.storageKey || "policy_cache";
    this.enableOfflineCache = options.enableOfflineCache !== false;

    // Load cache from storage on initialization
    this.loadCacheFromStorage();
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, resource, action, context }),
      });

      // Handle token expiration
      if (response.reason === "INVALID_TOKEN" && this.onTokenExpired) {
        this.onTokenExpired();
      }

      // Cache successful results
      if (response.success) {
        this.cache.set(cacheKey, {
          result: response,
          timestamp: Date.now(),
        });

        // Save to persistent storage
        if (this.enableOfflineCache) {
          this.saveCacheToStorage();
        }
      }

      return response;
    } catch (error) {
      // Try to return cached result if available
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        return {
          ...cached.result,
          cached: true,
          error: "Using cached result due to network error",
        };
      }

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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
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
          headers: {
            Authorization: `Bearer ${token}`,
          },
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
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * Preload permissions for offline use
   * @param {string} token - JWT token
   * @param {Array} resources - Array of resource names
   * @returns {Promise<Object>} Preload result
   */
  async preloadPermissions(token, resources) {
    const results = {};

    try {
      for (const resource of resources) {
        const result = await this.getPermissions(token, resource);
        results[resource] = result;
      }

      return {
        success: true,
        results,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        results,
      };
    }
  }

  /**
   * React Native Hook for authorization
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @param {string} action - Action name
   * @param {Object} context - Additional context
   * @returns {Object} Authorization state
   */
  useAuthorization(token, resource, action, context = {}) {
    const [loading, setLoading] = React.useState(true);
    const [authorized, setAuthorized] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [cached, setCached] = React.useState(false);

    React.useEffect(() => {
      if (!token || !resource || !action) {
        setLoading(false);
        return;
      }

      this.evaluate(token, resource, action, context)
        .then((result) => {
          setAuthorized(result.success);
          setError(result.error || null);
          setCached(result.cached || false);
        })
        .catch((err) => {
          setAuthorized(false);
          setError(err.message);
        })
        .finally(() => {
          setLoading(false);
        });
    }, [token, resource, action, JSON.stringify(context)]);

    return { loading, authorized, error, cached };
  }

  /**
   * React Native Hook for permissions
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @returns {Object} Permissions state
   */
  usePermissions(token, resource) {
    const [loading, setLoading] = React.useState(true);
    const [permissions, setPermissions] = React.useState([]);
    const [error, setError] = React.useState(null);

    React.useEffect(() => {
      if (!token || !resource) {
        setLoading(false);
        return;
      }

      this.getPermissions(token, resource)
        .then((result) => {
          if (result.success) {
            setPermissions(result.permissions || []);
          } else {
            setError(result.error);
          }
        })
        .catch((err) => {
          setError(err.message);
        })
        .finally(() => {
          setLoading(false);
        });
    }, [token, resource]);

    return { loading, permissions, error };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    if (this.enableOfflineCache) {
      AsyncStorage.removeItem(this.storageKey);
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
      offlineEnabled: this.enableOfflineCache,
    };
  }

  /**
   * Load cache from persistent storage
   * @private
   */
  async loadCacheFromStorage() {
    if (!this.enableOfflineCache) return;

    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        const cacheData = JSON.parse(stored);
        const now = Date.now();

        // Only load non-expired cache entries
        for (const [key, value] of Object.entries(cacheData)) {
          if (now - value.timestamp < this.cacheTimeout) {
            this.cache.set(key, value);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to load cache from storage:", error);
    }
  }

  /**
   * Save cache to persistent storage
   * @private
   */
  async saveCacheToStorage() {
    if (!this.enableOfflineCache) return;

    try {
      const cacheData = Object.fromEntries(this.cache);
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(cacheData));
    } catch (error) {
      console.warn("Failed to save cache to storage:", error);
    }
  }

  /**
   * Make HTTP request with retry logic
   * @private
   */
  async makeRequest(endpoint, options) {
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
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
}

export default PolicyClient;
