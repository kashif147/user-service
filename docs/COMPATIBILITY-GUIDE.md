# Policy Client Compatibility Guide

## Overview

The Policy Client SDKs are designed to be fully compatible across different environments and frameworks. This guide ensures you can use them confidently in any setup.

## ✅ Supported Environments

### Node.js Compatibility

- **Node.js 14+**: Full support with HTTP/HTTPS fallback
- **Node.js 18+**: Full support with native `fetch()`
- **Express.js**: Built-in middleware support
- **Microservices**: Service-to-service communication
- **Docker**: Container-ready with health checks

### React Compatibility

- **React 16.8+**: Hooks support required
- **React 17+**: Full compatibility
- **React 18+**: Concurrent features supported
- **Next.js**: SSR/SSG compatible
- **Create React App**: Zero configuration
- **Vite**: Modern bundler support

### React Native Compatibility

- **React Native 0.60+**: Auto-linking support
- **Expo SDK 40+**: Managed workflow
- **Metro Bundler**: Default bundler
- **AsyncStorage**: Offline caching
- **NetInfo**: Network status monitoring

## 🔧 Installation & Setup

### Node.js / Express

```bash
npm install @react-native-async-storage/async-storage # Only for React Native features
```

```javascript
// server.js
const PolicyClient = require("./sdks/node-policy-client");

const client = new PolicyClient("http://user-service:3000", {
  timeout: 5000,
  retries: 3,
  cacheTimeout: 300000, // 5 minutes
});

// Express middleware
app.use("/api/protected", client.middleware("resource", "action"));
```

### React Application

```bash
npm install react react-dom
```

```javascript
// App.js
import React from "react";
import PolicyClient from "./sdks/node-policy-client";
import { usePolicyClient, useAuthorization } from "./sdks/react-policy-hooks";

function App() {
  const client = usePolicyClient(PolicyClient, "http://user-service:3000");
  const token = localStorage.getItem("authToken");

  const { loading, authorized } = useAuthorization(
    client,
    token,
    "user",
    "read"
  );

  if (loading) return <div>Loading...</div>;
  return authorized ? <UserDashboard /> : <Login />;
}
```

### React Native Application

```bash
npm install react-native @react-native-async-storage/async-storage
npm install @react-native-netinfo/netinfo # Optional for network monitoring
```

```javascript
// App.js
import React from "react";
import { View, Text } from "react-native";
import PolicyClient from "./sdks/node-policy-client";
import {
  usePolicyClient,
  useOfflineAuthorization,
} from "./sdks/react-native-policy-hooks";

function App() {
  const client = usePolicyClient(PolicyClient, "http://user-service:3000", {
    enableOfflineCache: true,
    timeout: 10000,
  });

  const { authorized, cached, isOffline } = useOfflineAuthorization(
    client,
    token,
    "user",
    "read"
  );

  return (
    <View>
      {isOffline && <Text>Offline Mode</Text>}
      {cached && <Text>Using cached data</Text>}
      {authorized ? <UserScreen /> : <LoginScreen />}
    </View>
  );
}
```

## 🌐 Network & HTTP Compatibility

### Fetch API Support

The core client automatically detects and uses the best HTTP implementation:

```javascript
// Node.js 18+ or Browser
if (typeof fetch !== "undefined") {
  // Uses native fetch with AbortController
  const response = await fetch(url, options);
}

// Node.js < 18
else {
  // Falls back to http/https modules
  const response = await this.makeNodeRequest(url, options);
}
```

### Proxy & Corporate Networks

```javascript
// Configure for corporate environments
const client = new PolicyClient("http://user-service:3000", {
  timeout: 10000, // Longer timeout for slow networks
  retries: 5, // More retries for unreliable connections
});
```

### SSL/TLS Support

```javascript
// HTTPS endpoints work automatically
const client = new PolicyClient("https://secure-service:443");

// Custom certificates (Node.js)
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0; // Development only
```

## 📱 Platform-Specific Features

### Browser Features

