/**
 * React/JavaScript SDK for Centralized RBAC Policy Evaluation
 *
 * Usage in React applications:
 * import PolicyClient from './policy-client';
 * const policy = new PolicyClient('http://user-service:3000');
 */

class PolicyClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = options.timeout || 5000;
    this.cache = new Map();
    this.cacheTimeout = options.cacheTimeout || 300000; // 5 minutes
    this.onTokenExpired = options.onTokenExpired || null;
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
   * React Hook for authorization
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

    React.useEffect(() => {
      if (!token || !resource || !action) {
        setLoading(false);
        return;
      }

      this.evaluate(token, resource, action, context)
        .then((result) => {
          setAuthorized(result.success);
          setError(result.error || null);
        })
        .catch((err) => {
          setAuthorized(false);
          setError(err.message);
        })
        .finally(() => {
          setLoading(false);
        });
    }, [token, resource, action, JSON.stringify(context)]);

    return { loading, authorized, error };
  }

  /**
   * React Hook for permissions
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
   * React Component for conditional rendering
   * @param {Object} props - Component props
   * @returns {React.Element|null} Rendered component or null
   */
  AuthorizedComponent({
    token,
    resource,
    action,
    context,
    children,
    fallback = null,
  }) {
    const { loading, authorized } = this.useAuthorization(
      token,
      resource,
      action,
      context
    );

    if (loading) {
      return <div>Loading...</div>;
    }

    return authorized ? children : fallback;
  }

  /**
   * React Component for permission-based rendering
   * @param {Object} props - Component props
   * @returns {React.Element|null} Rendered component or null
   */
  PermissionComponent({
    token,
    resource,
    permission,
    children,
    fallback = null,
  }) {
    const { loading, permissions } = this.usePermissions(token, resource);

    if (loading) {
      return <div>Loading...</div>;
    }

    const hasPermission =
      permissions.includes(permission) || permissions.includes("*");
    return hasPermission ? children : fallback;
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
   * Make HTTP request
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

// React hooks (if React is available)
if (typeof React !== "undefined") {
  PolicyClient.prototype.useAuthorization =
    PolicyClient.prototype.useAuthorization;
  PolicyClient.prototype.usePermissions = PolicyClient.prototype.usePermissions;
}

export default PolicyClient;
