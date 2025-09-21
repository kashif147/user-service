# RBAC React Native Integration Guide

## 🎯 **React Native Integration with Centralized RBAC**

This guide shows how to integrate your React Native applications with the centralized RBAC user-service for authentication and authorization, including offline support and secure token storage.

---

## 📦 **Installation & Setup**

### **1. Install Dependencies**

```bash
npm install axios @react-native-async-storage/async-storage @react-native-community/netinfo
# or
yarn add axios @react-native-async-storage/async-storage @react-native-community/netinfo
```

### **2. iOS Setup (if using AsyncStorage)**

Add to `ios/Podfile`:

```ruby
pod 'RNCAsyncStorage', :path => '../node_modules/@react-native-async-storage/async-storage'
```

Then run:

```bash
cd ios && pod install
```

### **3. Android Setup**

Add to `android/app/src/main/java/.../MainApplication.java`:

```java
import com.reactnativecommunity.asyncstorage.AsyncStoragePackage;
```

### **4. Environment Configuration**

Create `.env` file in your React Native project:

```env
REACT_NATIVE_USER_SERVICE_URL=http://localhost:3000
REACT_NATIVE_TENANT_ID=your-tenant-id
```

---

## 🔧 **Core Integration Components**

### **1. Policy Client with Offline Support**

Create `src/utils/policyClient.js`:

```javascript
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";

class PolicyClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
    this.offlineCacheTimeout = 24 * 60 * 60 * 1000; // 24 hours for offline
  }

  async evaluatePolicy(token, resource, action, context = {}) {
    // Check network connectivity
    const netInfo = await NetInfo.fetch();
    const isOnline = netInfo.isConnected && netInfo.isInternetReachable;

    if (!isOnline) {
      // Return cached result if offline
      return await this.getCachedResult(token, resource, action);
    }

    const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;

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
          timeout: 10000, // 10 second timeout
        }
      );

      const result = response.data;

      // Cache for offline use
      await this.cacheResult(cacheKey, result);

      return result;
    } catch (error) {
      console.error("Policy evaluation failed:", error);
      // Fallback to cached result
      return await this.getCachedResult(token, resource, action);
    }
  }

  async cacheResult(key, result) {
    try {
      await AsyncStorage.setItem(
        `policy_${key}`,
        JSON.stringify({
          result,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      console.error("Failed to cache policy result:", error);
    }
  }

  async getCachedResult(token, resource, action) {
    try {
      const cacheKey = `${token.substring(0, 8)}:${resource}:${action}`;
      const cached = await AsyncStorage.getItem(`policy_${cacheKey}`);

      if (cached) {
        const { result, timestamp } = JSON.parse(cached);
        const isOffline = (await NetInfo.fetch()).isConnected === false;
        const timeout = isOffline
          ? this.offlineCacheTimeout
          : this.cacheTimeout;

        if (Date.now() - timestamp < timeout) {
          return { ...result, cached: true, offline: isOffline };
        }
      }

      // Default deny if no cache
      return {
        success: false,
        decision: "DENY",
        reason: "NO_CACHE_OFFLINE",
      };
    } catch (error) {
      console.error("Failed to get cached result:", error);
      return {
        success: false,
        decision: "DENY",
        reason: "CACHE_ERROR",
      };
    }
  }

  async getPermissions(token, resource) {
    const netInfo = await NetInfo.fetch();

    if (!netInfo.isConnected) {
      return await this.getCachedPermissions(resource);
    }

    try {
      const response = await axios.get(
        `${this.baseURL}/policy/permissions/${resource}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      // Cache permissions
      await this.cachePermissions(resource, response.data);

      return response.data;
    } catch (error) {
      console.error("Failed to get permissions:", error);
      return await this.getCachedPermissions(resource);
    }
  }

  async cachePermissions(resource, data) {
    try {
      await AsyncStorage.setItem(
        `permissions_${resource}`,
        JSON.stringify({
          data,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      console.error("Failed to cache permissions:", error);
    }
  }

  async getCachedPermissions(resource) {
    try {
      const cached = await AsyncStorage.getItem(`permissions_${resource}`);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < this.offlineCacheTimeout) {
          return { ...data, cached: true };
        }
      }
      return { success: false, permissions: [] };
    } catch (error) {
      console.error("Failed to get cached permissions:", error);
      return { success: false, permissions: [] };
    }
  }

  async evaluateBatch(requests) {
    const netInfo = await NetInfo.fetch();

    if (!netInfo.isConnected) {
      return await this.getCachedBatchResults(requests);
    }

    try {
      const response = await axios.post(
        `${this.baseURL}/policy/evaluate-batch`,
        { requests },
        {
          headers: {
            Authorization: `Bearer ${requests[0]?.token}`,
          },
          timeout: 15000,
        }
      );

      // Cache batch results
      await this.cacheBatchResults(requests, response.data);

      return response.data;
    } catch (error) {
      console.error("Batch evaluation failed:", error);
      return await this.getCachedBatchResults(requests);
    }
  }

  async cacheBatchResults(requests, data) {
    try {
      const batchKey = requests
        .map((r) => `${r.resource}:${r.action}`)
        .join("|");
      await AsyncStorage.setItem(
        `batch_${batchKey}`,
        JSON.stringify({
          data,
          timestamp: Date.now(),
        })
      );
    } catch (error) {
      console.error("Failed to cache batch results:", error);
    }
  }

  async getCachedBatchResults(requests) {
    try {
      const batchKey = requests
        .map((r) => `${r.resource}:${r.action}`)
        .join("|");
      const cached = await AsyncStorage.getItem(`batch_${batchKey}`);

      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < this.offlineCacheTimeout) {
          return { ...data, cached: true };
        }
      }

      // Return default deny for all requests
      return {
        success: true,
        results: requests.map(() => ({
          success: false,
          decision: "DENY",
          reason: "NO_CACHE_OFFLINE",
        })),
        cached: true,
      };
    } catch (error) {
      console.error("Failed to get cached batch results:", error);
      return { success: false, results: [] };
    }
  }

  // Clear all caches
  async clearCache() {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const policyKeys = keys.filter(
        (key) =>
          key.startsWith("policy_") ||
          key.startsWith("permissions_") ||
          key.startsWith("batch_")
      );
      await AsyncStorage.multiRemove(policyKeys);
    } catch (error) {
      console.error("Failed to clear cache:", error);
    }
  }

  // Get cache statistics
  async getCacheStats() {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const policyKeys = keys.filter(
        (key) =>
          key.startsWith("policy_") ||
          key.startsWith("permissions_") ||
          key.startsWith("batch_")
      );

      return {
        totalKeys: policyKeys.length,
        policyKeys: policyKeys.filter((k) => k.startsWith("policy_")).length,
        permissionKeys: policyKeys.filter((k) => k.startsWith("permissions_"))
          .length,
        batchKeys: policyKeys.filter((k) => k.startsWith("batch_")).length,
      };
    } catch (error) {
      console.error("Failed to get cache stats:", error);
      return { totalKeys: 0 };
    }
  }
}

