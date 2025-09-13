/**
 * Policy Client Usage Examples
 *
 * This file demonstrates how to use the refactored policy clients
 * across different platforms and frameworks
 */

// ============================================================================
// 1. NODE.JS / EXPRESS USAGE
// ============================================================================

// Basic Node.js usage
const PolicyClient = require("../sdks/node-policy-client");

// Create client instance
const policyClient = new PolicyClient("http://user-service:3000", {
  timeout: 5000,
  retries: 3,
  cacheTimeout: 300000, // 5 minutes
});

// Basic authorization check
async function checkUserAccess(token, resource, action) {
  try {
    const result = await policyClient.evaluate(token, resource, action);
    console.log("Authorization result:", result);
    return result.success;
  } catch (error) {
    console.error("Authorization failed:", error);
    return false;
  }
}

// Express middleware usage
const express = require("express");
const app = express();

// Use built-in middleware
app.get("/api/users", policyClient.middleware("user", "read"), (req, res) => {
  // req.user and req.tenantId are available here
  res.json({ users: [], tenantId: req.tenantId });
});

// Custom middleware with additional logic
function createAuthMiddleware(resource, action) {
  return async (req, res, next) => {
    const token = req.headers.authorization?.substring(7);
    if (!token) {
      return res.status(401).json({ error: "Token required" });
    }

    const authorized = await policyClient.check(
      token,
      resource,
      action,
      req.query
    );
    if (authorized) {
      next();
    } else {
      res.status(403).json({ error: "Access denied" });
    }
  };
}

app.get(
  "/api/admin/users",
  createAuthMiddleware("user", "write"),
  (req, res) => {
    res.json({ message: "Admin access granted" });
  }
);

// ============================================================================
// 2. REACT USAGE WITH HOOKS
// ============================================================================

import React from "react";
import {
  usePolicyClient,
  useAuthorization,
  usePermissions,
  useMultiplePermissions,
} from "../sdks/react-policy-hooks";

// Basic React component with authorization
function UserManagementPage() {
  // Import PolicyClient at the top of your file
  // import PolicyClient from '../sdks/node-policy-client';
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000"
  );
  const token = localStorage.getItem("authToken");

  const { loading, authorized, error } = useAuthorization(
    policyClient,
    token,
    "user",
    "read"
  );

  if (loading) return <div>Checking permissions...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!authorized) return <div>Access denied</div>;

  return (
    <div>
      <h1>User Management</h1>
      <UserList />
    </div>
  );
}

// Component with multiple permission checks
function AdminDashboard() {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000"
  );
  const token = localStorage.getItem("authToken");

  const permissionChecks = [
    { resource: "user", action: "read" },
    { resource: "user", action: "write" },
    { resource: "role", action: "read" },
    { resource: "admin", action: "read" },
  ];

  const { loading, permissions, allLoaded, error } = useMultiplePermissions(
    policyClient,
    token,
    permissionChecks
  );

  if (loading) return <div>Loading permissions...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>Admin Dashboard</h1>
      {permissions.user_read && <UserSection />}
      {permissions.user_write && <UserCreateButton />}
      {permissions.role_read && <RoleSection />}
      {permissions.admin_read && <AdminSection />}
    </div>
  );
}

// Component with resource permissions
function UserActions({ userId }) {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000"
  );
  const token = localStorage.getItem("authToken");

  const { loading, permissions, error } = usePermissions(
    policyClient,
    token,
    "user"
  );

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {permissions.includes("read") && <ViewButton userId={userId} />}
      {permissions.includes("write") && <EditButton userId={userId} />}
      {permissions.includes("delete") && <DeleteButton userId={userId} />}
    </div>
  );
}

// ============================================================================
// 3. REACT WITH UI HOOKS
// ============================================================================

import {
  useUIInitialization,
  useNavigationMenu,
  useActionButtons,
  useFeatureFlags,
  useDashboardWidgets,
} from "../sdks/react-ui-policy-hooks";

// Complete UI initialization
function App() {
  const token = localStorage.getItem("authToken");
  const {
    loading,
    capabilities,
    permissions,
    resourcePermissions,
    initialized,
    error,
  } = useUIInitialization(PolicyClient, "http://user-service:3000", token);

  if (loading) return <div>Initializing application...</div>;
  if (error) return <div>Initialization error: {error}</div>;
  if (!initialized) return <div>Failed to initialize</div>;

  return (
    <div>
      <Navigation capabilities={capabilities} />
      <Dashboard capabilities={capabilities} />
      <MainContent capabilities={capabilities} />
    </div>
  );
}

// Navigation component
function Navigation({ capabilities }) {
  const navigationItems = useNavigationMenu(capabilities);

  return (
    <nav>
      {navigationItems.map((item) => (
        <a
          key={item.id}
          href={item.path}
          className={item.active ? "active" : ""}
        >
          {item.icon} {item.label}
        </a>
      ))}
    </nav>
  );
}

// Action buttons component
function UserManagementActions({ capabilities }) {
  const userActions = useActionButtons(capabilities, "users");

  return (
    <div className="actions">
      {userActions.map((action) => (
        <button key={action.id} onClick={action.onClick} title={action.label}>
          {action.icon} {action.label}
        </button>
      ))}
    </div>
  );
}

// Feature flag usage
function AdvancedFeatures({ capabilities }) {
  const featureFlags = useFeatureFlags(capabilities);

  return (
    <div>
      {featureFlags.user_management && <UserManagementPanel />}
      {featureFlags.role_management && <RoleManagementPanel />}
      {featureFlags.advanced_admin && <AdvancedAdminPanel />}
      {featureFlags.data_deletion && <DataDeletionPanel />}
    </div>
  );
}

