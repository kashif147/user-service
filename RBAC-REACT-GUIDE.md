# RBAC React Integration Guide

## 🎯 **React.js Integration with Centralized RBAC**

This guide shows how to integrate your React applications with the centralized RBAC user-service for authentication and authorization.

---

## 📦 **Installation & Setup**

### **1. Install Dependencies**

```bash
npm install axios
# or
yarn add axios
```

### **2. Environment Configuration**

Create `.env` file in your React project:

```env
REACT_APP_USER_SERVICE_URL=http://localhost:3000
REACT_APP_TENANT_ID=your-tenant-id
```

---

## 🔧 **Core Integration Components**

### **1. Policy Client Utility**

Create `src/utils/policyClient.js`:

```javascript
import axios from "axios";

class PolicyClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.result;
      }
    }

    try {
      const response = await axios.post(
        `${this.baseURL}/policy/evaluate`,
        {
          token,
          resource,
          action,
          context,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const result = response.data;

      // Cache the result
      this.cache.set(cacheKey, {
        result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      console.error("Policy evaluation failed:", error);
      return {
        success: false,
        decision: "DENY",
        reason: "NETWORK_ERROR",
      };
    }
  }

  async getPermissions(token, resource) {
    try {
      const response = await axios.get(
        `${this.baseURL}/policy/permissions/${resource}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error("Failed to get permissions:", error);
      return { success: false, permissions: [] };
    }
  }

  async evaluateBatch(requests) {
    try {
      const response = await axios.post(
        `${this.baseURL}/policy/evaluate-batch`,
        { requests },
        {
          headers: {
            Authorization: `Bearer ${requests[0]?.token}`,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error("Batch evaluation failed:", error);
      return { success: false, results: [] };
    }
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
  }

  // Get cache stats
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

export const policyClient = new PolicyClient(
  process.env.REACT_APP_USER_SERVICE_URL
);
```

### **2. Authentication Context**

Create `src/contexts/AuthContext.js`:

```javascript
import React, { createContext, useContext, useState, useEffect } from "react";
import { policyClient } from "../utils/policyClient";

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem("authToken"));
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(false);

  // Initialize user from token
  useEffect(() => {
    if (token) {
      initializeUser();
    }
  }, [token]);

  const initializeUser = async () => {
    try {
      setLoading(true);

      // Get user info from token (you might need to decode JWT or call an API)
      const userInfo = await getUserInfoFromToken(token);
      setUser(userInfo);

      // Preload common permissions
      await preloadPermissions();
    } catch (error) {
      console.error("Failed to initialize user:", error);
      logout();
    } finally {
      setLoading(false);
    }
  };

  const getUserInfoFromToken = async (token) => {
    // Decode JWT token to get user info
    // This is a simplified version - you might want to call an API
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return {
        id: payload.sub || payload.id,
        email: payload.email,
        tenantId: payload.tid,
        userType: payload.userType,
        roles: payload.roles || [],
        permissions: payload.permissions || [],
      };
    } catch (error) {
      throw new Error("Invalid token");
    }
  };

  const preloadPermissions = async () => {
    const resources = ["portal", "crm", "user", "role"];
    const permissionMap = {};

    for (const resource of resources) {
      try {
        const result = await policyClient.getPermissions(token, resource);
        if (result.success) {
          permissionMap[resource] = result.permissions;
        }
      } catch (error) {
        console.warn(`Failed to load permissions for ${resource}:`, error);
        permissionMap[resource] = [];
      }
    }

    setPermissions(permissionMap);
  };

  const login = (userData, authToken) => {
    setUser(userData);
    setToken(authToken);
    localStorage.setItem("authToken", authToken);
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    setPermissions({});
    localStorage.removeItem("authToken");
    policyClient.clearCache();
  };

  const checkPermission = async (resource, action, context = {}) => {
    if (!token) return false;

    try {
      const result = await policyClient.evaluatePolicy(
        token,
        resource,
        action,
        context
      );
      return result.success && result.decision === "PERMIT";
    } catch (error) {
      console.error("Permission check failed:", error);
      return false;
    }
  };

  const hasPermission = (resource, action) => {
    // Check cached permissions first
    const resourcePermissions = permissions[resource] || [];
    return resourcePermissions.some(
      (permission) =>
        permission.includes(`${resource}:${action}`) || permission === "*"
    );
  };

  const value = {
    user,
    token,
    permissions,
    loading,
    login,
    logout,
    checkPermission,
    hasPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
```

### **3. Authorization Hooks**

Create `src/hooks/useAuthorization.js`:

```javascript
import { useState, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { policyClient } from "../utils/policyClient";

export const useAuthorization = () => {
  const { token, user } = useAuth();
  const [loading, setLoading] = useState(false);

  const checkPermission = useCallback(
    async (resource, action, context = {}) => {
      if (!token) return false;

      setLoading(true);
      try {
        const result = await policyClient.evaluatePolicy(
          token,
          resource,
          action,
          {
            userId: user?.id,
            tenantId: user?.tenantId,
            ...context,
          }
        );
        return result.success && result.decision === "PERMIT";
      } catch (error) {
        console.error("Permission check failed:", error);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [token, user]
  );

  const checkMultiplePermissions = useCallback(
    async (permissions) => {
      if (!token) return {};

      setLoading(true);
      try {
        const requests = permissions.map(
          ({ resource, action, context = {} }) => ({
            token,
            resource,
            action,
            context: {
              userId: user?.id,
              tenantId: user?.tenantId,
              ...context,
            },
          })
        );

        const result = await policyClient.evaluateBatch(requests);

        if (result.success) {
          const permissionMap = {};
          permissions.forEach((permission, index) => {
            const key = `${permission.resource}_${permission.action}`;
            permissionMap[key] = result.results[index]?.success || false;
          });
          return permissionMap;
        }

        return {};
      } catch (error) {
        console.error("Multiple permission check failed:", error);
        return {};
      } finally {
        setLoading(false);
      }
    },
    [token, user]
  );

  return {
    checkPermission,
    checkMultiplePermissions,
    loading,
  };
};
```

---

## 🛡️ **Route Protection**

### **1. Protected Route Component**

Create `src/components/ProtectedRoute.jsx`:

```javascript
import React, { useState, useEffect } from "react";
import { Redirect } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useAuthorization } from "../hooks/useAuthorization";

const ProtectedRoute = ({
  children,
  requiredResource,
  requiredAction,
  fallbackPath = "/unauthorized",
  loadingComponent = <div>Loading...</div>,
}) => {
  const { user, token } = useAuth();
  const { checkPermission } = useAuthorization();
  const [authorized, setAuthorized] = useState(null);

  useEffect(() => {
    const checkAuth = async () => {
      if (!token) {
        setAuthorized(false);
        return;
      }

      if (!requiredResource || !requiredAction) {
        setAuthorized(true);
        return;
      }

      const hasPermission = await checkPermission(
        requiredResource,
        requiredAction
      );
      setAuthorized(hasPermission);
    };

    checkAuth();
  }, [token, requiredResource, requiredAction, checkPermission]);

  if (authorized === null) {
    return loadingComponent;
  }

  if (!authorized) {
    return <Redirect to={fallbackPath} />;
  }

  return children;
};

export default ProtectedRoute;
```

### **2. Route Configuration**

```javascript
// App.js
import React from "react";
import { BrowserRouter as Router, Route, Switch } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./components/Login";
import Dashboard from "./components/Dashboard";
import UserManagement from "./components/UserManagement";
import Unauthorized from "./components/Unauthorized";

function App() {
  return (
    <AuthProvider>
      <Router>
        <Switch>
          <Route path="/login" component={Login} />

          <ProtectedRoute
            path="/dashboard"
            requiredResource="portal"
            requiredAction="read"
          >
            <Dashboard />
          </ProtectedRoute>

          <ProtectedRoute
            path="/users"
            requiredResource="user"
            requiredAction="read"
          >
            <UserManagement />
          </ProtectedRoute>

          <Route path="/unauthorized" component={Unauthorized} />
        </Switch>
      </Router>
    </AuthProvider>
  );
}

export default App;
```

---

## 🎨 **UI Components**

### **1. Permission-Based Button**

Create `src/components/PermissionButton.jsx`:

```javascript
import React, { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAuthorization } from "../hooks/useAuthorization";

const PermissionButton = ({
  resource,
  action,
  context = {},
  children,
  onClick,
  disabled = false,
  ...props
}) => {
  const { hasPermission } = useAuth();
  const { checkPermission } = useAuthorization();
  const [hasAccess, setHasAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAccess = async () => {
      setLoading(true);

      // First check cached permissions
      if (hasPermission(resource, action)) {
        setHasAccess(true);
        setLoading(false);
        return;
      }

      // If not cached, check with API
      const hasAccessResult = await checkPermission(resource, action, context);
      setHasAccess(hasAccessResult);
      setLoading(false);
    };

    checkAccess();
  }, [resource, action, context, hasPermission, checkPermission]);

  if (loading) {
    return (
      <button disabled {...props}>
        Loading...
      </button>
    );
  }

  if (!hasAccess) {
    return null; // Don't render button if no permission
  }

  return (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  );
};

export default PermissionButton;
```

### **2. Conditional Rendering Hook**

Create `src/hooks/useConditionalRender.js`:

```javascript
import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useAuthorization } from "../hooks/useAuthorization";

export const useConditionalRender = (resource, action, context = {}) => {
  const { hasPermission } = useAuth();
  const { checkPermission } = useAuthorization();
  const [shouldRender, setShouldRender] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkRender = async () => {
      setLoading(true);

      // Check cached permissions first
      if (hasPermission(resource, action)) {
        setShouldRender(true);
        setLoading(false);
        return;
      }

      // If not cached, check with API
      const hasAccess = await checkPermission(resource, action, context);
      setShouldRender(hasAccess);
      setLoading(false);
    };

    checkRender();
  }, [resource, action, context, hasPermission, checkPermission]);

  return { shouldRender, loading };
};
```

### **3. Usage Examples**

```javascript
// Component with permission-based rendering
import React from "react";
import PermissionButton from "./components/PermissionButton";
import { useConditionalRender } from "./hooks/useConditionalRender";

