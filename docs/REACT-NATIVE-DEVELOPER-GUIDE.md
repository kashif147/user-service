# Implementation Guide for React Native Developers

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install @react-native-async-storage/async-storage
```

### 2. Copy SDK to Your Project

```bash
# Copy the React Native SDK to your project
cp /path/to/user-service/sdks/node-policy-client.js ./src/utils/policy-client.js
cp /path/to/user-service/sdks/react-native-policy-hooks.js ./src/hooks/policy-hooks.js
```

### 3. Environment Variables

Add to your `.env` file:

```bash
POLICY_SERVICE_URL=http://user-service:3000
```

## 🔧 Implementation Steps

### Step 1: Initialize Policy Client

```javascript
// src/utils/policy-client.js
import PolicyClient from "./policy-client";

const policy = new PolicyClient(
  process.env.POLICY_SERVICE_URL || "http://localhost:3000",
  {
    enableOfflineCache: true,
    cacheTimeout: 600000, // 10 minutes for mobile
    onTokenExpired: () => {
      // Navigate to login screen when token expires
      navigation.navigate("Login");
    },
  }
);

export default policy;
```

### Step 2: Replace Manual Permission Checks

**Before (Old Way):**

```javascript
import AsyncStorage from "@react-native-async-storage/async-storage";

function UserProfile({ user }) {
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);

  useEffect(() => {
    // Manual permission checking
    const checkPermissions = async () => {
      const permissions = await AsyncStorage.getItem("userPermissions");
      const parsedPermissions = JSON.parse(permissions || "[]");

      setCanEdit(parsedPermissions.includes("user:write"));
      setCanDelete(parsedPermissions.includes("user:delete"));
    };

    checkPermissions();
  }, []);

  return (
    <View>
      <Text>User Profile</Text>
      {canEdit && <Button title="Edit Profile" onPress={handleEdit} />}
      {canDelete && <Button title="Delete User" onPress={handleDelete} />}
    </View>
  );
}
```

**After (New Way):**

```javascript
import policy from "../utils/policy-client";

function UserProfile({ token }) {
  const {
    loading,
    authorized: canRead,
    cached,
  } = policy.useAuthorization(token, "user", "read");
  const { permissions } = policy.usePermissions(token, "user");

  if (loading) return <Text>Loading...</Text>;
  if (!canRead) return <Text>Access denied</Text>;

  const canEdit = permissions.includes("user:write");
  const canDelete = permissions.includes("user:delete");

  return (
    <View>
      <Text>User Profile</Text>
      {cached && <Text style={styles.cachedText}>Using cached data</Text>}
      {canEdit && <Button title="Edit Profile" onPress={handleEdit} />}
      {canDelete && <Button title="Delete User" onPress={handleDelete} />}
    </View>
  );
}
```

### Step 3: Navigation Protection

**Before:**

```javascript
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";