// Dashboard with widgets
function Dashboard({ capabilities }) {
  const widgets = useDashboardWidgets(capabilities);

  return (
    <div className="dashboard">
      {widgets.map((widget) => (
        <div key={widget.id} className="widget">
          <h3>{widget.title}</h3>
          {widget.type === "navigation" && (
            <a href={widget.path}>
              {widget.icon} Go to {widget.title}
            </a>
          )}
          {widget.type === "actions" && (
            <div>
              {widget.actions.map((action) => (
                <button key={action.resource + action.action}>
                  {action.icon} {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// 4. REACT NATIVE USAGE
// ============================================================================

import React from "react";
import { View, Text, Button, Alert } from "react-native";
import {
  usePolicyClient,
  useAuthorization,
  useOfflineAuthorization,
  usePreloadPermissions,
} from "../sdks/react-native-policy-hooks";

// Basic React Native component
function UserScreen() {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000",
    {
      timeout: 10000,
      enableOfflineCache: true,
      onTokenExpired: () =>
        Alert.alert("Session Expired", "Please login again"),
    }
  );

  const token = ""; // Get from secure storage

  const { loading, authorized, cached, error } = useOfflineAuthorization(
    policyClient,
    token,
    "user",
    "read"
  );

  if (loading) return <Text>Checking permissions...</Text>;
  if (error) return <Text>Error: {error}</Text>;
  if (!authorized) return <Text>Access denied</Text>;

  return (
    <View>
      <Text>User Management</Text>
      {cached && <Text style={{ color: "orange" }}>Using cached data</Text>}
      <UserList />
    </View>
  );
}

// Offline-first component with preloading
function OfflineCapableApp() {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000",
    {
      enableOfflineCache: true,
      cacheTimeout: 600000, // 10 minutes
    }
  );

  const token = ""; // Get from secure storage
  const resources = ["user", "role", "admin", "crm"];

  const {
    loading: preloadLoading,
    results,
    preloaded,
    preload,
  } = usePreloadPermissions(policyClient, token, resources);

  React.useEffect(() => {
    // Preload permissions on app start
    preload();
  }, []);

  const { loading, authorized, cached, networkStatus, isOffline } =
    useOfflineAuthorization(policyClient, token, "user", "read");

  return (
    <View>
      <Text>Network: {networkStatus}</Text>
      {isOffline && <Text style={{ color: "red" }}>Offline Mode</Text>}
      {preloaded && (
        <Text style={{ color: "green" }}>Permissions Preloaded</Text>
      )}

      {loading ? (
        <Text>Loading...</Text>
      ) : authorized ? (
        <View>
          <Text>User Management</Text>
          {cached && <Text>Using cached permissions</Text>}
        </View>
      ) : (
        <Text>Access denied</Text>
      )}
    </View>
  );
}

// ============================================================================
// 5. ADVANCED PATTERNS
// ============================================================================

// Higher-Order Component for authorization
function withAuthorization(WrappedComponent, resource, action) {
  return function AuthorizedComponent(props) {
    const policyClient = usePolicyClient(
      PolicyClient,
      "http://user-service:3000"
    );
    const token = localStorage.getItem("authToken");
    const { loading, authorized, error } = useAuthorization(
      policyClient,
      token,
      resource,
      action
    );

    if (loading) return <div>Checking permissions...</div>;
    if (error) return <div>Authorization error: {error}</div>;
    if (!authorized) return <div>Access denied</div>;

    return <WrappedComponent {...props} />;
  };
}

// Usage of HOC
const ProtectedUserPage = withAuthorization(UserManagementPage, "user", "read");

// Custom hook for role-based access
function useRoleBasedAccess(requiredRoles) {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000"
  );
  const token = localStorage.getItem("authToken");

  const [hasAccess, setHasAccess] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const checkRoles = async () => {
      if (!token || !requiredRoles.length) {
        setLoading(false);
        return;
      }

      try {
        const checks = requiredRoles.map((role) => ({
          token,
          resource: "role",
          action: "read",
          context: { role },
        }));

        const results = await policyClient.evaluateBatch(checks);
        const hasAllRoles = results.every((result) => result.success);

        setHasAccess(hasAllRoles);
      } catch (error) {
        console.error("Role check failed:", error);
        setHasAccess(false);
      } finally {
        setLoading(false);
      }
    };

    checkRoles();
  }, [policyClient, token, JSON.stringify(requiredRoles)]);

  return { hasAccess, loading };
}

// Usage of custom role hook
function AdminOnlyComponent() {
  const { hasAccess, loading } = useRoleBasedAccess(["admin", "super_admin"]);

  if (loading) return <div>Checking roles...</div>;
  if (!hasAccess) return <div>Admin access required</div>;

  return <div>Admin functionality here</div>;
}

// Export examples for documentation
export {
  // Node.js examples
  checkUserAccess,
  createAuthMiddleware,

  // React examples
  UserManagementPage,
  AdminDashboard,
  UserActions,

  // React UI examples
  App,
  Navigation,
  UserManagementActions,
  AdvancedFeatures,
  Dashboard,

  // React Native examples
  UserScreen,
  OfflineCapableApp,

  // Advanced patterns
  withAuthorization,
  useRoleBasedAccess,
  AdminOnlyComponent,
};
