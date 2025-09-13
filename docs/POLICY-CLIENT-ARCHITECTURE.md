# Policy Client Architecture

## Overview

The policy client SDKs have been refactored to follow functional programming principles and provide better separation of concerns. This new architecture is more React-friendly and maintainable.

## Architecture Changes

### Before (Issues)

- Class methods contained React hooks (`useState`, `useEffect`)
- Tight coupling between framework logic and business logic
- Hooks could only be used inside class methods (anti-pattern)
- Hard to test and maintain

### After (Improved)

- **Core Client**: Framework-agnostic business logic
- **Platform Hooks**: Framework-specific functionality
- **Separation of Concerns**: Clear boundaries between layers
- **Better Testing**: Each layer can be tested independently

## File Structure

```
sdks/
├── node-policy-client.js           # Core framework-agnostic client
├── react-policy-hooks.js           # React-specific hooks
├── react-native-policy-hooks.js    # React Native hooks with offline support
└── react-ui-policy-hooks.js        # UI-aware hooks for complex interfaces
```

## Core Components

### 1. Core Policy Client (`node-policy-client.js`)

Framework-agnostic implementation with:

- HTTP request handling with retry logic
- Caching with TTL
- Batch operations
- Express middleware support

```javascript
const PolicyClient = require("./node-policy-client");
const client = new PolicyClient("http://user-service:3000");

// Basic usage
const result = await client.evaluate(token, "user", "read");

// Express middleware
app.get("/api/users", client.middleware("user", "read"), handler);
```

### 2. React Hooks (`react-policy-hooks.js`)

React-specific hooks that use the core client:

```javascript
import {
  usePolicyClient,
  useAuthorization,
  usePermissions,
} from "./react-policy-hooks";

function MyComponent() {
  const client = usePolicyClient("http://user-service:3000");
  const { loading, authorized, error } = useAuthorization(
    client,
    token,
    "user",
    "read"
  );

  if (loading) return <div>Loading...</div>;
  return authorized ? <UserContent /> : <AccessDenied />;
}
```

### 3. React Native Hooks (`react-native-policy-hooks.js`)

React Native hooks with offline support:

```javascript
import {
  useOfflineAuthorization,
  usePreloadPermissions,
} from "./react-native-policy-hooks";

function UserScreen() {
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
      {authorized ? <UserList /> : <AccessDenied />}
    </View>
  );
}
```

### 4. UI Policy Hooks (`react-ui-policy-hooks.js`)

Advanced hooks for building permission-aware UIs:

```javascript
import {
  useUIInitialization,
  useNavigationMenu,
  useFeatureFlags,
} from "./react-ui-policy-hooks";

function App() {
  const { capabilities, loading } = useUIInitialization(
    "http://user-service:3000",
    token
  );
  const navigationItems = useNavigationMenu(capabilities);
  const featureFlags = useFeatureFlags(capabilities);

  return (
    <div>
      <Navigation items={navigationItems} />
      {featureFlags.admin_panel && <AdminPanel />}
    </div>
  );
}
```

## Available Hooks

### Basic Hooks

- `usePolicyClient(baseUrl, options)` - Create client instance
- `useAuthorization(client, token, resource, action, context)` - Single auth check
- `usePermissions(client, token, resource)` - Get resource permissions
- `useQuickCheck(client, token, resource, action, context)` - Boolean auth check

### Advanced Hooks

- `useBatchAuthorization(client, requests)` - Multiple auth checks
- `useMultiplePermissions(client, token, permissionChecks)` - Multiple permissions
- `useOfflineAuthorization(client, token, resource, action, context)` - Offline support
- `usePreloadPermissions(client, token, resources)` - Preload for offline use

### UI Hooks

- `useUIInitialization(baseUrl, token, options)` - Complete UI setup
- `useNavigationMenu(capabilities)` - Navigation menu data
- `useActionButtons(capabilities, category)` - Action button configs
- `useFeatureFlags(capabilities)` - Feature flag object
- `useDashboardWidgets(capabilities)` - Dashboard widget configs
- `usePageAccess(capabilities, path)` - Page access check
- `useConditionalRender(capabilities, resource, action)` - Conditional components

## Migration Guide

### From Class-based to Hook-based

**Before:**

```javascript
import PolicyClient from "./react-policy-client";

class UserComponent extends React.Component {
  constructor(props) {
    super(props);
    this.client = new PolicyClient("http://user-service:3000");
  }

  render() {
    // This was problematic - hooks in class methods
    const { loading, authorized } = this.client.useAuthorization(
      this.props.token,
      "user",
      "read"
    );

    return authorized ? <UserList /> : <AccessDenied />;
  }
}
```

**After:**