```javascript
// Navigation integration
const { useNavigationMenu } = require("./sdks/react-ui-policy-hooks");

function Navigation({ capabilities }) {
  const menuItems = useNavigationMenu(capabilities);

  return (
    <nav>
      {menuItems.map((item) => (
        <a
          key={item.id}
          href={item.path}
          className={item.active ? "active" : ""}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

// Custom events
window.addEventListener("policyAction", (event) => {
  console.log("Policy action:", event.detail);
});
```

### React Native Features

```javascript
// AsyncStorage caching
const client = usePolicyClient(PolicyClient, baseUrl, {
  enableOfflineCache: true,
  storageKey: "my_app_policy_cache",
  cacheTimeout: 600000, // 10 minutes
});

// Network status monitoring
const { isOffline, networkStatus } = useOfflineAuthorization(
  client,
  token,
  "user",
  "read"
);

// Preload for offline use
const { preload } = usePreloadPermissions(client, token, [
  "user",
  "role",
  "admin",
]);

useEffect(() => {
  preload(); // Load permissions when app starts
}, []);
```

### Node.js Microservices

```javascript
// Service-to-service authentication
const client = new PolicyClient("http://user-service:3000");

app.use("/api/users", async (req, res, next) => {
  const serviceToken = process.env.SERVICE_TOKEN;
  const authorized = await client.check(serviceToken, "user", "read", {
    serviceId: "crm-service",
    requestId: req.headers["x-request-id"],
  });

  if (authorized) next();
  else res.status(403).json({ error: "Service access denied" });
});

// Health checks
app.get("/health", (req, res) => {
  const stats = client.getCacheStats();
  res.json({
    status: "healthy",
    cache: stats,
    timestamp: new Date().toISOString(),
  });
});
```

## 🔄 Module System Compatibility

### CommonJS (Node.js)

```javascript
const PolicyClient = require("./sdks/node-policy-client");
const client = new PolicyClient("http://localhost:3000");

// Multiple export formats supported
const { default: Client } = require("./sdks/node-policy-client");
const { PolicyClient: NamedClient } = require("./sdks/node-policy-client");
```

### ES Modules (Modern)

```javascript
import PolicyClient from "./sdks/node-policy-client";
import { PolicyClient as NamedImport } from "./sdks/node-policy-client";

const client = new PolicyClient("http://localhost:3000");
```

### UMD (Universal)

```html
<script src="./sdks/node-policy-client.js"></script>
<script>
  const client = new PolicyClient("http://localhost:3000");
</script>
```

## 🧪 Testing Compatibility

### Jest Configuration

```javascript
// jest.config.js
module.exports = {
  testEnvironment: "jsdom", // For React tests
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.js"],
  moduleNameMapping: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.(js|jsx)$": "babel-jest",
  },
};
```

### React Testing Library

```javascript
import { renderHook, act } from "@testing-library/react-hooks";
import { usePolicyClient, useAuthorization } from "./sdks/react-policy-hooks";
import PolicyClient from "./sdks/node-policy-client";

test("authorization hook works correctly", async () => {
  const mockClient = new PolicyClient("http://test-server");

  const { result, waitForNextUpdate } = renderHook(() =>
    useAuthorization(mockClient, "test-token", "user", "read")
  );

  expect(result.current.loading).toBe(true);

  await waitForNextUpdate();

  expect(result.current.loading).toBe(false);
  expect(result.current.authorized).toBe(true);
});
```

### React Native Testing

```javascript
import { render } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Mock AsyncStorage
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

// Mock NetInfo
jest.mock("@react-native-netinfo/netinfo", () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn(() => Promise.resolve({ isConnected: true })),
}));
```

## 🚀 Performance Optimization

### Caching Strategy

```javascript
// Configure caching for your environment
const client = new PolicyClient("http://user-service:3000", {
  // Memory cache timeout
  cacheTimeout: 300000, // 5 minutes for web
  cacheTimeout: 600000, // 10 minutes for mobile (longer for offline)
});

// Clear cache when needed
client.clearCache(); // Manual cleanup
```

### Batch Operations

```javascript
// Batch multiple permission checks
const requests = [
  { token, resource: "user", action: "read" },
  { token, resource: "user", action: "write" },
  { token, resource: "role", action: "read" },
];

const results = await client.evaluateBatch(requests);
// Single network request instead of 3
```

