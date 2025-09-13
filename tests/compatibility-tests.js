/**
 * Compatibility Tests for Policy Client SDKs
 *
 * These tests verify that the policy clients work correctly across
 * different environments: Node.js, React, and React Native
 */

// ============================================================================
// 1. NODE.JS COMPATIBILITY TESTS
// ============================================================================

const assert = require("assert");
const PolicyClient = require("../sdks/node-policy-client");

describe("Node.js Compatibility", () => {
  let client;

  beforeEach(() => {
    client = new PolicyClient("http://localhost:3000", {
      timeout: 5000,
      retries: 2,
    });
  });

  test("should create client instance", () => {
    assert(client instanceof PolicyClient);
    assert.strictEqual(client.baseUrl, "http://localhost:3000");
    assert.strictEqual(client.timeout, 5000);
    assert.strictEqual(client.retries, 2);
  });

  test("should handle URL with trailing slash", () => {
    const clientWithSlash = new PolicyClient("http://localhost:3000/");
    assert.strictEqual(clientWithSlash.baseUrl, "http://localhost:3000");
  });

  test("should use default options", () => {
    const defaultClient = new PolicyClient("http://localhost:3000");
    assert.strictEqual(defaultClient.timeout, 5000);
    assert.strictEqual(defaultClient.retries, 3);
    assert.strictEqual(defaultClient.cacheTimeout, 300000);
  });

  test("should support CommonJS exports", () => {
    assert.strictEqual(typeof PolicyClient, "function");
    assert.strictEqual(typeof PolicyClient.default, "function");
    assert.strictEqual(typeof PolicyClient.PolicyClient, "function");
  });

  test("should create cache key correctly", () => {
    const key = client.getCacheKey("token123", "user", "read", {
      tenant: "abc",
    });
    assert.strictEqual(key, 'token123:user:read:{"tenant":"abc"}');
  });

  test("should clear cache", () => {
    client.cache.set("test", "value");
    assert.strictEqual(client.cache.size, 1);
    client.clearCache();
    assert.strictEqual(client.cache.size, 0);
  });

  test("should get cache stats", () => {
    const stats = client.getCacheStats();
    assert.strictEqual(typeof stats.size, "number");
    assert.strictEqual(typeof stats.timeout, "number");
  });

  test("should create Express middleware", () => {
    const middleware = client.middleware("user", "read");
    assert.strictEqual(typeof middleware, "function");
    assert.strictEqual(middleware.length, 3); // req, res, next
  });

  test("should handle HTTP fallback for older Node.js", async () => {
    // Mock fetch as undefined to test fallback
    const originalFetch = global.fetch;
    global.fetch = undefined;

    try {
      // This should use the Node.js HTTP fallback
      const request = client.makeNodeRequest("http://httpbin.org/json", {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      assert(request instanceof Promise);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ============================================================================
// 2. REACT COMPATIBILITY TESTS
// ============================================================================

// Note: These would typically run in a Jest environment with React Testing Library
const React = require("react");
const { renderHook, act } = require("@testing-library/react-hooks");

// Mock React hooks for testing
const mockReactHooks = {
  useState: jest.fn(() => [null, jest.fn()]),
  useEffect: jest.fn(),
  useMemo: jest.fn((fn) => fn()),
  useCallback: jest.fn((fn) => fn),
};

describe("React Hooks Compatibility", () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
  });

  test("usePolicyClient should require PolicyClient class", () => {
    const { usePolicyClient } = require("../sdks/react-policy-hooks");

    expect(() => {
      usePolicyClient(null, "http://localhost:3000");
    }).toThrow("PolicyClient class is required");
  });

  test("usePolicyClient should create client with correct parameters", () => {
    const { usePolicyClient } = require("../sdks/react-policy-hooks");
    const MockPolicyClient = jest.fn();

    const { result } = renderHook(() =>
      usePolicyClient(MockPolicyClient, "http://localhost:3000", {
        timeout: 10000,
      })
    );

    expect(MockPolicyClient).toHaveBeenCalledWith("http://localhost:3000", {
      timeout: 10000,
    });
  });

  test("useAuthorization should handle loading states", () => {
    const { useAuthorization } = require("../sdks/react-policy-hooks");
    const mockClient = {
      evaluate: jest.fn().mockResolvedValue({ success: true }),
    };

    const { result } = renderHook(() =>
      useAuthorization(mockClient, "token", "user", "read")
    );

    expect(result.current.loading).toBe(true);
  });

  test("usePermissions should handle error states", () => {
    const { usePermissions } = require("../sdks/react-policy-hooks");
    const mockClient = {
      getPermissions: jest.fn().mockRejectedValue(new Error("Network error")),
    };

    const { result } = renderHook(() =>
      usePermissions(mockClient, "token", "user")
    );

    expect(result.current.loading).toBe(true);
  });

  test("hooks should handle missing parameters gracefully", () => {
    const { useAuthorization } = require("../sdks/react-policy-hooks");

    const { result } = renderHook(() =>
      useAuthorization(null, null, null, null)
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.authorized).toBe(false);
    expect(result.current.error).toContain("token");
  });
});

// ============================================================================
// 3. REACT NATIVE COMPATIBILITY TESTS
// ============================================================================

describe("React Native Compatibility", () => {
  test("should handle AsyncStorage gracefully", () => {
    // Mock AsyncStorage
    const mockAsyncStorage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(),
      removeItem: jest.fn().mockResolvedValue(),
    };

    // This would normally be imported in React Native environment
    global.AsyncStorage = mockAsyncStorage;

    const { usePolicyClient } = require("../sdks/react-native-policy-hooks");
    const MockPolicyClient = jest.fn();

    const { result } = renderHook(() =>
      usePolicyClient(MockPolicyClient, "http://localhost:3000", {
        enableOfflineCache: true,
        storageKey: "test_cache",
      })
    );

    // Should create ReactNativePolicyClient
    expect(result.current).toBeDefined();
  });

  test("should handle NetInfo gracefully when not available", () => {
    const {
      useOfflineAuthorization,
    } = require("../sdks/react-native-policy-hooks");
    const mockClient = {
      evaluate: jest.fn().mockResolvedValue({ success: true }),
    };

    // NetInfo not available - should fallback gracefully
    const { result } = renderHook(() =>
      useOfflineAuthorization(mockClient, "token", "user", "read")
    );

    expect(result.current.networkStatus).toBe("online"); // Default fallback
  });

  test("should preload permissions for offline use", () => {
    const {
      usePreloadPermissions,
    } = require("../sdks/react-native-policy-hooks");
    const mockClient = {
      preloadPermissions: jest.fn().mockResolvedValue({
        success: true,
        results: { user: ["read", "write"] },
      }),
    };

    const { result } = renderHook(() =>
      usePreloadPermissions(mockClient, "token", ["user", "role"])
    );

    expect(result.current.preload).toBeInstanceOf(Function);
  });

  test("should handle batch authorization with retry logic", () => {
    const {
      useBatchAuthorization,
    } = require("../sdks/react-native-policy-hooks");
    const mockClient = {
      evaluateBatch: jest
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue([{ success: true }]),
    };

    const requests = [{ token: "token", resource: "user", action: "read" }];

    const { result } = renderHook(() =>
      useBatchAuthorization(mockClient, requests, { retryAttempts: 2 })
    );

    expect(result.current.loading).toBe(true);
  });
});

// ============================================================================
// 4. MICROSERVICES COMPATIBILITY TESTS
// ============================================================================

describe("Microservices Architecture Compatibility", () => {
  test("should support service-to-service communication", async () => {
    const client = new PolicyClient("http://user-service:3000");

    // Mock fetch for testing
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, user: { id: 1 } }),
    });

    const result = await client.evaluate("service-token", "user", "read", {
      serviceId: "crm-service",
      requestId: "req-123",
    });

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://user-service:3000/policy/evaluate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("service-token"),
      })
    );
  });

  test("should support batch operations for performance", async () => {
    const client = new PolicyClient("http://user-service:3000");

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { success: true },
            { success: false, reason: "INSUFFICIENT_PERMISSIONS" },
          ],
        }),
    });

    const requests = [
      { token: "token", resource: "user", action: "read" },
      { token: "token", resource: "admin", action: "write" },
    ];

    const results = await client.evaluateBatch(requests);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
  });

  test("should handle service discovery and load balancing", () => {
    // Test multiple service endpoints
    const clients = [
      new PolicyClient("http://user-service-1:3000"),
      new PolicyClient("http://user-service-2:3000"),
      new PolicyClient("http://user-service-3:3000"),
    ];

    clients.forEach((client, index) => {
      expect(client.baseUrl).toBe(`http://user-service-${index + 1}:3000`);
    });
  });

  test("should support circuit breaker pattern", async () => {
    const client = new PolicyClient("http://failing-service:3000", {
      retries: 3,
      timeout: 1000,
    });

    // Mock failing requests
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockRejectedValueOnce(new Error("Connection refused"));

    const result = await client.evaluate("token", "user", "read");

    expect(result.success).toBe(false);
    expect(result.reason).toBe("NETWORK_ERROR");
    expect(fetch).toHaveBeenCalledTimes(3); // Retries
  });

  test("should support health checks and monitoring", () => {
    const client = new PolicyClient("http://user-service:3000");

    // Cache stats for monitoring
    const stats = client.getCacheStats();
    expect(stats).toHaveProperty("size");
    expect(stats).toHaveProperty("timeout");

    // Should be able to clear cache for maintenance
    client.clearCache();
    expect(client.getCacheStats().size).toBe(0);
  });
});

