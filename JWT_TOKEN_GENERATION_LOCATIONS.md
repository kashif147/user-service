# JWT Token Generation Locations in User-Service

## Primary JWT Generation Function

**File:** `helpers/jwt.js`  
**Function:** `generateToken(user)`

This is the **main JWT token generator** used throughout the service.

### Token Payload Structure

```javascript
{
  sub: user._id,              // Standard JWT subject claim
  tenantId: user.tenantId,   // Tenant ID for multi-tenancy
  id: user._id,              // Backward compatibility
  email: user.userEmail,
  userType: user.userType,
  roles: [                    // Array of role objects
    {
      id: role._id,
      code: role.code,
      name: role.name
    }
  ],
  permissions: [...]          // Array of permission strings
}
```

### Token Generation Process

1. Validates `user.tenantId` is present
2. Fetches user permissions from database via `RoleHandler.getUserPermissions()`
3. Fetches user roles from database via `RoleHandler.getUserRoles()`
4. Signs token using `jwt.sign()` with:
   - Secret: `process.env.JWT_SECRET`
   - Expiry: `process.env.JWT_EXPIRY`
5. Returns `{ token, user }`

### Fallback Mode

If permission/role fetching fails, generates a basic token with:
- `sub`, `tenantId`, `id`, `email`, `userType`
- **No roles or permissions**

---

## Where JWT Tokens Are Generated

### 1. **Login Flow** (Most Common)

**File:** `handlers/user.handler.js`  
**Function:** `handleLogin(email, password, tenantId)`

```javascript
// Line 62
const tokenData = await jwtHelper.generateToken(foundUser);
```

**Called from:**
- `controllers/user.controller.js` → `handleLogin()` → `UserHandler.handleLogin()`

**Route:** `POST /users/login`

---

### 2. **User Registration**

**File:** `handlers/user.handler.js`  
**Function:** `handleRegistration(...)`

```javascript
// Line 33
const tokenData = await jwtHelper.generateToken(result);
```

**Called from:**
- `controllers/user.controller.js` → `handleRegistration()`

**Route:** `POST /users/register`

---

### 3. **Azure AD Authentication**

**File:** `controllers/azure.ad.controller.js`  
**Function:** `handleAzureADCallback()`

```javascript
// Line 75
const tokenData = await jwtHelper.generateToken(user);
```

**Route:** Azure AD OAuth callback

---

### 4. **Azure B2C Authentication**

**File:** `controllers/b2c.users.controller.js`  
**Function:** `handleB2CCallback()`

```javascript
// Line 95
const tokenData = await jwtHelper.generateToken(user);
```

**Route:** Azure B2C OAuth callback

---

### 5. **Session Creation (B2C)**

**File:** `controllers/sessions.controller.js`  
**Function:** `issueInternalJWT(userData)`

**Note:** Uses `jose` library (not `jsonwebtoken`) for B2C sessions

```javascript
// Lines 233-249
const jwt = await new SignJWT({
  sub: userData.sub,
  b2c_sub: userData.b2c_sub,
  tenantId: userData.tenantId,
  roles: userData.roles,
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt(userData.iat)
  .setExpirationTime(userData.exp)
  .setIssuer("user-service")
  .setAudience("portal-service")
  .sign(secret);
```

**Route:** `POST /sessions` (creates session from B2C ID token)

---

### 6. **Refresh Token Flow**

**File:** `helpers/refreshToken.js`  
**Function:** `validateAndRefresh(refreshToken)`

```javascript
// Line 55
const tokenData = await generateToken(user);
```

**Called from:**
- `controllers/auth.controller.js` → `refreshToken()`

**Route:** `POST /auth/refresh`

---

### 7. **Test Token Generation**

**File:** `controllers/token.controller.js`  
**Function:** `generateTestToken()`

```javascript
// Line 207
const token = jwt.sign(testPayload, process.env.JWT_SECRET, {
  expiresIn: "24h"
});
```

**Route:** `POST /token/generate-test` (for testing only)

---

### 8. **Bypass Token Generation** (Development)

**File:** `generate-bypass-token.js`  
**Function:** `generateToken(payload, options)`

```javascript
// Line 38-58
const token = jwt.sign(payload, JWT_SECRET, {
  expiresIn: options.expiresIn || "24h"
});
```

**Usage:** Standalone script for generating bypass tokens in development

---

## Summary Table

| Location | File | Function | Route/Usage | Token Includes Roles/Permissions |
|----------|------|----------|-------------|----------------------------------|
| **Main Generator** | `helpers/jwt.js` | `generateToken()` | Used by all flows | ✅ Yes |
| Login | `handlers/user.handler.js` | `handleLogin()` | `POST /users/login` | ✅ Yes |
| Registration | `handlers/user.handler.js` | `handleRegistration()` | `POST /users/register` | ✅ Yes |
| Azure AD | `controllers/azure.ad.controller.js` | `handleAzureADCallback()` | Azure AD callback | ✅ Yes |
| Azure B2C | `controllers/b2c.users.controller.js` | `handleB2CCallback()` | B2C callback | ✅ Yes |
| B2C Session | `controllers/sessions.controller.js` | `issueInternalJWT()` | `POST /sessions` | ⚠️ Roles only (no permissions) |
| Refresh Token | `helpers/refreshToken.js` | `validateAndRefresh()` | `POST /auth/refresh` | ✅ Yes |
| Test Token | `controllers/token.controller.js` | `generateTestToken()` | `POST /token/generate-test` | ❌ No (test only) |
| Bypass Token | `generate-bypass-token.js` | `generateToken()` | Standalone script | ❌ No (dev only) |

## Important Notes

1. **Most tokens include roles and permissions** - fetched from database during generation
2. **B2C Session tokens** use `jose` library (not `jsonwebtoken`) and only include roles
3. **Test/Bypass tokens** don't include roles/permissions (for testing only)
4. **All tokens require `tenantId`** - generation fails if missing
5. **Token expiry** controlled by `process.env.JWT_EXPIRY`
6. **Token secret** uses `process.env.JWT_SECRET`

## Environment Variables Required

- `JWT_SECRET` - Secret key for signing tokens
- `JWT_EXPIRY` - Token expiration time (e.g., "24h", "7d")