### React Optimization

```javascript
// Memoize client instance
const client = useMemo(
  () => new PolicyClient(baseUrl, options),
  [baseUrl, options]
);

// Batch UI permissions
const { capabilities } = useUIInitialization(PolicyClient, baseUrl, token);
// Single hook call loads all UI permissions
```

## 🔧 Troubleshooting

### Common Issues

#### 1. "fetch is not defined" (Node.js < 18)

**Solution**: The client automatically falls back to Node.js HTTP modules.

```javascript
// No action needed - automatic fallback
const client = new PolicyClient("http://localhost:3000");
```

#### 2. "require is not defined" (Browser/React)

**Solution**: Use explicit imports and pass PolicyClient as parameter.

```javascript
// ❌ Wrong
const client = usePolicyClient("http://localhost:3000");

// ✅ Correct
import PolicyClient from "./sdks/node-policy-client";
const client = usePolicyClient(PolicyClient, "http://localhost:3000");
```

#### 3. "AsyncStorage is not defined" (React Native)

**Solution**: Install the AsyncStorage package.

```bash
npm install @react-native-async-storage/async-storage
```

#### 4. "window is not defined" (React Native)

**Solution**: The hooks handle this automatically with platform detection.

```javascript
// Works in both React and React Native
const menuItems = useNavigationMenu(capabilities);
```

#### 5. Network requests fail in development

**Solution**: Configure CORS and proxy settings.

```javascript
// React (package.json)
{
  "proxy": "http://localhost:3000"
}

// Next.js (next.config.js)
module.exports = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*'
      }
    ];
  }
};
```

### Debugging

#### Enable Debug Logging

```javascript
// Add to client options
const client = new PolicyClient("http://localhost:3000", {
  debug: true, // Logs all requests/responses
});
```

#### Check Cache Stats

```javascript
// Monitor cache performance
const stats = client.getCacheStats();
console.log("Cache size:", stats.size);
console.log("Cache timeout:", stats.timeout);
```

#### Network Monitoring

```javascript
// React Native network status
const { networkStatus, isOffline } = useOfflineAuthorization(
  client,
  token,
  "user",
  "read"
);

console.log("Network:", networkStatus);
console.log("Offline mode:", isOffline);
```

## 📋 Compatibility Checklist

### Before Deployment

- [ ] Test in target Node.js version (14+)
- [ ] Test in target React version (16.8+)
- [ ] Test in target React Native version (0.60+)
- [ ] Verify network connectivity handling
- [ ] Test offline functionality (React Native)
- [ ] Verify caching behavior
- [ ] Test error handling and fallbacks
- [ ] Check bundle size impact
- [ ] Verify TypeScript compatibility (if used)
- [ ] Test in production-like environment

### Runtime Checks

```javascript
// Environment detection
const isNode = typeof process !== "undefined" && process.versions?.node;
const isBrowser = typeof window !== "undefined";
const isReactNative =
  typeof navigator !== "undefined" && navigator.product === "ReactNative";

// Feature detection
const hasFetch = typeof fetch !== "undefined";
const hasAsyncStorage = typeof AsyncStorage !== "undefined";
const hasNetInfo = (() => {
  try {
    require("@react-native-netinfo/netinfo");
    return true;
  } catch {
    return false;
  }
})();

console.log("Environment:", { isNode, isBrowser, isReactNative });
console.log("Features:", { hasFetch, hasAsyncStorage, hasNetInfo });
```

## 🔮 Future Compatibility

### Planned Support

- **TypeScript**: Full type definitions
- **React Query**: Optional integration
- **GraphQL**: Alternative transport layer
- **WebSockets**: Real-time updates
- **Service Workers**: Enhanced offline support

### Migration Path

The SDK is designed for forward compatibility. Future versions will:

1. Maintain backward compatibility for at least 2 major versions
2. Provide clear migration guides
3. Support gradual adoption of new features
4. Offer automated migration tools

Stay updated with the latest compatibility information in our [release notes](./CHANGELOG.md).