```javascript
import { usePolicyClient, useAuthorization } from "./react-policy-hooks";

function UserComponent({ token }) {
  const client = usePolicyClient("http://user-service:3000");
  const { loading, authorized } = useAuthorization(
    client,
    token,
    "user",
    "read"
  );

  return authorized ? <UserList /> : <AccessDenied />;
}
```

### UI Client Migration

**Before:**

```javascript
import UIAwarePolicyClient from "./react-ui-policy-client";

function App() {
  const client = new UIAwarePolicyClient("http://user-service:3000");
  const uiState = client.useUIInitialization(token); // Problematic

  return <Dashboard capabilities={uiState.capabilities} />;
}
```

**After:**

```javascript
import { useUIInitialization } from "./react-ui-policy-hooks";

function App() {
  const { capabilities, loading } = useUIInitialization(
    "http://user-service:3000",
    token
  );

  if (loading) return <div>Loading...</div>;
  return <Dashboard capabilities={capabilities} />;
}
```

## Benefits of New Architecture

### 1. **Framework Compliance**

- Hooks follow React's rules
- No hooks inside class methods
- Proper dependency tracking

### 2. **Better Separation of Concerns**

- Core logic is framework-agnostic
- Platform-specific code is isolated
- Easier to test each layer

### 3. **Improved Developer Experience**

- More predictable behavior
- Better TypeScript support potential
- Clearer error messages

### 4. **Enhanced Functionality**

- Better caching strategies
- Offline support for React Native
- More granular permission hooks

### 5. **Maintainability**

- Single responsibility principle
- Easier to extend and modify
- Better code reuse across platforms

## Best Practices

### 1. **Hook Dependencies**

Always include all dependencies in hook dependency arrays:

```javascript
const { authorized } = useAuthorization(
  client,
  token,
  resource,
  action,
  context
);
// Hook will re-run when any of these values change
```

### 2. **Client Instance Management**

Create client instances at the top level of your component tree:

```javascript
function App() {
  const client = usePolicyClient("http://user-service:3000", {
    timeout: 5000,
    cacheTimeout: 300000,
  });

  return <Router client={client} />;
}
```

### 3. **Error Handling**

Always handle loading and error states:

```javascript
function ProtectedComponent() {
  const { loading, authorized, error } = useAuthorization(
    client,
    token,
    "user",
    "read"
  );

  if (loading) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  if (!authorized) return <AccessDenied />;

  return <Content />;
}
```

### 4. **Batch Operations**

Use batch operations for multiple permission checks:

```javascript
const permissionChecks = [
  { resource: "user", action: "read" },
  { resource: "user", action: "write" },
  { resource: "role", action: "read" },
];

const { permissions, allLoaded } = useMultiplePermissions(
  client,
  token,
  permissionChecks
);
```

### 5. **Offline Support (React Native)**

Preload permissions for offline use:

```javascript
const { preload } = usePreloadPermissions(client, token, [
  "user",
  "role",
  "admin",
]);

useEffect(() => {
  preload(); // Load permissions when app starts
}, []);
```

## Performance Considerations

### 1. **Caching**

- Core client has built-in memory caching
- React Native client has persistent storage caching
- Cache TTL is configurable

### 2. **Batch Operations**

- Use `evaluateBatch` for multiple checks
- Use `useMultiplePermissions` hook for UI
- Reduces network requests

### 3. **Memoization**

- Hooks use proper dependency arrays
- Results are memoized when dependencies don't change
- Use `useMemo` for expensive calculations

## Testing

### Unit Testing Core Client

```javascript
const PolicyClient = require("./node-policy-client");

describe("PolicyClient", () => {
  it("should evaluate permissions", async () => {
    const client = new PolicyClient("http://test-server");
    const result = await client.evaluate("token", "user", "read");
    expect(result.success).toBe(true);
  });
});
```

### Testing React Hooks

```javascript
import { renderHook } from "@testing-library/react-hooks";
import { useAuthorization } from "./react-policy-hooks";

test("useAuthorization hook", async () => {
  const { result, waitForNextUpdate } = renderHook(() =>
    useAuthorization(mockClient, "token", "user", "read")
  );

  expect(result.current.loading).toBe(true);
  await waitForNextUpdate();
  expect(result.current.authorized).toBe(true);
});
```

## Clean Architecture

The repository now contains only the modern functional programming architecture:

- **Core Client**: Framework-agnostic business logic
- **Platform Hooks**: React, React Native, and UI-specific hooks
- **No Legacy Code**: All class-based clients have been removed

This ensures a clean, maintainable codebase focused on functional programming principles.

## Future Enhancements

1. **TypeScript Support**: Add TypeScript definitions
2. **React Query Integration**: Optional integration with React Query
3. **Suspense Support**: Add React Suspense integration
4. **WebSocket Support**: Real-time permission updates
5. **GraphQL Integration**: GraphQL-based permission queries
