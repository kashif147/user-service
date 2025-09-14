/**
 * Complete React Application Example with Proactive Authorization
 *
 * This example shows how to build a React app where the UI is completely
 * driven by user permissions, showing only what users are authorized to see.
 */

import React, { useState, useEffect, createContext, useContext } from "react";
import PolicyClient from "../sdks/node-policy-client";
import { useUIInitialization } from "../sdks/react-ui-policy-hooks";

// UI Configuration for the application
const uiConfig = {
  // Define your application's UI structure
  navigation: [
    {
      resource: "portal",
      action: "read",
      label: "Dashboard",
      path: "/dashboard",
      icon: "🏠",
    },
    {
      resource: "crm",
      action: "read",
      label: "CRM",
      path: "/crm",
      icon: "👥",
    },
    {
      resource: "user",
      action: "read",
      label: "Users",
      path: "/users",
      icon: "👤",
    },
    {
      resource: "role",
      action: "read",
      label: "Roles",
      path: "/roles",
      icon: "🏷️",
    },
    {
      resource: "admin",
      action: "read",
      label: "Admin",
      path: "/admin",
      icon: "⚙️",
    },
  ],

  actions: {
    users: [
      { resource: "user", action: "read", label: "View Users", icon: "👀" },
      { resource: "user", action: "write", label: "Create User", icon: "➕" },
      { resource: "user", action: "write", label: "Edit User", icon: "✏️" },
      {
        resource: "user",
        action: "delete",
        label: "Delete User",
        icon: "🗑️",
      },
    ],
    roles: [
      { resource: "role", action: "read", label: "View Roles", icon: "👀" },
      { resource: "role", action: "write", label: "Create Role", icon: "➕" },
      { resource: "role", action: "write", label: "Edit Role", icon: "✏️" },
      {
        resource: "role",
        action: "delete",
        label: "Delete Role",
        icon: "🗑️",
      },
    ],
    crm: [
      { resource: "crm", action: "read", label: "View Records", icon: "👀" },
      {
        resource: "crm",
        action: "write",
        label: "Create Record",
        icon: "➕",
      },
      { resource: "crm", action: "write", label: "Edit Record", icon: "✏️" },
      {
        resource: "crm",
        action: "delete",
        label: "Delete Record",
        icon: "🗑️",
      },
    ],
    admin: [
      {
        resource: "admin",
        action: "write",
        label: "System Config",
        icon: "🔧",
      },
      {
        resource: "admin",
        action: "delete",
        label: "System Maintenance",
        icon: "🛠️",
      },
    ],
  },

  features: [
    {
      key: "user_management",
      resource: "user",
      action: "read",
      label: "User Management Module",
    },
    {
      key: "role_management",
      resource: "role",
      action: "read",
      label: "Role Management Module",
    },
    {
      key: "advanced_crm",
      resource: "crm",
      action: "write",
      label: "Advanced CRM Features",
    },
    {
      key: "system_admin",
      resource: "admin",
      action: "write",
      label: "System Administration",
    },
    {
      key: "bulk_operations",
      resource: "crm",
      action: "delete",
      label: "Bulk Operations",
    },
  ],

  pages: [
    {
      path: "/dashboard",
      requiredPermissions: [{ resource: "portal", action: "read" }],
      label: "Dashboard",
      component: "Dashboard",
    },
    {
      path: "/users",
      requiredPermissions: [{ resource: "user", action: "read" }],
      label: "User Management",
      component: "UserManagement",
    },
    {
      path: "/roles",
      requiredPermissions: [{ resource: "role", action: "read" }],
      label: "Role Management",
      component: "RoleManagement",
    },
    {
      path: "/crm",
      requiredPermissions: [{ resource: "crm", action: "read" }],
      label: "CRM System",
      component: "CRMSystem",
    },
    {
      path: "/admin",
      requiredPermissions: [{ resource: "admin", action: "read" }],
      label: "Administration",
      component: "Administration",
    },
  ],
};