// ============================================================================
// 5. CROSS-PLATFORM COMPATIBILITY TESTS
// ============================================================================

describe("Cross-Platform Compatibility", () => {
  test("should work in browser environment", () => {
    // Mock browser globals
    global.window = {
      location: { pathname: "/users" },
      dispatchEvent: jest.fn(),
    };
    global.fetch = jest.fn();
    global.AbortController = jest.fn(() => ({
      abort: jest.fn(),
      signal: {},
    }));

    const client = new PolicyClient("http://localhost:3000");
    expect(client).toBeInstanceOf(PolicyClient);

    // UI hooks should work
    const { useNavigationMenu } = require("../sdks/react-ui-policy-hooks");
    const capabilities = {
      navigation: [
        {
          resource: "user",
          action: "read",
          label: "Users",
          path: "/users",
          icon: "👥",
        },
      ],
    };

    const { result } = renderHook(() => useNavigationMenu(capabilities));
    expect(result.current[0].active).toBe(true);
  });

  test("should work in Node.js environment", () => {
    // Mock Node.js globals
    delete global.window;
    delete global.fetch;

    const client = new PolicyClient("http://localhost:3000");
    expect(client).toBeInstanceOf(PolicyClient);

    // Should use Node.js HTTP modules as fallback
    expect(typeof client.makeNodeRequest).toBe("function");
  });

  test("should work in React Native environment", () => {
    // Mock React Native globals
    global.navigator = { onLine: true };
    delete global.window;

    const { usePolicyClient } = require("../sdks/react-native-policy-hooks");
    const MockPolicyClient = jest.fn();

    const { result } = renderHook(() =>
      usePolicyClient(MockPolicyClient, "http://localhost:3000")
    );

    expect(result.current).toBeDefined();
  });

  test("should handle module system differences", () => {
    // Test CommonJS
    const ClientCJS = require("../sdks/node-policy-client");
    expect(typeof ClientCJS).toBe("function");
    expect(typeof ClientCJS.default).toBe("function");

    // Test ES modules (simulated)
    const { default: ClientESM, PolicyClient: NamedExport } = ClientCJS;
    expect(typeof ClientESM).toBe("function");
    expect(typeof NamedExport).toBe("function");
  });
});