export const policyClient = new PolicyClient(
  process.env.REACT_NATIVE_USER_SERVICE_URL
);
```

### **2. Secure Token Storage**

Create `src/utils/tokenStorage.js`:

```javascript
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

class TokenStorage {
  constructor() {
    this.tokenKey = "auth_token";
    this.userKey = "user_data";
    this.refreshKey = "refresh_token";
  }

  async storeToken(token) {
    try {
      await AsyncStorage.setItem(this.tokenKey, token);
    } catch (error) {
      console.error("Failed to store token:", error);
      throw error;
    }
  }

  async getToken() {
    try {
      return await AsyncStorage.getItem(this.tokenKey);
    } catch (error) {
      console.error("Failed to get token:", error);
      return null;
    }
  }

  async removeToken() {
    try {
      await AsyncStorage.removeItem(this.tokenKey);
    } catch (error) {
      console.error("Failed to remove token:", error);
    }
  }

  async storeUser(user) {
    try {
      await AsyncStorage.setItem(this.userKey, JSON.stringify(user));
    } catch (error) {
      console.error("Failed to store user:", error);
      throw error;
    }
  }

  async getUser() {
    try {
      const user = await AsyncStorage.getItem(this.userKey);
      return user ? JSON.parse(user) : null;
    } catch (error) {
      console.error("Failed to get user:", error);
      return null;
    }
  }

  async removeUser() {
    try {
      await AsyncStorage.removeItem(this.userKey);
    } catch (error) {
      console.error("Failed to remove user:", error);
    }
  }

  async storeRefreshToken(token) {
    try {
      await AsyncStorage.setItem(this.refreshKey, token);
    } catch (error) {
      console.error("Failed to store refresh token:", error);
      throw error;
    }
  }

  async getRefreshToken() {
    try {
      return await AsyncStorage.getItem(this.refreshKey);
    } catch (error) {
      console.error("Failed to get refresh token:", error);
      return null;
    }
  }

