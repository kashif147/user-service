/**
 * Proactive UI Authorization Examples
 *
 * This demonstrates how to build permission-aware UIs that only show
 * what users are authorized to see, rather than checking permissions
 * after rendering.
 */

import React, { createContext, useContext, useState, useEffect } from "react";
import PolicyClient from "../sdks/node-policy-client";
import {
  usePolicyClient,
  useMultiplePermissions,
} from "../sdks/react-policy-hooks";

// ============================================================================
// AUTHORIZATION CONTEXT PROVIDER
// ============================================================================

const AuthorizationContext = createContext();

export const AuthorizationProvider = ({ children, token }) => {
  const policyClient = usePolicyClient(
    PolicyClient,
    "http://user-service:3000"
  );

  // Define all possible UI actions across your application
  const allUIActions = [
    // Navigation permissions
    {
      resource: "portal",
      action: "read",
      category: "navigation",
      label: "Portal Access",
    },
    {
      resource: "crm",
      action: "read",
      category: "navigation",
      label: "CRM Access",
    },
    {
      resource: "admin",
      action: "read",
      category: "navigation",
      label: "Admin Panel",
    },
    // Data permissions
    { resource: "user", action: "read", category: "data", label: "View Users" },
    {
      resource: "user",
      action: "write",
      category: "data",
      label: "Edit Users",
    },
    {
      resource: "user",
      action: "delete",
      category: "data",
      label: "Delete Users",
    },
    { resource: "role", action: "read", category: "data", label: "View Roles" },
    {
      resource: "role",
      action: "write",
      category: "data",
      label: "Edit Roles",
    },
    // Feature permissions
    {
      resource: "crm",
      action: "write",
      category: "feature",
      label: "Create Records",
    },
    {
      resource: "crm",
      action: "delete",
      category: "feature",
      label: "Delete Records",
    },
    {
      resource: "admin",
      action: "write",
      category: "feature",
      label: "System Config",
    },
  ];

  const { loading, permissions, allLoaded, error } = useMultiplePermissions(
    policyClient,
    token,
    allUIActions
  );

  // Build user capabilities from permissions
  const userCapabilities = React.useMemo(() => {
    if (!allLoaded) return {};

    return {
      navigation: allUIActions
        .filter((action) => action.category === "navigation")
        .filter((action) => permissions[`${action.resource}_${action.action}`])
        .map((action) => ({ resource: action.resource, label: action.label })),

      dataOperations: allUIActions
        .filter((action) => action.category === "data")
        .filter((action) => permissions[`${action.resource}_${action.action}`])
        .map((action) => ({
          resource: action.resource,
          action: action.action,
          label: action.label,
        })),

      features: allUIActions
        .filter((action) => action.category === "feature")
        .filter((action) => permissions[`${action.resource}_${action.action}`])
        .map((action) => ({
          resource: action.resource,
          action: action.action,
          label: action.label,
        })),
    };
  }, [allLoaded, permissions]);

  const authState = {
    loading,
    permissions,
    userCapabilities,
    error: error || (!token ? "No token" : null),
  };

  return (
    <AuthorizationContext.Provider value={authState}>
      {children}
    </AuthorizationContext.Provider>
  );
};

// Hook to use authorization context
export const useAuthorization = () => {
  const context = useContext(AuthorizationContext);
  if (!context) {
    throw new Error(
      "useAuthorization must be used within AuthorizationProvider"
    );
  }
  return context;
};

// ============================================================================
// PERMISSION-AWARE COMPONENTS
// ============================================================================

// Higher-order component for conditional rendering based on permissions
export const withPermission = (WrappedComponent, resource, action) => {
  return function PermissionWrappedComponent(props) {
    const { permissions, loading } = useAuthorization();

    if (loading) return <div>Loading permissions...</div>;

    const hasPermission = permissions[`${resource}_${action}`];
    return hasPermission ? <WrappedComponent {...props} /> : null;
  };
};

// Component for conditional rendering
export const PermissionGate = ({
  resource,
  action,
  children,
  fallback = null,
}) => {
  const { permissions, loading } = useAuthorization();

  if (loading) return <div>Loading permissions...</div>;

  const hasPermission = permissions[`${resource}_${action}`];
  return hasPermission ? children : fallback;
};

// Navigation component that only shows accessible items
export const PermissionAwareNavigation = () => {
  const { userCapabilities, loading } = useAuthorization();

  if (loading) return <div>Loading navigation...</div>;

  return (
    <nav>
      {userCapabilities.navigation?.map((item, index) => (
        <a key={index} href={`/${item.resource}`}>
          {item.label}
        </a>
      ))}
    </nav>
  );
};

// Action buttons that only show if user has permission
export const ActionButtons = ({ resource }) => {
  const { userCapabilities, loading } = useAuthorization();

  if (loading) return <div>Loading actions...</div>;

  const actions =
    userCapabilities.dataOperations?.filter((op) => op.resource === resource) ||
    [];

  return (
    <div>
      {actions.map((action, index) => (
        <button
          key={index}
          onClick={() =>
            console.log(`Executing ${action.action} on ${action.resource}`)
          }
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};

// Feature panel that shows available features
export const FeaturePanel = () => {
  const { userCapabilities, loading } = useAuthorization();

  if (loading) return <div>Loading features...</div>;

  return (
    <div>
      <h3>Available Features</h3>
      {userCapabilities.features?.map((feature, index) => (
        <div key={index}>
          <strong>{feature.label}</strong>
          <p>
            Resource: {feature.resource}, Action: {feature.action}
          </p>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

// Main app component showing how to use the authorization system
export const ExampleApp = () => {
  const [token, setToken] = React.useState(localStorage.getItem("authToken"));

  return (
    <AuthorizationProvider token={token}>
      <div>
        <h1>Permission-Aware Application</h1>

        {/* Navigation only shows accessible items */}
        <PermissionAwareNavigation />

        {/* Conditional rendering based on permissions */}
        <PermissionGate resource="user" action="read">
          <div>
            <h2>User Management</h2>
            <ActionButtons resource="user" />
          </div>
        </PermissionGate>

        <PermissionGate resource="crm" action="read">
          <div>
            <h2>CRM System</h2>
            <ActionButtons resource="crm" />
          </div>
        </PermissionGate>

        <PermissionGate resource="admin" action="read">
          <div>
            <h2>Administration</h2>
            <FeaturePanel />
          </div>
        </PermissionGate>
      </div>
    </AuthorizationProvider>
  );
};
