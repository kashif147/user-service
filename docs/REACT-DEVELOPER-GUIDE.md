# Implementation Guide for React.js Developers

## 🚀 Quick Start

### 1. Copy SDK to Your Project

```bash
# Copy the React SDK to your project
cp /path/to/user-service/sdks/node-policy-client.js ./src/utils/policy-client.js
cp /path/to/user-service/sdks/react-policy-hooks.js ./src/hooks/policy-hooks.js
```

### 2. Install Dependencies (if needed)

```bash
# If you don't have React hooks
npm install react
```

## 🔧 Implementation Steps

### Step 1: Initialize Policy Client

```javascript
// src/utils/policy-client.js
import PolicyClient from "./policy-client";

const policy = new PolicyClient(
  process.env.REACT_APP_POLICY_SERVICE_URL || "http://localhost:3000",
  {
    onTokenExpired: () => {
      // Redirect to login when token expires
      window.location.href = "/login";
    },
  }
);

export default policy;
```

### Step 2: Environment Variables

Add to your `.env` file:

```bash
REACT_APP_POLICY_SERVICE_URL=http://user-service:3000
```

### Step 3: Replace Manual Permission Checks

**Before (Old Way):**

```javascript
function UserProfile({ user }) {
  // Manual permission checking
  const canEdit =
    user.roles.includes("SU") || user.permissions.includes("user:write");
  const canDelete =
    user.roles.includes("SU") || user.permissions.includes("user:delete");

  return (
    <div>
      <h1>User Profile</h1>
      {canEdit && <button>Edit Profile</button>}
      {canDelete && <button>Delete User</button>}
    </div>
  );
}
```

**After (New Way):**

```javascript
import policy from "../utils/policy-client";

function UserProfile({ token }) {
  const { loading, authorized: canRead } = policy.useAuthorization(
    token,
    "user",
    "read"
  );
  const { permissions } = policy.usePermissions(token, "user");

  if (loading) return <div>Loading...</div>;
  if (!canRead) return <div>Access denied</div>;

  const canEdit = permissions.includes("user:write");
  const canDelete = permissions.includes("user:delete");

  return (
    <div>
      <h1>User Profile</h1>
      {canEdit && <button>Edit Profile</button>}
      {canDelete && <button>Delete User</button>}
    </div>
  );
}
```

### Step 4: Conditional Rendering

**Before:**

```javascript
function AdminPanel({ user }) {
  if (!user.roles.includes("SU") && !user.roles.includes("GS")) {
    return <div>Access denied</div>;
  }

  return <div>Admin Panel Content</div>;
}
```

**After:**

```javascript
import policy from "../utils/policy-client";

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
```

## 📋 Common Patterns

### 1. Route Protection

```javascript
// src/components/ProtectedRoute.jsx
import React from "react";
import { Redirect } from "react-router-dom";
import policy from "../utils/policy-client";

function ProtectedRoute({ token, resource, action, children }) {
  const { loading, authorized } = policy.useAuthorization(
    token,
    resource,
    action
  );

  if (loading) return <div>Loading...</div>;

  return authorized ? children : <Redirect to="/unauthorized" />;
}

export default ProtectedRoute;
```

**Usage in Router:**

```javascript
import ProtectedRoute from "./components/ProtectedRoute";

function App() {
  const token = localStorage.getItem("token");

  return (
    <Router>
      <Route
        path="/admin"
        render={() => (
          <ProtectedRoute token={token} resource="admin" action="read">
            <AdminPanel />
          </ProtectedRoute>
        )}
      />

      <Route
        path="/crm"
        render={() => (
          <ProtectedRoute token={token} resource="crm" action="read">
            <CRMPanel />
          </ProtectedRoute>
        )}
      />
    </Router>
  );
}
```

### 2. Navigation Menu

```javascript
// src/components/Navigation.jsx
import React from "react";
import policy from "../utils/policy-client";

function Navigation({ token }) {
  const { permissions: userPermissions } = policy.usePermissions(token, "user");
  const { permissions: crmPermissions } = policy.usePermissions(token, "crm");
  const { permissions: adminPermissions } = policy.usePermissions(
    token,
    "admin"
  );

  return (
    <nav>
      <ul>
        <li>
          <Link to="/dashboard">Dashboard</Link>
        </li>

        {userPermissions.includes("user:read") && (
          <li>
            <Link to="/users">Users</Link>
          </li>
        )}

        {crmPermissions.includes("crm:access") && (
          <li>
            <Link to="/crm">CRM</Link>
          </li>
        )}

        {adminPermissions.includes("admin:read") && (
          <li>
            <Link to="/admin">Admin</Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
```

### 3. Action Buttons

```javascript
// src/components/UserActions.jsx
import React from "react";
import policy from "../utils/policy-client";

function UserActions({ token, userId }) {
  const { permissions } = policy.usePermissions(token, "user");

  const handleEdit = () => {
    // Edit logic
  };

  const handleDelete = () => {
    // Delete logic
  };

  return (
    <div className="user-actions">
      {permissions.includes("user:write") && (
        <button onClick={handleEdit}>Edit User</button>
      )}

      {permissions.includes("user:delete") && (
        <button onClick={handleDelete} className="danger">
          Delete User
        </button>
      )}

      {permissions.includes("user:manage_roles") && (
        <button onClick={() => setShowRoleModal(true)}>Manage Roles</button>
      )}
    </div>
  );
}
```

