/**
 * React Native Hooks for Policy Client
 *
 * These hooks provide React Native-specific functionality including AsyncStorage caching
 *
 * Usage:
 * import { usePolicyClient, useAuthorization, usePermissions } from './react-native-policy-hooks';
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Enhanced Policy Client for React Native with persistent caching
 */
class ReactNativePolicyClient {
  constructor(PolicyClientClass, baseUrl, options = {}) {
    if (!PolicyClientClass) {
      throw new Error("PolicyClient class is required as first parameter");
    }

    this.client = new PolicyClientClass(baseUrl, {
      ...options,
      timeout: options.timeout || 10000, // Longer timeout for mobile
    });

    this.storageKey = options.storageKey || "policy_cache";
    this.enableOfflineCache = options.enableOfflineCache !== false;
    this.onTokenExpired = options.onTokenExpired || null;
    this.persistentCache = new Map();

    // Load cache from storage on initialization
    this.loadCacheFromStorage();
  }

  async evaluate(token, resource, action, context = {}) {
    try {
      const result = await this.client.evaluate(
        token,
        resource,
        action,
        context
      );

      // Handle token expiration
      if (result.reason === "INVALID_TOKEN" && this.onTokenExpired) {
        this.onTokenExpired();
      }

      // Cache successful results persistently
      if (result.success && this.enableOfflineCache) {
        const cacheKey = this.getCacheKey(token, resource, action, context);
        this.persistentCache.set(cacheKey, {
          result,
          timestamp: Date.now(),
        });
        this.saveCacheToStorage();
      }

      return result;
    } catch (error) {
      // Try to return cached result if available
      const cacheKey = this.getCacheKey(token, resource, action, context);
      if (this.persistentCache.has(cacheKey)) {
        const cached = this.persistentCache.get(cacheKey);
        return {
          ...cached.result,
          cached: true,
          error: "Using cached result due to network error",
        };
      }

      throw error;
    }
  }

  async evaluateBatch(requests) {
    return this.client.evaluateBatch(requests);
  }

  async getPermissions(token, resource) {
    return this.client.getPermissions(token, resource);
  }

  async check(token, resource, action, context = {}) {
    return this.client.check(token, resource, action, context);
  }

  async preloadPermissions(token, resources) {
    const results = {};

    try {
      for (const resource of resources) {
        const result = await this.client.getPermissions(token, resource);
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

  clearCache() {
    this.client.clearCache();
    this.persistentCache.clear();
    if (this.enableOfflineCache) {
      AsyncStorage.removeItem(this.storageKey);
    }
  }

  getCacheStats() {
    return {
      ...this.client.getCacheStats(),
      persistentSize: this.persistentCache.size,
      offlineEnabled: this.enableOfflineCache,
    };
  }

  getCacheKey(token, resource, action, context) {
    return this.client.getCacheKey(token, resource, action, context);
  }

  async loadCacheFromStorage() {
    if (!this.enableOfflineCache) return;

    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        const cacheData = JSON.parse(stored);
        const now = Date.now();
        const cacheTimeout = 600000; // 10 minutes

        // Only load non-expired cache entries
        for (const [key, value] of Object.entries(cacheData)) {
          if (now - value.timestamp < cacheTimeout) {
            this.persistentCache.set(key, value);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to load cache from storage:", error);
    }
  }

  async saveCacheToStorage() {
    if (!this.enableOfflineCache) return;

    try {
      const cacheData = Object.fromEntries(this.persistentCache);
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(cacheData));
    } catch (error) {
      console.warn("Failed to save cache to storage:", error);
    }
  }
}

/**
 * Hook to create and manage a React Native policy client instance
 * @param {Function} PolicyClientClass - The PolicyClient class (import separately)
 * @param {string} baseUrl - Base URL for the policy service
 * @param {Object} options - Client options
 */
export function usePolicyClient(PolicyClientClass, baseUrl, options = {}) {
  return useMemo(() => {
    return new ReactNativePolicyClient(PolicyClientClass, baseUrl, options);
  }, [PolicyClientClass, baseUrl, JSON.stringify(options)]);
}

/**
 * Hook for authorization checks with offline support
 */
export function useAuthorization(
  policyClient,
  token,
  resource,
  action,
  context = {}
) {
  const [state, setState] = useState({
    loading: true,
    authorized: false,
    error: null,
    cached: false,
    data: null,
  });

  useEffect(() => {
    if (!policyClient || !token || !resource || !action) {
      setState({
        loading: false,
        authorized: false,
        error: !token ? "No token provided" : "Missing required parameters",
        cached: false,
        data: null,
      });
      return;
    }

    let cancelled = false;

    const checkAuthorization = async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const result = await policyClient.evaluate(
          token,
          resource,
          action,
          context
        );

        if (!cancelled) {
          setState({
            loading: false,
            authorized: result.success,
            error: result.error || null,
            cached: result.cached || false,
            data: result,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            authorized: false,
            error: error.message,
            cached: false,
            data: null,
          });
        }
      }
    };

    checkAuthorization();

    return () => {
      cancelled = true;
    };
  }, [policyClient, token, resource, action, JSON.stringify(context)]);

  const recheck = useCallback(() => {
    if (policyClient && token && resource && action) {
      setState((prev) => ({ ...prev, loading: true }));
    }
  }, [policyClient, token, resource, action]);

  return { ...state, recheck };
}

/**
 * Hook for getting resource permissions
 */
export function usePermissions(policyClient, token, resource) {
  const [state, setState] = useState({
    loading: true,
    permissions: [],
    error: null,
    data: null,
  });

  useEffect(() => {
    if (!policyClient || !token || !resource) {
      setState({
        loading: false,
        permissions: [],
        error: !token ? "No token provided" : "Missing required parameters",
        data: null,
      });
      return;
    }

    let cancelled = false;

    const fetchPermissions = async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const result = await policyClient.getPermissions(token, resource);

        if (!cancelled) {
          setState({
            loading: false,
            permissions: result.success ? result.permissions || [] : [],
            error: result.error || null,
            data: result,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            permissions: [],
            error: error.message,
            data: null,
          });
        }
      }
    };

    fetchPermissions();

    return () => {
      cancelled = true;
    };
  }, [policyClient, token, resource]);

  const refetch = useCallback(() => {
    if (policyClient && token && resource) {
      setState((prev) => ({ ...prev, loading: true }));
    }
  }, [policyClient, token, resource]);

  return { ...state, refetch };
}