const UserManagement = () => {
  const { shouldRender: canDeleteUsers } = useConditionalRender(
    "user",
    "delete"
  );
  const { shouldRender: canCreateUsers } = useConditionalRender(
    "user",
    "write"
  );

  return (
    <div>
      <h2>User Management</h2>

      {canCreateUsers && <button onClick={createUser}>Create User</button>}

      <PermissionButton
        resource="user"
        action="delete"
        onClick={deleteUser}
        className="btn-danger"
      >
        Delete User
      </PermissionButton>

      {canDeleteUsers && (
        <div className="danger-zone">
          <h3>Danger Zone</h3>
          <button onClick={bulkDelete}>Bulk Delete</button>
        </div>
      )}
    </div>
  );
};
```

---

## 🔄 **Authentication Flow**

### **1. Login Component**

Create `src/components/Login.jsx`:

```javascript
import React, { useState } from "react";
import { useAuth } from "../contexts/AuthContext";

const Login = () => {
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleAzureLogin = async () => {
    try {
      setLoading(true);

      // Generate PKCE parameters
      const response = await fetch("/pkce/generate");
      const data = await response.json();

      if (data.success) {
        // Store code verifier for later use
        sessionStorage.setItem("codeVerifier", data.codeVerifier);

        // Redirect to Azure AD
        window.location.href = data.authorizationUrls.azureAD;
      }
    } catch (error) {
      console.error("Login failed:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCallback = async (code) => {
    try {
      setLoading(true);

      const codeVerifier = sessionStorage.getItem("codeVerifier");

      const response = await fetch("/auth/azure-crm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          codeVerifier,
        }),
      });

      const data = await response.json();

      if (data.success) {
        login(data.user, data.accessToken);
        // Redirect to dashboard
        window.location.href = "/dashboard";
      }
    } catch (error) {
      console.error("Callback failed:", error);
    } finally {
      setLoading(false);
    }
  };

  // Handle callback from URL parameters
  React.useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");

    if (code) {
      handleCallback(code);
    }
  }, []);

  return (
    <div className="login-container">
      <h1>Login</h1>
      <button
        onClick={handleAzureLogin}
        disabled={loading}
        className="btn-primary"
      >
        {loading ? "Logging in..." : "Login with Azure AD"}
      </button>
    </div>
  );
};