  async removeRefreshToken() {
    try {
      await AsyncStorage.removeItem(this.refreshKey);
    } catch (error) {
      console.error("Failed to remove refresh token:", error);
    }
  }

  async clearAll() {
    try {
      await AsyncStorage.multiRemove([
        this.tokenKey,
        this.userKey,
        this.refreshKey,
      ]);
    } catch (error) {
      console.error("Failed to clear all tokens:", error);
    }
  }

  // Check if token is expired
  isTokenExpired(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      const now = Math.floor(Date.now() / 1000);
      return payload.exp && payload.exp < now;
    } catch (error) {
      return true;
    }
  }

  // Get token expiration time
  getTokenExpiration(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return payload.exp ? new Date(payload.exp * 1000) : null;
    } catch (error) {
      return null;
    }
  }
}

export const tokenStorage = new TokenStorage();
```

### **3. Authentication Context**

Create `src/contexts/AuthContext.js`:

```javascript
import React, { createContext, useContext, useState, useEffect } from "react";
import { tokenStorage } from "../utils/tokenStorage";
import { policyClient } from "../utils/policyClient";
import NetInfo from "@react-native-community/netinfo";

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
  const [token, setToken] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);

  // Monitor network connectivity
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(state.isConnected && state.isInternetReachable);
    });

    return unsubscribe;
  }, []);

  // Initialize user from stored token
  useEffect(() => {
    initializeAuth();
  }, []);

  const initializeAuth = async () => {
    try {
      setLoading(true);

      const storedToken = await tokenStorage.getToken();
      const storedUser = await tokenStorage.getUser();

      if (storedToken && storedUser) {
        // Check if token is expired
        if (tokenStorage.isTokenExpired(storedToken)) {
          // Try to refresh token
          const refreshed = await refreshToken();
          if (!refreshed) {
            await logout();
            return;
          }
        } else {
          setToken(storedToken);
          setUser(storedUser);

          // Preload permissions
          await preloadPermissions();
        }
      }
    } catch (error) {
      console.error("Failed to initialize auth:", error);
      await logout();
    } finally {
      setLoading(false);
    }
  };

  const refreshToken = async () => {
    try {
      const refreshTokenValue = await tokenStorage.getRefreshToken();
      if (!refreshTokenValue) return false;

      // Call your refresh token endpoint
      const response = await fetch("/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          refreshToken: refreshTokenValue,
        }),
      });

      const data = await response.json();

      if (data.success) {
        await tokenStorage.storeToken(data.accessToken);
        await tokenStorage.storeRefreshToken(data.refreshToken);
        setToken(data.accessToken);
        return true;
      }

      return false;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      return false;
    }
  };

  const preloadPermissions = async () => {
    if (!token) return;

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

  const login = async (userData, authToken, refreshTokenValue) => {
    try {
      await tokenStorage.storeToken(authToken);
      await tokenStorage.storeUser(userData);
      if (refreshTokenValue) {
        await tokenStorage.storeRefreshToken(refreshTokenValue);
      }

      setUser(userData);
      setToken(authToken);

      // Preload permissions
      await preloadPermissions();
    } catch (error) {
      console.error("Failed to login:", error);
      throw error;
    }
  };

  const logout = async () => {
    try {
      await tokenStorage.clearAll();
      await policyClient.clearCache();

      setUser(null);
      setToken(null);
      setPermissions({});
    } catch (error) {
      console.error("Failed to logout:", error);
    }
  };

  const checkPermission = async (resource, action, context = {}) => {
    if (!token) return false;

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
    }
  };

  const hasPermission = (resource, action) => {
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
    isOnline,
    login,
    logout,
    checkPermission,
    hasPermission,
    refreshToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
```

---

## 🛡️ **Navigation Protection**

### **1. Protected Screen Component**

Create `src/components/ProtectedScreen.jsx`:

```javascript
import React, { useState, useEffect } from "react";
import { View, Text, ActivityIndicator, Alert } from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { useAuthorization } from "../hooks/useAuthorization";

const ProtectedScreen = ({
  children,
  requiredResource,
  requiredAction,
  fallbackComponent,
  loadingComponent,
}) => {
  const { user, token, isOnline } = useAuth();
  const { checkPermission } = useAuthorization();
  const [authorized, setAuthorized] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      if (!token) {
        setAuthorized(false);
        setLoading(false);
        return;
      }

      if (!requiredResource || !requiredAction) {
        setAuthorized(true);
        setLoading(false);
        return;
      }

      try {
        const hasPermission = await checkPermission(
          requiredResource,
          requiredAction
        );
        setAuthorized(hasPermission);
      } catch (error) {
        console.error("Permission check failed:", error);
        setAuthorized(false);
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [token, requiredResource, requiredAction, checkPermission]);

  if (loading) {
    return (
      loadingComponent || (
        <View
          style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
        >
          <ActivityIndicator size="large" />
          <Text>Checking permissions...</Text>
        </View>
      )
    );
  }

  if (!authorized) {
    if (fallbackComponent) {
      return fallbackComponent;
    }

    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>You don't have permission to access this screen.</Text>
        {!isOnline && (
          <Text style={{ color: "orange", marginTop: 10 }}>
            You're offline. Some features may be limited.
          </Text>
        )}
      </View>
    );
  }

  return children;
};

