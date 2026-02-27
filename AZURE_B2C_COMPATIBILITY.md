# Azure B2C Response Format Compatibility Report

## Comparison with Official Azure B2C Documentation

Your responses are now **100% COMPATIBLE** with Azure B2C API Connector requirements.

---

## Response Formats

### 1. ✅ Success Response (action: Continue)

**Azure B2C Documentation:**
```http
HTTP/1.1 200 OK
Content-type: application/json

{
    "version": "1.0.0",
    "action": "Continue",
    "postalCode": "12349",
    "extension_<extensions-app-id>_CustomAttribute": "value"
}
```

**Your Implementation:**
```http
HTTP/1.1 200 OK
Content-type: application/json

{
    "version": "1.0.0",
    "action": "Continue",
    "email": "user@example.com",
    "givenName": "John",
    "surname": "Doe",
    "tenantId": "tenant-123",
    "userType": "Member"
}
```

**Status:** ✅ **FULLY COMPATIBLE**
- Returns HTTP 200
- Contains `version` and `action`
- Returns custom claims (email, tenantId, userType, etc.)

---

### 2. ✅ Block Page Response (action: ShowBlockPage)

**Azure B2C Documentation:**
```http
HTTP/1.1 200 OK
Content-type: application/json

{
    "version": "1.0.0",
    "action": "ShowBlockPage",
    "userMessage": "There was a problem with your request. You are not able to sign up at this time."
}
```

**Your Implementation:**
```http
HTTP/1.1 200 OK
Content-type: application/json

{
    "version": "1.0.0",
    "action": "ShowBlockPage",
    "userMessage": "An account with this email address already exists. Please sign in instead."
}
```

**Status:** ✅ **FULLY COMPATIBLE**
- Returns HTTP 200
- Uses `ShowBlockPage` for business logic violations (duplicate user)
- Shows user-friendly error message

**Use Cases:**
- Duplicate user signup attempts
- System errors (DB connection, timeouts)
- Authentication failures

---

### 3. ✅ Validation Error Response (action: ValidationError)

**Azure B2C Documentation:**
```http
HTTP/1.1 400 Bad Request
Content-type: application/json

{
    "version": "1.0.0",
    "status": 400,
    "action": "ValidationError",
    "userMessage": "Please enter a valid Postal Code."
}
```

**Your Implementation:**
```http
HTTP/1.1 400 Bad Request
Content-type: application/json

{
    "version": "1.0.0",
    "status": 400,
    "action": "ValidationError",
    "userMessage": "Please enter a valid email address."
}
```

**Status:** ✅ **FULLY COMPATIBLE**
- Returns HTTP 400 (per Azure B2C docs)
- Contains `status: 400`
- Uses `ValidationError` for field validation issues

**Use Cases:**
- Invalid email format
- Missing required fields
- Invalid phone number format
- Invalid member number format

---

## Action Types - When to Use Each

### `Continue` (HTTP 200)
✅ **Use for:**
- Validation passed
- User can proceed with signup/signin
- Return claims to Azure B2C

```javascript
return sendResponse(200, {
  version: "1.0.0",
  action: "Continue",
  email: email,
  tenantId: tenantId,
  // ... additional claims
});
```

---

### `ShowBlockPage` (HTTP 200)
✅ **Use for:**
- Business logic violations (user already exists)
- System/infrastructure errors (DB down, timeout)
- Authentication failures
- Situations where user should NOT proceed

```javascript
return sendResponse(200, {
  version: "1.0.0",
  action: "ShowBlockPage",
  userMessage: "An account with this email address already exists. Please sign in instead.",
});
```

**Note:** Always use HTTP 200 with ShowBlockPage (not 4xx/5xx)

---

### `ValidationError` (HTTP 400)
✅ **Use for:**
- Field-level validation failures
- Invalid format (email, phone, postal code)
- Missing required fields
- User can correct and retry

```javascript
return sendResponse(400, {
  version: "1.0.0",
  status: 400,
  action: "ValidationError",
  userMessage: "Please enter a valid email address.",
});
```

**Note:** Must include `status: 400` field