export default Login;
```

---

## 📊 **Advanced Features**

### **1. Permission Preloading**

```javascript
// Preload permissions on app startup
const usePermissionPreloader = () => {
  const { token } = useAuth();
  const [preloaded, setPreloaded] = useState(false);

  useEffect(() => {
    const preload = async () => {
      if (!token) return;

      const commonPermissions = [
        { resource: "portal", action: "read" },
        { resource: "crm", action: "read" },
        { resource: "user", action: "read" },
        { resource: "role", action: "read" },
      ];

      try {
        const requests = commonPermissions.map(({ resource, action }) => ({
          token,
          resource,
          action,
        }));

        await policyClient.evaluateBatch(requests);
        setPreloaded(true);
      } catch (error) {
        console.error("Failed to preload permissions:", error);
      }
    };

    preload();
  }, [token]);

  return preloaded;
};
```

### **2. Error Boundaries**

```javascript
// Error boundary for authorization failures
class AuthErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    if (
      error.message.includes("authorization") ||
      error.message.includes("permission")
    ) {
      return { hasError: true };
    }
    return null;
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-container">
          <h2>Authorization Error</h2>
          <p>You don't have permission to access this resource.</p>
          <button onClick={() => this.setState({ hasError: false })}>
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## 🚀 **Best Practices**

### **1. Performance Optimization**

- Use permission caching to reduce API calls
- Preload common permissions on app startup
- Implement lazy loading for permission-heavy components
- Use React.memo for components that check permissions frequently

### **2. Security Considerations**

- Always validate permissions on the server side
- Use HTTPS for all API calls
- Implement token refresh mechanisms
- Clear sensitive data on logout

### **3. Error Handling**

- Implement graceful degradation when policy service is unavailable
- Provide meaningful error messages to users
- Log authorization failures for monitoring
- Use error boundaries for authorization errors

---

## ✅ **Implementation Checklist**

- [ ] Install required dependencies
- [ ] Set up environment variables
- [ ] Create policy client utility
- [ ] Implement authentication context
- [ ] Create authorization hooks
- [ ] Set up protected routes
- [ ] Implement permission-based components
- [ ] Add error handling
- [ ] Test authentication flow
- [ ] Test permission checks
- [ ] Implement error boundaries
- [ ] Add performance optimizations

---

Your React application is now fully integrated with the centralized RBAC system! 🎉
