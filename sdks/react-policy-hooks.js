/**
 * React Hooks for Policy Client
 *
 * These hooks provide React-specific functionality while using the core PolicyClient
 *
 * Usage:
 * import { usePolicyClient, useAuthorization, usePermissions } from './react-policy-hooks';
 * import PolicyClient from './node-policy-client';
 */

import { useState, useEffect, useMemo, useCallback } from "react";

/**
 * Hook to create and manage a policy client instance
 * @param {Function} PolicyClientClass - The PolicyClient class (import separately)
 * @param {string} baseUrl - Base URL for the policy service
 * @param {Object} options - Client options
 */
export function usePolicyClient(PolicyClientClass, baseUrl, options = {}) {
  return useMemo(() => {
    if (!PolicyClientClass) {
      throw new Error(
        'PolicyClient class is required. Import it separately: import PolicyClient from "./node-policy-client"'
      );
    }
    return new PolicyClientClass(baseUrl, options);
  }, [PolicyClientClass, baseUrl, JSON.stringify(options)]);
}

/**
 * Legacy hook for backwards compatibility - creates client with class auto-detection
 * @deprecated Use usePolicyClient with explicit PolicyClient class instead
 */
export function useAutoDetectPolicyClient(baseUrl, options = {}) {
  return useMemo(() => {
    // This will work in Node.js environments with require
    if (typeof require !== "undefined") {
      try {
        const PolicyClient = require("./node-policy-client");
        return new PolicyClient(baseUrl, options);
      } catch (error) {
        console.warn("Failed to auto-detect PolicyClient:", error.message);
      }
    }

    throw new Error(
      "Auto-detection failed. Please use usePolicyClient with explicit PolicyClient class import"
    );
  }, [baseUrl, JSON.stringify(options)]);
}

/**
 * Hook for authorization checks
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
    data: null,
  });

  useEffect(() => {
    if (!policyClient || !token || !resource || !action) {
      setState({
        loading: false,
        authorized: false,
        error: !token ? "No token provided" : "Missing required parameters",
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
            data: result,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            authorized: false,
            error: error.message,
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
 * Hook for batch authorization checks
 */
export function useBatchAuthorization(policyClient, requests) {
  const [state, setState] = useState({
    loading: true,
    results: [],
    error: null,
  });

  useEffect(() => {
    if (!policyClient || !requests || requests.length === 0) {
      setState({
        loading: false,
        results: [],
        error: !requests ? "No requests provided" : null,
      });
      return;
    }

    let cancelled = false;

    const checkBatch = async () => {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const results = await policyClient.evaluateBatch(requests);

        if (!cancelled) {
          setState({
            loading: false,
            results,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            results: [],
            error: error.message,
          });
        }
      }
    };

    checkBatch();

    return () => {
      cancelled = true;
    };
  }, [policyClient, JSON.stringify(requests)]);

  return state;
}

/**
 * Hook for quick authorization check (returns boolean)
 */
export function useQuickCheck(
  policyClient,
  token,
  resource,
  action,
  context = {}
) {
  const { authorized, loading, error } = useAuthorization(
    policyClient,
    token,
    resource,
    action,
    context
  );
  return { authorized, loading, error };
}

/**
 * Higher-order hook for multiple permission checks
 */
export function useMultiplePermissions(policyClient, token, permissionChecks) {
  const [state, setState] = useState({
    loading: true,
    permissions: {},
    allLoaded: false,
    error: null,
  });

  useEffect(() => {
    if (
      !policyClient ||
      !token ||
      !permissionChecks ||
      permissionChecks.length === 0
    ) {
      setState({
        loading: false,
        permissions: {},
        allLoaded: true,
        error: !token ? "No token provided" : null,
      });
      return;
    }

    let cancelled = false;
    const permissions = {};
    let completed = 0;

    const checkPermission = async (resource, action, context = {}) => {
      try {
        const result = await policyClient.evaluate(
          token,
          resource,
          action,
          context
        );
        if (!cancelled) {
          permissions[`${resource}_${action}`] = result.success;
          completed++;

          if (completed === permissionChecks.length) {
            setState({
              loading: false,
              permissions,
              allLoaded: true,
              error: null,
            });
          }
        }
      } catch (error) {
        if (!cancelled) {
          permissions[`${resource}_${action}`] = false;
          completed++;

          if (completed === permissionChecks.length) {
            setState({
              loading: false,
              permissions,
              allLoaded: true,
              error: error.message,
            });
          }
        }
      }
    };

    // Start all permission checks
    permissionChecks.forEach(({ resource, action, context }) => {
      checkPermission(resource, action, context);
    });

    return () => {
      cancelled = true;
    };
  }, [policyClient, token, JSON.stringify(permissionChecks)]);

  return state;
}