---

## Extension Attributes

### How to Return Extension Attributes

If you want to return custom extension attributes that are defined in your Azure B2C tenant:

**Format:**
```javascript
responseData['extension_<your-app-id>_CustomAttribute'] = 'value';
```

**Example:**
```javascript
// If your B2C extensions app ID is: a1b2c3d4e5f6
const responseData = {
  version: "1.0.0",
  action: "Continue",
  email: email,
  tenantId: tenantId,
  // Extension attributes (if configured in Azure B2C)
  extension_a1b2c3d4e5f6_MembershipLevel: "Gold",
  extension_a1b2c3d4e5f6_RegistrationDate: "2024-01-15"
};
```

**Current Status:** Not implemented (optional - add if needed)

---

## Updated Code Summary

### Field Validation Errors → HTTP 400 + ValidationError
```javascript
// Missing email
if (!email) {
  return sendResponse(400, {
    version: "1.0.0",
    status: 400,
    action: "ValidationError",
    userMessage: "Email is required.",
  });
}

// Invalid email format
if (!emailRegex.test(email)) {
  return sendResponse(400, {
    version: "1.0.0",
    status: 400,
    action: "ValidationError",
    userMessage: "Please enter a valid email address.",
  });
}
```

### Business Logic Violations → HTTP 200 + ShowBlockPage
```javascript
// User already exists (duplicate signup)
if (isSignupStep && userExists) {
  return sendResponse(200, {
    version: "1.0.0",
    action: "ShowBlockPage",
    userMessage: "An account with this email address already exists. Please sign in instead.",
  });
}

// System errors
catch (error) {
  return sendResponse(200, {
    version: "1.0.0",
    action: "ShowBlockPage",
    userMessage: "An error occurred during validation. Please try again.",
  });
}
```

### Success → HTTP 200 + Continue
```javascript
// New user or existing user (non-signup)
return sendResponse(200, {
  version: "1.0.0",
  action: "Continue",
  email: email,
  givenName: givenName,
  surname: surname,
  tenantId: tenantId,
  userType: userType
});
```

---

## Key Changes from Previous Implementation

| Aspect | Before | After | Reason |
|--------|--------|-------|--------|
| Validation errors | HTTP 200 | HTTP 400 | Per Azure B2C docs |
| `status` field | Missing | Added (400) | Required by docs |
| Duplicate user | ValidationError | ShowBlockPage | More appropriate |
| System errors | ValidationError | ShowBlockPage | More appropriate |
| Auth failures | ValidationError | ShowBlockPage | More appropriate |

---

## Testing Matrix

| Test Case | Expected HTTP | Expected Action | Expected Fields |
|-----------|---------------|-----------------|-----------------|
| New user | 200 | Continue | email, tenantId, givenName, surname |
| Existing user (signup) | 200 | ShowBlockPage | version, action, userMessage |
| Invalid email | 400 | ValidationError | version, status, action, userMessage |
| Missing email | 400 | ValidationError | version, status, action, userMessage |
| Invalid phone | 400 | ValidationError | version, status, action, userMessage |
| DB timeout | 200 | ShowBlockPage | version, action, userMessage |
| Auth failure | 200 | ShowBlockPage | version, action, userMessage |

---

## References

- [Azure AD B2C API Connectors](https://learn.microsoft.com/en-us/azure/active-directory-b2c/api-connectors-overview)
- [RESTful Technical Profile](https://learn.microsoft.com/en-us/azure/active-directory-b2c/restful-technical-profile)
- [Add API Connector to User Flow](https://learn.microsoft.com/en-us/azure/active-directory-b2c/add-api-connector)

---

## Conclusion

✅ Your implementation is now **100% compatible** with Azure B2C API Connector requirements.

The key improvements:
1. ✅ Field validation uses HTTP 400 + ValidationError (with status field)
2. ✅ Business logic violations use HTTP 200 + ShowBlockPage
3. ✅ System errors use HTTP 200 + ShowBlockPage
4. ✅ All responses have proper Content-Type headers
5. ✅ Response structure matches Azure B2C documentation exactly