function AppNavigator({ user }) {
  const canAccessCRM =
    user.roles.includes("SU") || user.permissions.includes("crm:access");
  const canAccessAdmin = user.roles.includes("SU") || user.roles.includes("GS");

  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />

        {canAccessCRM && <Stack.Screen name="CRM" component={CRMScreen} />}

        {canAccessAdmin && (
          <Stack.Screen name="Admin" component={AdminScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

**After:**

```javascript
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import policy from "../utils/policy-client";

function AppNavigator({ token }) {
  const { authorized: canAccessCRM } = policy.useAuthorization(
    token,
    "crm",
    "read"
  );
  const { authorized: canAccessAdmin } = policy.useAuthorization(
    token,
    "admin",
    "read"
  );

  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />

        {canAccessCRM && <Stack.Screen name="CRM" component={CRMScreen} />}

        {canAccessAdmin && (
          <Stack.Screen name="Admin" component={AdminScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

## 📋 Common Patterns

### 1. Screen Protection

```javascript
// src/components/ProtectedScreen.jsx
import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import policy from "../utils/policy-client";

function ProtectedScreen({ token, resource, action, children, fallback }) {
  const { loading, authorized, cached } = policy.useAuthorization(
    token,
    resource,
    action
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text>Checking permissions...</Text>
      </View>
    );
  }

  if (!authorized) {
    return (
      fallback || (
        <View style={styles.center}>
          <Text>Access denied</Text>
        </View>
      )
    );
  }

  return (
    <View>
      {cached && (
        <Text style={styles.cachedIndicator}>Using cached permissions</Text>
      )}
      {children}
    </View>
  );
}

export default ProtectedScreen;
```

**Usage:**

```javascript
function AdminScreen({ token }) {
  return (
    <ProtectedScreen token={token} resource="admin" action="read">
      <View>
        <Text>Admin Panel Content</Text>
        <AdminActions token={token} />
      </View>
    </ProtectedScreen>
  );
}
```

### 2. Tab Navigation

```javascript
// src/navigation/TabNavigator.jsx
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import policy from "../utils/policy-client";

const Tab = createBottomTabNavigator();

function TabNavigator({ token }) {
  const { permissions: userPermissions } = policy.usePermissions(token, "user");
  const { permissions: crmPermissions } = policy.usePermissions(token, "crm");
  const { permissions: adminPermissions } = policy.usePermissions(
    token,
    "admin"
  );

  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} />

      {userPermissions.includes("user:read") && (
        <Tab.Screen name="Users" component={UsersScreen} />
      )}

      {crmPermissions.includes("crm:access") && (
        <Tab.Screen name="CRM" component={CRMScreen} />
      )}

      {adminPermissions.includes("admin:read") && (
        <Tab.Screen name="Admin" component={AdminScreen} />
      )}
    </Tab.Navigator>
  );
}
```

### 3. Action Buttons

```javascript
// src/components/UserActions.jsx
import React from "react";
import { View, Button, Alert } from "react-native";
import policy from "../utils/policy-client";

function UserActions({ token, userId }) {
  const { permissions } = policy.usePermissions(token, "user");

  const handleEdit = () => {
    // Navigate to edit screen
    navigation.navigate("EditUser", { userId });
  };

  const handleDelete = () => {
    Alert.alert("Delete User", "Are you sure you want to delete this user?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: deleteUser },
    ]);
  };

  return (
    <View style={styles.actionsContainer}>
      {permissions.includes("user:write") && (
        <Button title="Edit User" onPress={handleEdit} />
      )}

      {permissions.includes("user:delete") && (
        <Button title="Delete User" onPress={handleDelete} color="red" />
      )}

      {permissions.includes("user:manage_roles") && (
        <Button title="Manage Roles" onPress={() => setShowRoleModal(true)} />
      )}
    </View>
  );
}
```

### 4. Offline Permission Preloading

```javascript
// src/hooks/useOfflinePermissions.js
import { useState, useEffect } from "react";
import policy from "../utils/policy-client";

function useOfflinePermissions(token) {
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    async function preloadPermissions() {
      try {
        // Preload permissions for offline use
        const resources = ["user", "crm", "admin", "portal"];
        const result = await policy.preloadPermissions(token, resources);

        if (result.success) {
          const permissionsMap = {};
          Object.keys(result.results).forEach((resource) => {
            permissionsMap[resource] =
              result.results[resource].permissions || [];
          });
          setPermissions(permissionsMap);
        }
      } catch (error) {
        console.error("Failed to preload permissions:", error);
      } finally {
        setLoading(false);
      }
    }

    preloadPermissions();
  }, [token]);

  return { permissions, loading };
}

export default useOfflinePermissions;
```

**Usage:**

```javascript
function App() {
  const token = AsyncStorage.getItem("token");
  const { permissions, loading } = useOfflinePermissions(token);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text>Loading permissions...</Text>
      </View>
    );
  }

  return (
    <NavigationContainer>
      <AppNavigator token={token} permissions={permissions} />
    </NavigationContainer>
  );
}
```

### 5. Network Status Handling

```javascript
// src/hooks/useNetworkAwarePermissions.js
import { useState, useEffect } from "react";
import NetInfo from "@react-native-community/netinfo";
import policy from "../utils/policy-client";

function useNetworkAwarePermissions(token, resource, action) {
  const [isConnected, setIsConnected] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsConnected(state.isConnected);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    async function checkPermissions() {
      try {
        const result = await policy.evaluate(token, resource, action);
        setAuthorized(result.success);
        setCached(result.cached || false);
      } catch (error) {
        console.error("Permission check failed:", error);
        setAuthorized(false);
      } finally {
        setLoading(false);
      }
    }

    checkPermissions();
  }, [token, resource, action, isConnected]);

  return { authorized, cached, loading, isConnected };
}

export default useNetworkAwarePermissions;
```

## 🔄 Migration Checklist

- [ ] Install `@react-native-async-storage/async-storage`
- [ ] Copy `node-policy-client.js` and `react-native-policy-hooks.js` to your project
- [ ] Add environment variables
- [ ] Initialize PolicyClient with offline cache enabled
- [ ] Replace manual permission checks with hooks
- [ ] Update navigation components
- [ ] Implement offline permission preloading
- [ ] Add network status handling
- [ ] Test offline functionality
- [ ] Remove old permission checking logic

## 🧪 Testing

### Test Offline Functionality

```javascript
// Test offline permissions
import policy from "../utils/policy-client";