// ============================================================================
// AUTHORIZATION CONTEXT
// ============================================================================

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [authState, setAuthState] = useState({
    token: localStorage.getItem("token"),
    user: null,
    loading: true,
  });

  // Use the new UI initialization hook
  const uiState = useUIInitialization(
    PolicyClient,
    "http://user-service:3000",
    authState.token,
    { uiConfig }
  );

  // Log UI initialization status
  useEffect(() => {
    if (uiState.initialized && !uiState.loading) {
      console.log("✅ UI initialization complete:", {
        navigation: uiState.capabilities?.navigation?.length || 0,
        actions: Object.keys(uiState.capabilities?.actions || {}).length,
        features: Object.keys(uiState.capabilities?.features || {}).length,
        pages: uiState.capabilities?.pages?.length || 0,
      });
    }
  }, [uiState.initialized, uiState.loading]);

  const login = (token, user) => {
    localStorage.setItem("token", token);
    setAuthState({ token, user, loading: false });
  };

  const logout = () => {
    localStorage.removeItem("token");
    setAuthState({ token: null, user: null, loading: false });
    setUIState({
      loading: false,
      capabilities: null,
      permissions: {},
      featureFlags: {},
      error: null,
    });
  };

  return (
    <AuthContext.Provider
      value={{
        auth: authState,
        ui: uiState,
        login,
        logout,
        policyClient,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};

// ============================================================================
// NAVIGATION COMPONENT - Built from permissions
// ============================================================================

const Navigation = () => {
  const { ui } = useAuth();

  if (ui.loading) {
    return <nav className="nav-loading">Loading navigation...</nav>;
  }

  if (!ui.capabilities) {
    return null;
  }

  const menuItems = policyClient.generateNavigationMenu(ui.capabilities);

  return (
    <nav className="main-navigation">
      <div className="nav-brand">
        <h2>My App</h2>
      </div>
      <ul className="nav-menu">
        {menuItems.map((item) => (
          <li key={item.id} className={item.active ? "active" : ""}>
            <a href={item.path}>
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};

// ============================================================================
// DASHBOARD - Built from user capabilities
// ============================================================================

const Dashboard = () => {
  const { ui } = useAuth();

  if (ui.loading) {
    return <div className="dashboard-loading">Loading dashboard...</div>;
  }

  if (!ui.capabilities) {
    return <div className="dashboard-error">Failed to load dashboard</div>;
  }

  const widgets = policyClient.generateDashboardWidgets(ui.capabilities);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Dashboard</h1>
        <div className="dashboard-stats">
          <div className="stat">
            <span className="stat-value">
              {ui.capabilities.stats.grantedPermissions}
            </span>
            <span className="stat-label">Permissions</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {ui.capabilities.navigation.length}
            </span>
            <span className="stat-label">Accessible Areas</span>
          </div>
        </div>
      </div>

      <div className="dashboard-widgets">
        {widgets.map((widget) => (
          <DashboardWidget key={widget.id} widget={widget} />
        ))}
      </div>

      {/* Feature-specific sections */}
      {ui.featureFlags.user_management && (
        <div className="dashboard-section">
          <h2>👥 User Management</h2>
          <p>You have access to user management features</p>
          <QuickActions category="users" />
        </div>
      )}

      {ui.featureFlags.role_management && (
        <div className="dashboard-section">
          <h2>🏷️ Role Management</h2>
          <p>You can manage roles and permissions</p>
          <QuickActions category="roles" />
        </div>
      )}

      {ui.featureFlags.system_admin && (
        <div className="dashboard-section">
          <h2>⚙️ System Administration</h2>
          <p>Advanced system administration tools available</p>
          <QuickActions category="admin" />
        </div>
      )}
    </div>
  );
};

// ============================================================================
// DASHBOARD WIDGET COMPONENT
// ============================================================================

const DashboardWidget = ({ widget }) => {
  if (widget.type === "navigation") {
    return (
      <div className="dashboard-widget navigation-widget">
        <div className="widget-header">
          <span className="widget-icon">{widget.icon}</span>
          <h3>{widget.title}</h3>
        </div>
        <div className="widget-content">
          <a href={widget.path} className="widget-link">
            Go to {widget.title}
          </a>
        </div>
      </div>
    );
  }

  if (widget.type === "actions") {
    return (
      <div className="dashboard-widget actions-widget">
        <div className="widget-header">
          <h3>{widget.title}</h3>
        </div>
        <div className="widget-content">
          {widget.actions.map((action) => (
            <button
              key={`${action.resource}_${action.action}`}
              className="action-button"
              onClick={() => policyClient.handleAction(action)}
            >
              <span className="action-icon">{action.icon}</span>
              <span className="action-label">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return null;
};

// ============================================================================
// QUICK ACTIONS COMPONENT
// ============================================================================

const QuickActions = ({ category }) => {
  const { ui } = useAuth();

  const actions = policyClient.generateActionButtons(ui.capabilities, category);

  return (
    <div className="quick-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          className="quick-action-btn"
          onClick={action.onClick}
        >
          <span className="action-icon">{action.icon}</span>
          <span className="action-label">{action.label}</span>
        </button>
      ))}
    </div>
  );
};

// ============================================================================
// USER MANAGEMENT PAGE - Permission-aware
// ============================================================================

const UserManagementPage = () => {
  const { ui, auth } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Check if user can access this page
  const canAccess =
    ui.capabilities && policyClient.canAccessPage(ui.capabilities, "/users");

  useEffect(() => {
    if (canAccess && ui.permissions.user_read) {
      loadUsers();
    }
  }, [canAccess]);

  const loadUsers = async () => {
    try {
      // Your API call here
      const response = await fetch("/api/users", {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      const userData = await response.json();
      setUsers(userData);
    } catch (error) {
      console.error("Failed to load users:", error);
    } finally {
      setLoading(false);
    }
  };

  if (ui.loading) {
    return <div>Loading permissions...</div>;
  }

  if (!canAccess) {
    return (
      <div className="access-denied">
        <h1>🚫 Access Denied</h1>
        <p>You don't have permission to access user management.</p>
      </div>
    );
  }

  return (
    <div className="user-management">
      <div className="page-header">
        <h1>👥 User Management</h1>

        {/* Only show create button if user has write permission */}
        {ui.permissions.user_write && (
          <button className="btn-primary">➕ Create New User</button>
        )}
      </div>

      {loading ? (
        <div>Loading users...</div>
      ) : (
        <div className="users-grid">
          {users.map((user) => (
            <UserCard key={user.id} user={user} permissions={ui.permissions} />
          ))}
        </div>
      )}

      {/* Show bulk actions if user has advanced permissions */}
      {ui.featureFlags.bulk_operations && (
        <div className="bulk-actions">
          <h3>Bulk Operations</h3>
          <button className="btn-secondary">Export Users</button>
          <button className="btn-warning">Bulk Edit</button>
          {ui.permissions.user_delete && (
            <button className="btn-danger">Bulk Delete</button>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// USER CARD COMPONENT
// ============================================================================

const UserCard = ({ user, permissions }) => {
  return (
    <div className="user-card">
      <div className="user-info">
        <h3>{user.name}</h3>
        <p>{user.email}</p>
        <span className="user-role">{user.role}</span>
      </div>

      <div className="user-actions">
        <button className="btn-sm">👀 View</button>

        {permissions.user_write && <button className="btn-sm">✏️ Edit</button>}

        {permissions.user_delete && (
          <button className="btn-sm btn-danger">🗑️ Delete</button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================

const App = () => {
  return (
    <AuthProvider>
      <div className="app">
        <AppContent />
      </div>
    </AuthProvider>
  );
};

const AppContent = () => {
  const { auth, ui } = useAuth();

  // Show login if not authenticated
  if (!auth.token) {
    return <LoginPage />;
  }

  // Show loading while initializing UI
  if (ui.loading) {
    return (
      <div className="app-loading">
        <h2>🔄 Initializing Application...</h2>
        <p>Loading your personalized interface...</p>
      </div>
    );
  }

  // Show error if UI initialization failed
  if (ui.error) {
    return (
      <div className="app-error">
        <h2>❌ Failed to Load Application</h2>
        <p>{ui.error}</p>
        <button onClick={() => window.location.reload()}>🔄 Retry</button>
      </div>
    );
  }

  // Render the application with permission-aware UI
  return (
    <div className="app-container">
      <Navigation />
      <main className="app-main">
        <Dashboard />
      </main>
    </div>
  );
};

// ============================================================================
// LOGIN PAGE (Placeholder)
// ============================================================================

const LoginPage = () => {
  const { login } = useAuth();

  const handleLogin = () => {
    // Simulate login - replace with your actual login logic
    const mockToken = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..."; // Your JWT token
    const mockUser = { id: "123", email: "user@example.com", name: "John Doe" };
    login(mockToken, mockUser);
  };

  return (
    <div className="login-page">
      <h1>🔐 Login</h1>
      <button onClick={handleLogin} className="btn-primary">
        Login with Demo Account
      </button>
    </div>
  );
};

// ============================================================================
// CSS STYLES (Add to your stylesheet)
// ============================================================================

const styles = `
.app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.app-loading, .app-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  text-align: center;
}

.main-navigation {
  background: #2c3e50;
  color: white;
  padding: 1rem;
}

.nav-menu {
  display: flex;
  list-style: none;
  gap: 1rem;
  margin: 0;
  padding: 0;
}

.nav-menu a {
  color: white;
  text-decoration: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.nav-menu .active a {
  background: rgba(255,255,255,0.2);
}

.dashboard {
  padding: 2rem;
}

.dashboard-widgets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1rem;
  margin: 2rem 0;
}

.dashboard-widget {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 1rem;
  background: white;
}

.quick-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.quick-action-btn, .action-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  cursor: pointer;
}

.user-card {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.user-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-primary { background: #3498db; color: white; }
.btn-secondary { background: #95a5a6; color: white; }
.btn-warning { background: #f39c12; color: white; }
.btn-danger { background: #e74c3c; color: white; }
`;

export default App;
