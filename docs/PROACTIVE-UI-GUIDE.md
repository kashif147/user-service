# Proactive UI Authorization Guide

This guide shows how to build React applications where the UI is **proactively filtered** based on user permissions, rather than showing everything and checking permissions retroactively.

## 🎯 The Problem

**Traditional Approach (Reactive):**

```javascript
// ❌ Shows UI first, then checks permissions
function UserManagement() {
  return (
    <div>
      <button>Create User</button> {/* Always visible */}
      <button>Delete User</button> {/* Always visible */}
      {/* Checks permission after user clicks */}
      <PermissionCheck resource="user" action="write">
        <CreateUserForm />
      </PermissionCheck>
    </div>
  );
}
```

**Our Approach (Proactive):**

```javascript
// ✅ Only shows UI elements user is authorized to see
function UserManagement() {
  const { capabilities } = useAuth();

  return (
    <div>
      {/* Only shows if user has permission */}
      {capabilities.actions.users?.some((a) => a.action === "write") && (
        <button>Create User</button>
      )}

      {capabilities.actions.users?.some((a) => a.action === "delete") && (
        <button>Delete User</button>
      )}
    </div>
  );
}
```

## 🚀 Quick Start

### 1. Install and Initialize

```javascript
import UIAwarePolicyClient from "./sdks/react-ui-policy-client";
import { AuthProvider } from "./examples/complete-react-app-example";

// Wrap your app
function App() {
  return (
    <AuthProvider>
      <YourAppContent />
    </AuthProvider>
  );
}
```

### 2. Define Your UI Structure

```javascript
const uiConfig = {
  navigation: [
    {
      resource: "portal",
      action: "read",
      label: "Dashboard",
      path: "/dashboard",
    },
    { resource: "crm", action: "read", label: "CRM", path: "/crm" },
    { resource: "user", action: "read", label: "Users", path: "/users" },
  ],

  actions: {
    users: [
      { resource: "user", action: "read", label: "View Users" },
      { resource: "user", action: "write", label: "Create User" },
      { resource: "user", action: "delete", label: "Delete User" },
    ],
  },
};
```

### 3. Use Proactive Components

```javascript
function Dashboard() {
  const { ui } = useAuth();

  // Navigation is pre-filtered to only show accessible items
  const menuItems = ui.capabilities?.navigation || [];

  return (
    <div>
      <nav>
        {menuItems.map((item) => (
          <a key={item.resource} href={item.path}>
            {item.label}
          </a>
        ))}
      </nav>

      {/* Feature flags control entire sections */}
      {ui.featureFlags?.user_management && <UserManagementSection />}

      {ui.featureFlags?.system_admin && <AdminSection />}
    </div>
  );
}
```

## 📋 Implementation Steps

### Step 1: Login Flow with UI Initialization

```javascript
async function handleLogin(credentials) {
  // 1. Authenticate user
  const authResponse = await login(credentials);
  const { token, user } = authResponse;

  // 2. Initialize UI permissions (happens automatically in AuthProvider)
  // This makes a single API call to get ALL permissions upfront

  // 3. UI is built based on permissions
  // No more individual permission checks needed!
}
```

### Step 2: Navigation Component

```javascript
function Navigation() {
  const { ui } = useAuth();

  if (ui.loading) return <div>Loading menu...</div>;

  // Only shows navigation items user can access
  return (
    <nav>
      {ui.capabilities.navigation.map((item) => (
        <NavItem key={item.resource} {...item} />
      ))}
    </nav>
  );
}
```

### Step 3: Action Buttons

```javascript
function UserListPage() {
  const { ui } = useAuth();

  // Get available actions for this category
  const userActions = ui.capabilities.actions.users || [];

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>

        {/* Only show buttons for permitted actions */}
        {userActions.map((action) => (
          <ActionButton key={action.action} {...action} />
        ))}
      </div>

      <UserList />
    </div>
  );
}
```

### Step 4: Data Tables with Conditional Actions

```javascript
function UserTable({ users }) {
  const { ui } = useAuth();

  const canEdit = ui.permissions.user_write;
  const canDelete = ui.permissions.user_delete;

  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.email}</td>
            <td>
              <button>View</button>
              {canEdit && <button>Edit</button>}
              {canDelete && <button>Delete</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

## 🔧 API Integration

### Single UI Initialization Call

```javascript
// POST /policy/ui/initialize
const response = await fetch("/policy/ui/initialize", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    uiConfig: {
      navigation: [
        { resource: "portal", action: "read" },
        { resource: "crm", action: "read" },
        // ... all your UI elements
      ],
      actions: [
        { resource: "user", action: "read" },
        { resource: "user", action: "write" },
        // ... all possible actions
      ],
    },
  }),
});