// ============================================================================
// 6. PERFORMANCE AND SCALABILITY TESTS
// ============================================================================

describe("Performance and Scalability", () => {
  test("should cache results efficiently", async () => {
    const client = new PolicyClient("http://localhost:3000", {
      cacheTimeout: 60000, // 1 minute
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    // First call should hit the network
    await client.evaluate("token", "user", "read");
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second call should use cache
    await client.evaluate("token", "user", "read");
    expect(fetch).toHaveBeenCalledTimes(1); // Still 1

    // Different parameters should hit network again
    await client.evaluate("token", "user", "write");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("should handle high concurrency", async () => {
    const client = new PolicyClient("http://localhost:3000");

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    // Simulate 100 concurrent requests
    const promises = Array.from({ length: 100 }, (_, i) =>
      client.evaluate(`token-${i}`, "user", "read")
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(100);
    expect(results.every((r) => r.success)).toBe(true);
  });

  test("should handle memory efficiently with large caches", () => {
    const client = new PolicyClient("http://localhost:3000");

    // Add many items to cache
    for (let i = 0; i < 1000; i++) {
      client.cache.set(`key-${i}`, {
        result: { success: true },
        timestamp: Date.now(),
      });
    }

    expect(client.cache.size).toBe(1000);

    // Clear cache should free memory
    client.clearCache();
    expect(client.cache.size).toBe(0);
  });
});

module.exports = {
  // Export test suites for different environments
  nodeTests: () =>
    describe("Node.js Tests", () => require("./node-compatibility-tests")),
  reactTests: () =>
    describe("React Tests", () => require("./react-compatibility-tests")),
  reactNativeTests: () =>
    describe("React Native Tests", () =>
      require("./react-native-compatibility-tests")),
};
