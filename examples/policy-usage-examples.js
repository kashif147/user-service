/**
 * Usage Examples for Centralized RBAC Policy Evaluation
 *
 * This file demonstrates how to use the policy evaluation system
 * across different platforms and services.
 */

// ============================================================================
// NODE.JS / EXPRESS MICROSERVICE EXAMPLE
// ============================================================================

const PolicyClient = require("./sdks/node-policy-client");

// Initialize policy client
const policy = new PolicyClient("http://user-service:3000", {
  timeout: 5000,
  retries: 3,
  cacheTimeout: 300000, // 5 minutes
});

// Example 1: Express middleware
app.get("/api/users", policy.middleware("user", "read"), (req, res) => {
  // This route is automatically protected
  // req.user and req.tenantId are available
  res.json({ users: [] });
});

// Example 2: Manual authorization check
async function getUserProfile(req, res) {
  const token = req.headers.authorization?.substring(7);

  const result = await policy.evaluate(token, "user", "read");

  if (result.success) {
    res.json({ profile: "user data" });
  } else {
    res.status(403).json({ error: "Access denied" });
  }
}

// Example 3: Batch evaluation for multiple permissions
async function checkMultiplePermissions(token) {
  const requests = [
    { token, resource: "user", action: "read" },
    { token, resource: "user", action: "write" },
    { token, resource: "role", action: "read" },
  ];

  const results = await policy.evaluateBatch(requests);
  return results;
}

// ============================================================================
// REACT WEB APPLICATION EXAMPLE
// ============================================================================

import PolicyClient from "./sdks/react-policy-client";

// Initialize policy client
const policy = new PolicyClient("http://user-service:3000", {
  onTokenExpired: () => {
    // Redirect to login
    window.location.href = "/login";
  },
});

// Example 1: React Hook usage
function UserProfile({ token }) {
  const { loading, authorized, error } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!authorized) return <div>Access denied</div>;

  return <div>User Profile Content</div>;
}

// Example 2: Permission-based rendering
function UserActions({ token }) {
  const { loading, permissions } = policy.usePermissions(token, "user");

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {permissions.includes("user:write") && <button>Edit User</button>}
      {permissions.includes("user:delete") && <button>Delete User</button>}
    </div>
  );
}

// Example 3: Conditional components
function AdminPanel({ token }) {
  return (
    <policy.AuthorizedComponent
      token={token}
      resource="admin"
      action="read"
      fallback={<div>Access denied</div>}
    >
      <div>Admin Panel Content</div>
    </policy.AuthorizedComponent>
  );
}

// ============================================================================
// REACT NATIVE MOBILE APPLICATION EXAMPLE
// ============================================================================

import PolicyClient from "./sdks/react-native-policy-client";

// Initialize policy client with offline support
const policy = new PolicyClient("http://user-service:3000", {
  enableOfflineCache: true,
  cacheTimeout: 600000, // 10 minutes
  onTokenExpired: () => {
    // Navigate to login screen
    navigation.navigate("Login");
  },
});

// Example 1: Mobile-specific hook usage
function MobileUserProfile({ token }) {
  const { loading, authorized, error, cached } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  return (
    <View>
      {loading && <Text>Loading...</Text>}
      {cached && <Text>Using cached data</Text>}
      {error && <Text>Error: {error}</Text>}
      {authorized && <Text>User Profile Content</Text>}
    </View>
  );
}

// Example 2: Preload permissions for offline use
async function preloadUserPermissions(token) {
  const resources = ["user", "portal", "crm"];
  const result = await policy.preloadPermissions(token, resources);

  if (result.success) {
    console.log("Permissions preloaded for offline use");
  }
}

// ============================================================================
// DIRECT API USAGE EXAMPLES
// ============================================================================

// Example 1: Single policy evaluation
async function checkAccess(token, resource, action) {
  const response = await fetch("http://user-service:3000/policy/evaluate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, resource, action }),
  });

  const result = await response.json();
  return result.success;
}

// Example 2: Batch evaluation
async function checkMultipleAccess(requests) {
  const response = await fetch(
    "http://user-service:3000/policy/evaluate-batch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  );

  const result = await response.json();
  return result.results;
}

// Example 3: Get permissions
async function getUserPermissions(token, resource) {
  const response = await fetch(
    `http://user-service:3000/policy/permissions/${resource}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const result = await response.json();
  return result.permissions;
}

// Example 4: Quick check
async function quickCheck(token, resource, action) {
  const response = await fetch(
    `http://user-service:3000/policy/check/${resource}/${action}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.ok;
}

// ============================================================================
// INTEGRATION EXAMPLES
// ============================================================================

// Example 1: Integration with existing Express middleware
const express = require("express");
const app = express();

// Replace existing auth middleware
app.use("/api", async (req, res, next) => {
  const token = req.headers.authorization?.substring(7);

  if (!token) {
    return res.status(401).json({ error: "Token required" });
  }

  // Extract resource and action from route
  const resource = req.route.path.split("/")[1] || "api";
  const action = req.method.toLowerCase();

  const result = await policy.evaluate(token, resource, action);

  if (result.success) {
    req.user = result.user;
    req.tenantId = result.user.tenantId;
    next();
  } else {
    res.status(403).json({ error: "Access denied", reason: result.reason });
  }
});

// Example 2: Integration with React Router
import { Route, Redirect } from "react-router-dom";

function ProtectedRoute({ token, resource, action, children }) {
  const { loading, authorized } = policy.useAuthorization(
    token,
    resource,
    action
  );

  if (loading) return <div>Loading...</div>;

  return authorized ? children : <Redirect to="/unauthorized" />;
}

// Usage in routes
<Route
  path="/admin"
  render={() => (
    <ProtectedRoute token={token} resource="admin" action="read">
      <AdminPanel />
    </ProtectedRoute>
  )}
/>;

// Example 3: Integration with React Native Navigation
import { NavigationContainer } from "@react-navigation/native";

function AppNavigator({ token }) {
  const { authorized: canAccessCRM } = policy.useAuthorization(
    token,
    "crm",
    "read"
  );
  const { authorized: canAccessPortal } = policy.useAuthorization(
    token,
    "portal",
    "read"
  );

  return (
    <NavigationContainer>
      <Stack.Navigator>
        {canAccessCRM && <Stack.Screen name="CRM" component={CRMScreen} />}
        {canAccessPortal && (
          <Stack.Screen name="Portal" component={PortalScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

module.exports = {
  // Export examples for reference
  nodeExamples: {
    middleware: policy.middleware,
    evaluate: policy.evaluate,
    evaluateBatch: policy.evaluateBatch,
  },
  reactExamples: {
    useAuthorization: policy.useAuthorization,
    usePermissions: policy.usePermissions,
    AuthorizedComponent: policy.AuthorizedComponent,
  },
  reactNativeExamples: {
    preloadPermissions: policy.preloadPermissions,
    useAuthorization: policy.useAuthorization,
  },
};
