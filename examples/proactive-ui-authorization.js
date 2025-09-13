/**
 * Proactive UI Authorization Examples
 *
 * This demonstrates how to build permission-aware UIs that only show
 * what users are authorized to see, rather than checking permissions
 * after rendering.
 */

import React, { createContext, useContext, useState, useEffect } from "react";
import PolicyClient from "../sdks/react-policy-client";

// Initialize policy client
const policyClient = new PolicyClient("http://user-service:3000");

// ============================================================================
// AUTHORIZATION CONTEXT PROVIDER
// ============================================================================

const AuthorizationContext = createContext();

export const AuthorizationProvider = ({ children, token }) => {
  const [authState, setAuthState] = useState({
    loading: true,
    permissions: {},
    userCapabilities: {},
    error: null,
  });

  useEffect(() => {
    if (!token) {
      setAuthState({
        loading: false,
        permissions: {},
        userCapabilities: {},
        error: "No token",
      });
      return;
    }

    initializeUserPermissions(token);
  }, [token]);

  const initializeUserPermissions = async (token) => {
    try {
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

        // User management permissions
        {
          resource: "user",
          action: "read",
          category: "users",
          label: "View Users",
        },
        {
          resource: "user",
          action: "write",
          category: "users",
          label: "Create/Edit Users",
        },
        {
          resource: "user",
          action: "delete",
          category: "users",
          label: "Delete Users",
        },

        // Role management permissions
        {
          resource: "role",
          action: "read",
          category: "roles",
          label: "View Roles",
        },
        {
          resource: "role",
          action: "write",
          category: "roles",
          label: "Create/Edit Roles",
        },
        {
          resource: "role",
          action: "delete",
          category: "roles",
          label: "Delete Roles",
        },

        // Data operations
        {
          resource: "crm",
          action: "write",
          category: "data",
          label: "Create Records",
        },
        {
          resource: "crm",
          action: "delete",
          category: "data",
          label: "Delete Records",
        },

        // System administration
        {
          resource: "admin",
          action: "write",
          category: "system",
          label: "System Configuration",
        },
        {
          resource: "admin",
          action: "delete",
          category: "system",
          label: "System Maintenance",
        },
      ];

      // Batch check all permissions at once
      const requests = allUIActions.map((action) => ({
        token,
        resource: action.resource,
        action: action.action,
        context: { category: action.category },
      }));

      console.log("🔄 Checking all UI permissions...");
      const results = await policyClient.evaluateBatch(requests);

      // Build permission map and user capabilities
      const permissions = {};
      const userCapabilities = {
        navigation: [],
        actions: {},
        features: {},
      };

      results.forEach((result, index) => {
        const action = allUIActions[index];
        const key = `${action.resource}_${action.action}`;
        permissions[key] = result.success;

        if (result.success) {
          // Build navigation capabilities
          if (action.category === "navigation") {
            userCapabilities.navigation.push({
              resource: action.resource,
              label: action.label,
              path: `/${action.resource}`,
            });
          }

          // Build action capabilities by category
          if (!userCapabilities.actions[action.category]) {
            userCapabilities.actions[action.category] = [];
          }
          userCapabilities.actions[action.category].push({
            resource: action.resource,
            action: action.action,
            label: action.label,
          });

          // Build feature flags
          userCapabilities.features[key] = true;
        }
      });

      // Also get detailed permissions for each resource
      const resources = ["portal", "crm", "admin", "user", "role"];
      const resourcePermissions = {};

      await Promise.all(
        resources.map(async (resource) => {
          const resourcePerms = await policyClient.getPermissions(
            token,
            resource
          );
          if (resourcePerms.success) {
            resourcePermissions[resource] = resourcePerms.permissions;
          }
        })
      );

      setAuthState({
        loading: false,
        permissions,
        userCapabilities,
        resourcePermissions,
        error: null,
      });

      console.log("✅ User permissions initialized:", userCapabilities);
    } catch (error) {
      console.error("❌ Failed to initialize permissions:", error);
      setAuthState({
        loading: false,
        permissions: {},
        userCapabilities: {},
        error: error.message,
      });
    }
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
// PERMISSION-AWARE NAVIGATION COMPONENT
// ============================================================================

export const NavigationMenu = () => {
  const { loading, userCapabilities } = useAuthorization();

  if (loading) {
    return <div className="nav-loading">Loading menu...</div>;
  }

  return (
    <nav className="main-navigation">
      <ul>
        {userCapabilities.navigation.map((item) => (
          <li key={item.resource}>
            <a href={item.path}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
};

// ============================================================================
// PERMISSION-AWARE DASHBOARD
// ============================================================================

export const Dashboard = () => {
  const { loading, userCapabilities, permissions } = useAuthorization();

  if (loading) {
    return <div className="dashboard-loading">Loading dashboard...</div>;
  }

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      {/* Navigation Cards - Only show accessible sections */}
      <div className="dashboard-cards">
        {userCapabilities.navigation.map((nav) => (
          <div key={nav.resource} className="dashboard-card">
            <h3>{nav.label}</h3>
            <a href={nav.path}>Go to {nav.label}</a>
          </div>
        ))}
      </div>

      {/* Quick Actions - Only show permitted actions */}
      <div className="quick-actions">
        <h2>Quick Actions</h2>

        {/* User Management Actions */}
        {userCapabilities.actions.users && (
          <div className="action-group">
            <h3>User Management</h3>
            {userCapabilities.actions.users.map((action) => (
              <button key={`${action.resource}_${action.action}`}>
                {action.label}
              </button>
            ))}
          </div>
        )}

        {/* Role Management Actions */}
        {userCapabilities.actions.roles && (
          <div className="action-group">
            <h3>Role Management</h3>
            {userCapabilities.actions.roles.map((action) => (
              <button key={`${action.resource}_${action.action}`}>
                {action.label}
              </button>
            ))}
          </div>
        )}

        {/* Data Operations */}
        {userCapabilities.actions.data && (
          <div className="action-group">
            <h3>Data Operations</h3>
            {userCapabilities.actions.data.map((action) => (
              <button key={`${action.resource}_${action.action}`}>
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Feature Flags Demo */}
      <div className="feature-demo">
        <h2>Available Features</h2>
        {permissions.admin_read && (
          <div>🔧 System Administration Available</div>
        )}
        {permissions.user_write && <div>👥 User Creation Available</div>}
        {permissions.role_write && <div>🏷️ Role Management Available</div>}
        {permissions.crm_delete && <div>🗑️ Data Deletion Available</div>}
      </div>
    </div>
  );
};

// ============================================================================
// PERMISSION-AWARE USER MANAGEMENT PAGE
// ============================================================================

export const UserManagementPage = () => {
  const { loading, userCapabilities, permissions } = useAuthorization();
  const [users, setUsers] = useState([]);

  // Only load if user has read permission
  useEffect(() => {
    if (!loading && permissions.user_read) {
      loadUsers();
    }
  }, [loading, permissions.user_read]);

  const loadUsers = async () => {
    // Load users from API
    // This will only be called if user has permission
    console.log("Loading users...");
  };

  if (loading) {
    return <div>Loading permissions...</div>;
  }

  if (!permissions.user_read) {
    return (
      <div className="access-denied">
        <h1>Access Denied</h1>
        <p>You don't have permission to view user management.</p>
      </div>
    );
  }

  return (
    <div className="user-management">
      <div className="page-header">
        <h1>User Management</h1>

        {/* Only show create button if user has write permission */}
        {permissions.user_write && (
          <button className="btn-primary">Create New User</button>
        )}
      </div>

      {/* User list with conditional action buttons */}
      <div className="user-list">
        {users.map((user) => (
          <div key={user.id} className="user-card">
            <div className="user-info">
              <h3>{user.name}</h3>
              <p>{user.email}</p>
            </div>

            <div className="user-actions">
              <button>View</button>

              {permissions.user_write && <button>Edit</button>}

              {permissions.user_delete && (
                <button className="btn-danger">Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// PERMISSION-AWARE DATA TABLE COMPONENT
// ============================================================================

export const PermissionAwareDataTable = ({
  data,
  resource,
  onEdit,
  onDelete,
  onView,
}) => {
  const { permissions } = useAuthorization();

  const canEdit = permissions[`${resource}_write`];
  const canDelete = permissions[`${resource}_delete`];
  const canView = permissions[`${resource}_read`];

  if (!canView) {
    return <div>You don't have permission to view this data.</div>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {data.map((item) => (
          <tr key={item.id}>
            <td>{item.name}</td>
            <td>{item.email}</td>
            <td>{item.status}</td>
            <td>
              <button onClick={() => onView(item)}>View</button>

              {canEdit && <button onClick={() => onEdit(item)}>Edit</button>}

              {canDelete && (
                <button className="btn-danger" onClick={() => onDelete(item)}>
                  Delete
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ============================================================================
// MAIN APPLICATION WRAPPER
// ============================================================================

export const App = () => {
  const [token, setToken] = useState(localStorage.getItem("token"));

  if (!token) {
    return <LoginPage onLogin={setToken} />;
  }

  return (
    <AuthorizationProvider token={token}>
      <div className="app">
        <NavigationMenu />
        <main>
          <Dashboard />
        </main>
      </div>
    </AuthorizationProvider>
  );
};

// ============================================================================
// UTILITY FUNCTIONS FOR PERMISSION CHECKING
// ============================================================================

export const usePermissionCheck = () => {
  const { permissions } = useAuthorization();

  return {
    can: (resource, action) => permissions[`${resource}_${action}`],
    canAny: (checks) =>
      checks.some(([resource, action]) => permissions[`${resource}_${action}`]),
    canAll: (checks) =>
      checks.every(
        ([resource, action]) => permissions[`${resource}_${action}`]
      ),
  };
};

// ============================================================================
// HIGHER-ORDER COMPONENT FOR PERMISSION WRAPPING
// ============================================================================

export const withPermission = (resource, action, fallback = null) => {
  return (WrappedComponent) => {
    return (props) => {
      const { loading, permissions } = useAuthorization();

      if (loading) {
        return <div>Loading...</div>;
      }

      if (!permissions[`${resource}_${action}`]) {
        return fallback;
      }

      return <WrappedComponent {...props} />;
    };
  };
};

// Usage example:
// const ProtectedUserList = withPermission('user', 'read', <AccessDenied />)(UserList);

export default {
  AuthorizationProvider,
  useAuthorization,
  NavigationMenu,
  Dashboard,
  UserManagementPage,
  PermissionAwareDataTable,
  App,
  usePermissionCheck,
  withPermission,
};