### 4. Batch Permission Loading

```javascript
// src/hooks/useUserPermissions.js
import { useState, useEffect } from "react";
import policy from "../utils/policy-client";

function useUserPermissions(token) {
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    async function loadPermissions() {
      const resources = ["user", "crm", "admin", "portal"];
      const results = {};

      for (const resource of resources) {
        try {
          const result = await policy.getPermissions(token, resource);
          results[resource] = result.success ? result.permissions : [];
        } catch (error) {
          results[resource] = [];
        }
      }

      setPermissions(results);
      setLoading(false);
    }

    loadPermissions();
  }, [token]);

  return { permissions, loading };
}

export default useUserPermissions;
```

**Usage:**

```javascript
function App() {
  const token = localStorage.getItem("token");
  const { permissions, loading } = useUserPermissions(token);

  if (loading) return <div>Loading permissions...</div>;

  return (
    <div>
      {permissions.user.includes("user:read") && <UserList />}
      {permissions.crm.includes("crm:access") && <CRMPanel />}
      {permissions.admin.includes("admin:read") && <AdminPanel />}
    </div>
  );
}
```

## 🔄 Migration Checklist

- [ ] Copy `node-policy-client.js` and `react-policy-hooks.js` to your project
- [ ] Add environment variables
- [ ] Initialize PolicyClient with token expiration handler
- [ ] Replace manual role/permission checks with hooks
- [ ] Update route protection components
- [ ] Replace conditional rendering with `AuthorizedComponent`
- [ ] Update navigation menus
- [ ] Test all permission-based UI elements
- [ ] Remove old permission checking logic

## 🧪 Testing

### Test Policy Hooks

```javascript
// Test component
import React from "react";
import policy from "../utils/policy-client";

function TestComponent() {
  const token = "your-jwt-token";
  const { loading, authorized, error } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  return (
    <div>
      <h3>Policy Test</h3>
      <p>Loading: {loading ? "Yes" : "No"}</p>
      <p>Authorized: {authorized ? "Yes" : "No"}</p>
      {error && <p>Error: {error}</p>}
    </div>
  );
}
```

### Test Conditional Rendering

```javascript
function TestConditionalRendering() {
  const token = "your-jwt-token";

  return (
    <div>
      <policy.AuthorizedComponent
        token={token}
        resource="user"
        action="read"
        fallback={<div>No access to users</div>}
      >
        <div>You can see users!</div>
      </policy.AuthorizedComponent>
    </div>
  );
}
```

## 🚨 Error Handling

### Token Expiration

```javascript
const policy = new PolicyClient("http://user-service:3000", {
  onTokenExpired: () => {
    // Clear token and redirect to login
    localStorage.removeItem("token");
    window.location.href = "/login";
  },
});
```

### Network Errors

```javascript
function UserProfile({ token }) {
  const { loading, authorized, error } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  if (loading) return <div>Loading...</div>;

  if (error) {
    return (
      <div className="error">
        <p>Failed to check permissions: {error}</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  if (!authorized) {
    return <div>Access denied</div>;
  }

  return <div>User Profile Content</div>;
}
```

## 📊 Performance Optimization

### Memoization

```javascript
import React, { useMemo } from "react";
import policy from "../utils/policy-client";

function UserList({ token, users }) {
  const { permissions } = policy.usePermissions(token, "user");

  // Memoize filtered users based on permissions
  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      if (permissions.includes("*")) return true;
      return permissions.includes("user:read");
    });
  }, [users, permissions]);

  return (
    <div>
      {filteredUsers.map((user) => (
        <UserCard key={user.id} user={user} token={token} />
      ))}
    </div>
  );
}
```

### Lazy Loading

```javascript
import React, { lazy, Suspense } from "react";
import policy from "../utils/policy-client";

const AdminPanel = lazy(() => import("./AdminPanel"));
const CRMPanel = lazy(() => import("./CRMPanel"));

function App({ token }) {
  const { permissions: adminPermissions } = policy.usePermissions(
    token,
    "admin"
  );
  const { permissions: crmPermissions } = policy.usePermissions(token, "crm");

  return (
    <div>
      {adminPermissions.includes("admin:read") && (
        <Suspense fallback={<div>Loading admin panel...</div>}>
          <AdminPanel />
        </Suspense>
      )}

      {crmPermissions.includes("crm:access") && (
        <Suspense fallback={<div>Loading CRM panel...</div>}>
          <CRMPanel />
        </Suspense>
      )}
    </div>
  );
}
```

## 🔧 Configuration Examples

### Development

```bash
REACT_APP_POLICY_SERVICE_URL=http://localhost:3000
```

### Production

```bash
REACT_APP_POLICY_SERVICE_URL=https://api.yourdomain.com
```

## 📞 Support

If you encounter issues:

1. Check browser console for policy evaluation errors
2. Verify token is valid and not expired
3. Check network tab for policy service requests
4. Test with different user roles/permissions

## 🎯 Benefits You'll Get

- **Cleaner Components**: No more complex permission logic in components
- **Better UX**: Automatic loading states and error handling
- **Consistent Security**: Same authorization across all components
- **Easy Testing**: Mock policy responses for testing
- **Real-time Updates**: Permissions update when user changes
