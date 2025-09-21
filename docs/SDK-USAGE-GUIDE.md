# SDK Usage Guide

## 🎯 **Your Developers Should Continue Using These SDKs**

The SDK files are **essential** for your centralized RBAC implementation. Your developers should **continue using** them as they provide the proper abstraction layer for interacting with your user-service.

---

## 📁 **Available SDKs**

### **1. Node.js Policy Client SDK** (`sdks/node-policy-client.js`)

**For:** Node.js applications, Express.js microservices, backend services

**Usage:**

```javascript
const PolicyClient = require("./sdks/node-policy-client");

// Initialize
const policy = new PolicyClient("http://localhost:3000");

// Express middleware
app.get("/api/users", policy.requirePermission("user", "read"), (req, res) => {
  // Route handler
});

// Manual permission check
const hasAccess = await policy.hasPermission(token, "user", "write");
```

### **2. React Policy Hooks SDK** (`sdks/react-policy-hooks.js`)

**For:** React.js applications (CRM, Portal, etc.)

**Usage:**

```javascript
import { useAuthorization, usePermission } from "./sdks/react-policy-hooks";

const MyComponent = ({ token }) => {
  const { checkPermission } = useAuthorization(token);
  const { hasPermission } = usePermission(token, "user", "read");

  return <div>{hasPermission && <button>Edit User</button>}</div>;
};
```

### **3. React Native Policy Hooks SDK** (`sdks/react-native-policy-hooks.js`)

**For:** React Native mobile applications

**Usage:**

```javascript
import {
  useAuthorization,
  usePermission,
  useNetworkStatus,
} from "./sdks/react-native-policy-hooks";

const MyScreen = ({ token }) => {
  const { isOnline } = useNetworkStatus();
  const { hasPermission, isCached } = usePermission(token, "user", "read");

  return (
    <View>
      {!isOnline && <Text>Offline mode</Text>}
      {hasPermission && (
        <TouchableOpacity>
          <Text>Edit User</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};
```

---

## 🔄 **Migration from Old SDKs**

If your developers were using the old SDK files, here's how to migrate:

### **Old vs New Usage**

**Old (if they were using custom implementations):**

```javascript
// Old way - direct API calls
const response = await fetch("/policy/evaluate", {
  method: "POST",
  body: JSON.stringify({ token, resource, action }),
});
```

**New (using SDKs):**

```javascript
// New way - using SDK
const PolicyClient = require("./sdks/node-policy-client");
const policy = new PolicyClient("http://localhost:3000");
const result = await policy.evaluatePolicy(token, resource, action);
```

---

## 🚀 **Benefits of Using SDKs**

### **1. Abstraction**

- Hide complex API details
- Provide simple, consistent interface
- Handle errors and retries automatically

### **2. Caching**

- Built-in caching for performance
- Reduces API calls
- Offline support for React Native

### **3. Error Handling**

- Graceful fallbacks
- Network error handling
- Cached result fallbacks

### **4. Type Safety**

- Consistent response formats
- Proper error objects
- Standardized interfaces

---

## 📋 **Developer Instructions**

### **For Node.js/Express Developers:**

1. **Copy the SDK file:**

   ```bash
   cp /path/to/user-service/sdks/node-policy-client.js ./utils/
   ```

2. **Install dependencies:**

   ```bash
   npm install axios
   ```

3. **Use in your application:**
   ```javascript
   const PolicyClient = require("./utils/node-policy-client");
   const policy = new PolicyClient(process.env.USER_SERVICE_URL);
   ```

### **For React.js Developers:**

1. **Copy the SDK file:**

   ```bash
   cp /path/to/user-service/sdks/react-policy-hooks.js ./src/utils/
   ```

2. **Import and use:**
   ```javascript
   import { useAuthorization, usePermission } from "./utils/react-policy-hooks";
   ```

### **For React Native Developers:**

1. **Copy the SDK file:**

   ```bash
   cp /path/to/user-service/sdks/react-native-policy-hooks.js ./src/utils/
   ```