export default ProtectedScreen;
```

### **2. Navigation Setup**

```javascript
// App.js
import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { AuthProvider } from "./src/contexts/AuthContext";
import ProtectedScreen from "./src/components/ProtectedScreen";
import LoginScreen from "./src/screens/LoginScreen";
import DashboardScreen from "./src/screens/DashboardScreen";
import UserManagementScreen from "./src/screens/UserManagementScreen";

const Stack = createStackNavigator();

function App() {
  return (
    <AuthProvider>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Login" component={LoginScreen} />

          <Stack.Screen name="Dashboard">
            {() => (
              <ProtectedScreen requiredResource="portal" requiredAction="read">
                <DashboardScreen />
              </ProtectedScreen>
            )}
          </Stack.Screen>

          <Stack.Screen name="UserManagement">
            {() => (
              <ProtectedScreen requiredResource="user" requiredAction="read">
                <UserManagementScreen />
              </ProtectedScreen>
            )}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
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
import { TouchableOpacity, Text, ActivityIndicator } from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { useAuthorization } from "../hooks/useAuthorization";

const PermissionButton = ({
  resource,
  action,
  context = {},
  children,
  onPress,
  disabled = false,
  style,
  textStyle,
  ...props
}) => {
  const { hasPermission, isOnline } = useAuth();
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
      <TouchableOpacity disabled style={[style, { opacity: 0.5 }]} {...props}>
        <ActivityIndicator size="small" />
        <Text style={textStyle}>Loading...</Text>
      </TouchableOpacity>
    );
  }

  if (!hasAccess) {
    return null; // Don't render button if no permission
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        style,
        disabled && { opacity: 0.5 },
        !isOnline && { opacity: 0.7 },
      ]}
      {...props}
    >
      <Text style={textStyle}>{children}</Text>
      {!isOnline && (
        <Text style={{ fontSize: 10, color: "orange" }}>Offline</Text>
      )}
    </TouchableOpacity>
  );
};

export default PermissionButton;
```

### **2. Offline Indicator**

Create `src/components/OfflineIndicator.jsx`:

```javascript
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useAuth } from "../contexts/AuthContext";

const OfflineIndicator = () => {
  const { isOnline } = useAuth();

  if (isOnline) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        You're offline. Some features may be limited.
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#ff9800",
    padding: 10,
    alignItems: "center",
  },
  text: {
    color: "white",
    fontSize: 14,
    fontWeight: "bold",
  },
});

export default OfflineIndicator;
```

---

## 🔄 **Authentication Flow**

### **1. Login Screen**

Create `src/screens/LoginScreen.jsx`:

```javascript
import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useAuth } from "../contexts/AuthContext";
import { tokenStorage } from "../utils/tokenStorage";

const LoginScreen = ({ navigation }) => {
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
        await tokenStorage.storeToken(data.codeVerifier);

        // Open Azure AD in browser
        const { Linking } = require("react-native");
        await Linking.openURL(data.authorizationUrls.azureAD);
      }
    } catch (error) {
      console.error("Login failed:", error);
      Alert.alert("Login Failed", "Unable to start login process");
    } finally {
      setLoading(false);
    }
  };

  const handleDeepLink = async (url) => {
    try {
      const urlParams = new URLSearchParams(url.split("?")[1]);
      const code = urlParams.get("code");

      if (code) {
        const codeVerifier = await tokenStorage.getToken();

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
          await login(data.user, data.accessToken, data.refreshToken);
          navigation.navigate("Dashboard");
        } else {
          Alert.alert("Login Failed", data.message);
        }
      }
    } catch (error) {
      console.error("Callback failed:", error);
      Alert.alert("Login Failed", "Unable to complete login");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Login</Text>
      <TouchableOpacity
        style={styles.loginButton}
        onPress={handleAzureLogin}
        disabled={loading}
      >
        <Text style={styles.buttonText}>
          {loading ? "Logging in..." : "Login with Azure AD"}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 30,
  },
  loginButton: {
    backgroundColor: "#0078d4",
    padding: 15,
    borderRadius: 5,
    minWidth: 200,
    alignItems: "center",
  },
  buttonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
  },
});