async function testOfflinePermissions() {
  const token = "your-jwt-token";

  // Preload permissions
  const result = await policy.preloadPermissions(token, ["user", "crm"]);
  console.log("Preload result:", result);

  // Test offline evaluation
  const offlineResult = await policy.evaluate(token, "user", "read");
  console.log("Offline result:", offlineResult);
}
```

### Test Network Handling

```javascript
// Test network-aware permissions
function TestNetworkPermissions({ token }) {
  const { authorized, cached, loading, isConnected } =
    useNetworkAwarePermissions(token, "user", "read");

  return (
    <View>
      <Text>Network: {isConnected ? "Connected" : "Offline"}</Text>
      <Text>Loading: {loading ? "Yes" : "No"}</Text>
      <Text>Authorized: {authorized ? "Yes" : "No"}</Text>
      <Text>Cached: {cached ? "Yes" : "No"}</Text>
    </View>
  );
}
```

## 🚨 Error Handling

### Token Expiration

```javascript
const policy = new PolicyClient("http://user-service:3000", {
  onTokenExpired: () => {
    // Clear token and navigate to login
    AsyncStorage.removeItem("token");
    navigation.reset({
      index: 0,
      routes: [{ name: "Login" }],
    });
  },
});
```

### Network Errors

```javascript
function UserProfile({ token }) {
  const { loading, authorized, error, cached } = policy.useAuthorization(
    token,
    "user",
    "read"
  );

  if (loading) return <ActivityIndicator size="large" />;

  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Failed to check permissions</Text>
        <Text style={styles.errorDetail}>{error}</Text>
        <Button title="Retry" onPress={() => window.location.reload()} />
      </View>
    );
  }

  if (!authorized) {
    return (
      <View style={styles.center}>
        <Text>Access denied</Text>
      </View>
    );
  }

  return (
    <View>
      {cached && (
        <Text style={styles.cachedText}>Using cached permissions</Text>
      )}
      <Text>User Profile Content</Text>
    </View>
  );
}
```

## 📊 Performance Optimization

### Permission Caching

```javascript
// Optimize permission checks with caching
function OptimizedUserList({ token }) {
  const { permissions } = policy.usePermissions(token, "user");
  const [users, setUsers] = useState([]);

  // Only fetch users if we have permission
  useEffect(() => {
    if (permissions.includes("user:read")) {
      fetchUsers().then(setUsers);
    }
  }, [permissions]);

  if (!permissions.includes("user:read")) {
    return <Text>No permission to view users</Text>;
  }

  return (
    <FlatList
      data={users}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <UserCard user={item} token={token} />}
    />
  );
}
```

### Lazy Loading

```javascript
import React, { lazy, Suspense } from "react";
import { View, ActivityIndicator } from "react-native";
import policy from "../utils/policy-client";

const AdminScreen = lazy(() => import("./AdminScreen"));
const CRMScreen = lazy(() => import("./CRMScreen"));

function App({ token }) {
  const { permissions: adminPermissions } = policy.usePermissions(
    token,
    "admin"
  );
  const { permissions: crmPermissions } = policy.usePermissions(token, "crm");

  return (
    <View>
      {adminPermissions.includes("admin:read") && (
        <Suspense fallback={<ActivityIndicator size="large" />}>
          <AdminScreen />
        </Suspense>
      )}

      {crmPermissions.includes("crm:access") && (
        <Suspense fallback={<ActivityIndicator size="large" />}>
          <CRMScreen />
        </Suspense>
      )}
    </View>
  );
}
```

## 🔧 Configuration Examples

### Development

```bash
POLICY_SERVICE_URL=http://localhost:3000
```

### Production

```bash
POLICY_SERVICE_URL=https://api.yourdomain.com
```

## 📞 Support

If you encounter issues:

1. Check React Native debugger for policy evaluation errors
2. Verify token is valid and not expired
3. Test offline functionality by disabling network
4. Check AsyncStorage for cached permissions
5. Monitor network requests in debugger

## 🎯 Benefits You'll Get

- **Offline Support**: App works with cached permissions when offline
- **Better Performance**: Cached policy decisions reduce API calls
- **Consistent Security**: Same authorization across all screens
- **Network Resilience**: Graceful handling of network issues
- **Better UX**: Loading states and cached data indicators