const uiData = await response.json();
// Returns: permissions, capabilities, resourcePermissions, user info
```

### Response Structure

```javascript
{
  "success": true,
  "user": {
    "id": "user-123",
    "tenantId": "tenant-456",
    "roles": [{ "code": "MO", "name": "Membership Officer" }],
    "userType": "CRM"
  },
  "permissions": {
    "portal_read": true,
    "user_read": true,
    "user_write": true,
    "user_delete": false,
    "admin_read": false
  },
  "capabilities": {
    "navigation": [
      { "resource": "portal", "action": "read", "permitted": true },
      { "resource": "user", "action": "read", "permitted": true }
    ],
    "actions": [
      { "resource": "user", "action": "read", "permitted": true },
      { "resource": "user", "action": "write", "permitted": true }
    ],
    "stats": {
      "totalChecks": 15,
      "grantedPermissions": 8
    }
  },
  "resourcePermissions": {
    "user": ["USER_READ", "USER_WRITE"],
    "portal": ["PORTAL_ACCESS", "PORTAL_PROFILE_READ"]
  }
}
```

## 🎨 UI Patterns

### 1. Conditional Sections

```javascript
function Dashboard() {
  const { ui } = useAuth();

  return (
    <div>
      {/* Only show if user has any user management permissions */}
      {ui.capabilities.actions.users?.length > 0 && (
        <section>
          <h2>User Management</h2>
          <UserQuickActions />
        </section>
      )}

      {/* Only show if user is admin */}
      {ui.featureFlags.system_admin && <AdminPanel />}
    </div>
  );
}
```

### 2. Dynamic Menu Generation

```javascript
function generateMenu(capabilities) {
  return capabilities.navigation.map((nav) => ({
    id: nav.resource,
    label: nav.label || nav.resource.toUpperCase(),
    path: nav.path || `/${nav.resource}`,
    icon: getIconForResource(nav.resource),
    children: getSubMenuItems(nav.resource, capabilities),
  }));
}
```

### 3. Feature-Driven Components

```javascript
function AdvancedFeatures() {
  const { ui } = useAuth();

  return (
    <div>
      {ui.featureFlags.bulk_operations && <BulkActionsPanel />}
      {ui.featureFlags.advanced_reporting && <ReportsPanel />}
      {ui.featureFlags.system_integration && <IntegrationPanel />}
    </div>
  );
}
```

## ⚡ Performance Benefits

### Before (Reactive)

- **Multiple API calls**: Each component checks permissions individually
- **UI flickering**: Components render, then hide based on permissions
- **Network overhead**: Repeated permission checks
- **Poor UX**: Loading states everywhere

### After (Proactive)

- **Single API call**: All permissions loaded upfront
- **Clean UI**: Only authorized elements render
- **Better caching**: All permissions cached together
- **Smooth UX**: No permission-related loading states

## 🔍 Debugging

### Check User Capabilities

```javascript
function DebugPanel() {
  const { ui } = useAuth();

  return (
    <details>
      <summary>Debug: User Capabilities</summary>
      <pre>{JSON.stringify(ui.capabilities, null, 2)}</pre>

      <h4>Permissions:</h4>
      <ul>
        {Object.entries(ui.permissions).map(([key, value]) => (
          <li key={key} style={{ color: value ? "green" : "red" }}>
            {key}: {value ? "✅" : "❌"}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

### Log Permission Checks

```javascript
// Add to your policy client
console.log("🔄 Initializing UI with", requests.length, "permission checks");
console.log("✅ User has access to", navigation.length, "navigation items");
console.log("🎯 Available actions:", Object.keys(actions).join(", "));
```

## 🎯 Best Practices

1. **Define UI structure upfront**: Map all possible UI elements to permissions
2. **Use feature flags**: Control entire features/sections with single flags
3. **Cache aggressively**: UI permissions change infrequently
4. **Fail securely**: Default to hiding elements when in doubt
5. **Progressive disclosure**: Show more options as user gains permissions
6. **Consistent patterns**: Use same permission structure across components

This approach gives you a **permission-aware UI** that's **fast**, **secure**, and provides an **excellent user experience** by only showing what users can actually use!