export default LoginScreen;
```

### **2. Deep Link Handling**

Create `src/utils/deepLinkHandler.js`:

```javascript
import { Linking } from "react-native";

class DeepLinkHandler {
  constructor() {
    this.listeners = [];
  }

  addListener(callback) {
    this.listeners.push(callback);
  }

  removeListener(callback) {
    this.listeners = this.listeners.filter((listener) => listener !== callback);
  }

  handleUrl(url) {
    this.listeners.forEach((listener) => listener(url));
  }

  async initialize() {
    // Handle initial URL
    const initialUrl = await Linking.getInitialURL();
    if (initialUrl) {
      this.handleUrl(initialUrl);
    }

    // Handle URL changes
    Linking.addEventListener("url", ({ url }) => {
      this.handleUrl(url);
    });
  }
}

export const deepLinkHandler = new DeepLinkHandler();
```

---

## 📊 **Advanced Features**

### **1. Background Sync**

Create `src/utils/backgroundSync.js`:

```javascript
import { AppState } from "react-native";
import { policyClient } from "./policyClient";
import { tokenStorage } from "./tokenStorage";

class BackgroundSync {
  constructor() {
    this.syncInterval = null;
    this.isSyncing = false;
  }

  start() {
    // Sync when app becomes active
    AppState.addEventListener("change", this.handleAppStateChange);

    // Periodic sync every 5 minutes
    this.syncInterval = setInterval(() => {
      this.syncPermissions();
    }, 5 * 60 * 1000);
  }

  stop() {
    AppState.removeEventListener("change", this.handleAppStateChange);

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  handleAppStateChange = (nextAppState) => {
    if (nextAppState === "active") {
      this.syncPermissions();
    }
  };

  async syncPermissions() {
    if (this.isSyncing) return;

    try {
      this.isSyncing = true;

      const token = await tokenStorage.getToken();
      if (!token) return;

      // Sync common permissions
      const resources = ["portal", "crm", "user", "role"];

      for (const resource of resources) {
        await policyClient.getPermissions(token, resource);
      }

      console.log("Background sync completed");
    } catch (error) {
      console.error("Background sync failed:", error);
    } finally {
      this.isSyncing = false;
    }
  }
}

export const backgroundSync = new BackgroundSync();
```

### **2. Error Boundary**

Create `src/components/AuthErrorBoundary.jsx`:

```javascript
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

class AuthErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    if (
      error.message.includes("authorization") ||
      error.message.includes("permission")
    ) {
      return { hasError: true, error };
    }
    return null;
  }

  componentDidCatch(error, errorInfo) {
    console.error("Auth Error Boundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Authorization Error</Text>
          <Text style={styles.message}>
            You don't have permission to access this resource.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ hasError: false })}
          >
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 10,
  },
  message: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 20,
  },
  button: {
    backgroundColor: "#0078d4",
    padding: 10,
    borderRadius: 5,
  },
  buttonText: {
    color: "white",
    fontSize: 16,
  },
});

export default AuthErrorBoundary;
```

---

## 🚀 **Best Practices**

### **1. Performance Optimization**

- Use AsyncStorage for offline caching
- Implement background sync for permissions
- Use React.memo for permission-heavy components
- Implement lazy loading for screens

### **2. Security Considerations**

- Store tokens securely using AsyncStorage
- Implement token refresh mechanisms
- Clear sensitive data on logout
- Use HTTPS for all API calls

### **3. Offline Support**

- Cache permissions for offline use
- Show offline indicators
- Graceful degradation when offline
- Sync when connection is restored

### **4. Error Handling**

- Implement error boundaries for auth errors
- Provide meaningful error messages
- Log errors for debugging
- Handle network failures gracefully

---

## ✅ **Implementation Checklist**

- [ ] Install required dependencies
- [ ] Set up AsyncStorage and NetInfo
- [ ] Create policy client with offline support
- [ ] Implement secure token storage
- [ ] Create authentication context
- [ ] Set up navigation protection
- [ ] Implement permission-based components
- [ ] Add offline indicators
- [ ] Set up deep link handling
- [ ] Implement background sync
- [ ] Add error boundaries
- [ ] Test offline functionality
- [ ] Test permission checks
- [ ] Test token refresh
- [ ] Test deep link authentication

---

Your React Native application is now fully integrated with the centralized RBAC system, including offline support! 🎉