2. **Install dependencies:**

   ```bash
   npm install @react-native-async-storage/async-storage @react-native-community/netinfo
   ```

3. **Import and use:**
   ```javascript
   import {
     useAuthorization,
     usePermission,
     useNetworkStatus,
   } from "./utils/react-native-policy-hooks";
   ```

---

## 🔧 **Configuration**

### **Environment Variables**

**For all applications:**

```env
# User service URL
USER_SERVICE_URL=http://localhost:3000
REACT_APP_USER_SERVICE_URL=http://localhost:3000
REACT_NATIVE_USER_SERVICE_URL=http://localhost:3000
```

**For production:**

```env
USER_SERVICE_URL=https://user-service.yourdomain.com
REACT_APP_USER_SERVICE_URL=https://user-service.yourdomain.com
REACT_NATIVE_USER_SERVICE_URL=https://user-service.yourdomain.com
```

### **SDK Options**

**Node.js SDK:**

```javascript
const policy = new PolicyClient("http://localhost:3000", {
  timeout: 5000, // Request timeout
  retries: 3, // Retry attempts
  cacheTimeout: 300000, // Cache duration (5 minutes)
});
```

**React SDK:**

```javascript
const policyClient = usePolicyClient("http://localhost:3000", {
  timeout: 5000,
  cacheTimeout: 300000,
});
```

**React Native SDK:**

```javascript
const policyClient = usePolicyClient("http://localhost:3000", {
  timeout: 5000,
  cacheTimeout: 300000,
  offlineCacheTimeout: 86400000, // 24 hours for offline
});
```

---

## 📊 **Performance Tips**

### **1. Caching**

- SDKs automatically cache results for 5 minutes
- Use batch evaluation for multiple permissions
- Preload common permissions on app startup

### **2. Network Optimization**

- SDKs handle network failures gracefully
- React Native SDK supports offline mode
- Automatic retry logic for failed requests

### **3. Error Handling**

- SDKs provide consistent error formats
- Graceful degradation when service is unavailable
- Cached fallbacks for better user experience

---

## 🛠️ **Advanced Usage**

### **Custom Policy Client (Node.js)**

```javascript
const PolicyClient = require("./sdks/node-policy-client");

class CustomPolicyClient extends PolicyClient {
  async evaluatePolicy(token, resource, action, context = {}) {
    // Add custom logic before evaluation
    const customContext = {
      ...context,
      timestamp: new Date().toISOString(),
      source: "custom-client",
    };

    return super.evaluatePolicy(token, resource, action, customContext);
  }
}

const policy = new CustomPolicyClient("http://localhost:3000");
```

### **Custom Hooks (React)**

```javascript
import { useAuthorization } from "./sdks/react-policy-hooks";

export const useCustomAuthorization = (token) => {
  const { checkPermission, permissions } = useAuthorization(token);

  const checkMultiplePermissions = useCallback(
    async (permissions) => {
      const results = await Promise.all(
        permissions.map((p) => checkPermission(p.resource, p.action, p.context))
      );
      return results;
    },
    [checkPermission]
  );

  return {
    checkPermission,
    checkMultiplePermissions,
    permissions,
  };
};
```

---

## ✅ **Summary**

**Your developers should:**

1. ✅ **Continue using** the SDK files
2. ✅ **Copy the SDKs** to their projects
3. ✅ **Use the provided hooks/utilities** instead of direct API calls
4. ✅ **Configure environment variables** for the user-service URL
5. ✅ **Take advantage of caching and error handling** built into the SDKs

**The SDKs provide:**

- 🚀 **Better performance** with caching
- 🛡️ **Error handling** and fallbacks
- 🔄 **Offline support** for mobile apps
- 🎯 **Simple APIs** for complex authorization logic
- 📱 **Platform-specific optimizations**

Your centralized RBAC system is now properly set up with all the necessary SDKs for your developers to use! 🎉