/**
 * Hook for preloading permissions for offline use
 */
export function usePreloadPermissions(policyClient, token, resources) {
  const [state, setState] = useState({
    loading: false,
    results: {},
    error: null,
    preloaded: false,
  });

  const preload = useCallback(async () => {
    if (!policyClient || !token || !resources || resources.length === 0) {
      setState({
        loading: false,
        results: {},
        error: "Missing required parameters",
        preloaded: false,
      });
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await policyClient.preloadPermissions(token, resources);
      setState({
        loading: false,
        results: result.results,
        error: result.error || null,
        preloaded: result.success,
      });
    } catch (error) {
      setState({
        loading: false,
        results: {},
        error: error.message,
        preloaded: false,
      });
    }
  }, [policyClient, token, JSON.stringify(resources)]);

  return { ...state, preload };
}

/**
 * Hook for offline-first authorization
 */
export function useOfflineAuthorization(
  policyClient,
  token,
  resource,
  action,
  context = {}
) {
  const { loading, authorized, error, cached, data, recheck } =
    useAuthorization(policyClient, token, resource, action, context);

  const [networkStatus, setNetworkStatus] = useState("online");

  useEffect(() => {
    // Monitor network status (React Native specific)
    let netInfoUnsubscribe;

    const setupNetworkMonitoring = async () => {
      try {
        // Try to use NetInfo if available
        const NetInfo = require("@react-native-netinfo/netinfo");
        netInfoUnsubscribe = NetInfo.addEventListener((state) => {
          setNetworkStatus(state.isConnected ? "online" : "offline");
        });

        // Get initial state
        const state = await NetInfo.fetch();
        setNetworkStatus(state.isConnected ? "online" : "offline");
      } catch (error) {
        // Fallback: assume online if NetInfo is not available
        console.warn("NetInfo not available, assuming online status");
        setNetworkStatus("online");
      }
    };

    setupNetworkMonitoring();

    return () => {
      if (netInfoUnsubscribe) {
        netInfoUnsubscribe();
      }
    };
  }, []);

  return {
    loading,
    authorized,
    error,
    cached,
    data,
    networkStatus,
    isOffline: networkStatus === "offline",
    recheck,
  };
}

/**
 * Hook for batch authorization with retry logic
 */
export function useBatchAuthorization(policyClient, requests, options = {}) {
  const { retryAttempts = 3, retryDelay = 1000 } = options;

  const [state, setState] = useState({
    loading: true,
    results: [],
    error: null,
    attempt: 0,
  });

  useEffect(() => {
    if (!policyClient || !requests || requests.length === 0) {
      setState({
        loading: false,
        results: [],
        error: !requests ? "No requests provided" : null,
        attempt: 0,
      });
      return;
    }

    let cancelled = false;
    let currentAttempt = 0;

    const checkBatchWithRetry = async () => {
      while (currentAttempt < retryAttempts && !cancelled) {
        try {
          setState((prev) => ({
            ...prev,
            loading: true,
            error: null,
            attempt: currentAttempt + 1,
          }));

          const results = await policyClient.evaluateBatch(requests);

          if (!cancelled) {
            setState({
              loading: false,
              results,
              error: null,
              attempt: currentAttempt + 1,
            });
            return;
          }
        } catch (error) {
          currentAttempt++;

          if (currentAttempt >= retryAttempts) {
            if (!cancelled) {
              setState({
                loading: false,
                results: [],
                error: error.message,
                attempt: currentAttempt,
              });
            }
          } else {
            // Wait before retry
            await new Promise((resolve) =>
              setTimeout(resolve, retryDelay * currentAttempt)
            );
          }
        }
      }
    };

    checkBatchWithRetry();

    return () => {
      cancelled = true;
    };
  }, [policyClient, JSON.stringify(requests), retryAttempts, retryDelay]);

  return state;
}
