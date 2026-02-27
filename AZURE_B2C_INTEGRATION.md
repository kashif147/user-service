# Azure B2C API Connector Integration Guide

## Issue: "returned HTTP error response that could not be parsed"

This error occurs when Azure B2C receives a response from your REST API that it cannot parse correctly.

## Root Causes & Solutions

### 1. **Missing or Incorrect Content-Type Header**
**Problem:** Azure B2C requires explicit `Content-Type: application/json` header.

**Solution:** Added explicit header in three places:
- Route middleware (before processing request)
- Controller response function
- BasicAuth middleware

### 2. **Invalid Response Structure**
**Problem:** Azure B2C API connectors expect a very specific JSON structure.

**Required Response Format:**

#### Success Response (action: Continue)
```json
{
  "version": "1.0.0",
  "action": "Continue",
  "email": "user@example.com",
  "givenName": "John",
  "surname": "Doe",
  "tenantId": "tenant-123"
}
```

#### Error Response (action: ValidationError)
```json
{
  "version": "1.0.0",
  "action": "ValidationError",
  "userMessage": "An account with this email already exists."
}
```

**Rules:**
- `version` (required): Must be "1.0.0"
- `action` (required): Either "Continue" or "ValidationError"
- `userMessage` (optional): Only for ValidationError responses - shown to user
- Additional claims: Any other fields will be returned as claims to Azure B2C

### 3. **Fields That Caused Issues (Now Removed)**
The following fields were causing parsing errors and have been removed:

❌ **Removed:**
- `objectId` - Azure B2C couldn't parse this
- `step` - Should not be echoed back
- `extension_*` attributes in response - Complex naming caused issues
- Undefined values using spread operator

✅ **Kept (Safe to use):**
- `email`
- `givenName`
- `surname`
- `displayName`
- `tenantId`
- `userType`
- `mobilephone` (if needed)
- `memberno` (if needed)

### 4. **HTTP Status Code**
**Critical:** Always return HTTP 200, even for validation errors.

❌ Wrong:
```javascript
return res.status(400).json({ error: "Email required" });
```

✅ Correct:
```javascript
return res.status(200).json({
  version: "1.0.0",
  action: "ValidationError",
  userMessage: "Email is required."
});
```

## Implementation in user-service

### Route Configuration
```javascript
router.post(
  "/users/validate",
  // Set Content-Type header FIRST
  (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  },
  azureB2CBasicAuth(),
  async (req, res, next) => {
    try {
      await UserController.validateUser(req, res, next);
    } catch (error) {
      console.error("FATAL: validateUser error escaped:", error);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
          version: "1.0.0",
          action: "ValidationError",
          userMessage: "An error occurred during validation. Please try again.",
        });
      }
    }
  }
);
```

### Controller Response Function
```javascript
const sendResponse = (status, data) => {
  if (!res.headersSent) {
    clearTimeout(timeoutId);
    try {
      // CRITICAL: Azure B2C requires explicit Content-Type header
      res.setHeader('Content-Type', 'application/json');
      return res.status(status).json(data);
    } catch (err) {
      console.error(`Error sending response:`, err);
      return;
    }
  }
  return false;
};
```

## Testing the Endpoint

### Using the Test Script
```bash
# Make script executable
chmod +x test-b2c-endpoint.sh

# Test locally
./test-b2c-endpoint.sh local

# Test production
./test-b2c-endpoint.sh production
```

### Using curl directly
```bash
# Test new user (should return Continue)
curl -X POST http://localhost:3000/api/user/validate \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "givenName": "New",
    "surname": "User",
    "step": "PostAttributeCollection"
  }'

# Expected response:
{
  "version": "1.0.0",
  "action": "Continue",
  "email": "newuser@example.com",
  "givenName": "New",
  "surname": "User",
  "tenantId": "default-tenant-id"
}
```

### Verifying in Azure B2C
1. Check Application Insights logs for the API call
2. Look for request headers and response body
3. Verify Content-Type header is set
4. Confirm response body matches expected format

## Azure B2C Configuration

### API Connector Settings
- **Endpoint URL:** `https://your-api.com/api/user/validate`
- **Authentication:** Basic (optional)
- **Claims to send:** email, givenName, surname, displayName, step
- **Claims to receive:** All claims returned by API

### User Flow Integration
Add the API connector at the appropriate step:
- **Before creating the user** (recommended): "PostAttributeCollection"
- **After user creation:** "PostUserWrite"

## Troubleshooting

### Error: "returned HTTP error response that could not be parsed"
**Check:**
1. Response has `Content-Type: application/json` header
2. Response body is valid JSON
3. Response contains `version` and `action` fields
4. No undefined values in response
5. HTTP status is always 200

### Error: "An error occurred during validation"
**Check:**
1. API endpoint is accessible from Azure B2C
2. Basic Auth credentials are correct (if enabled)
3. MongoDB connection is working
4. API logs for specific error messages

### Response timeout
**Check:**
1. Database queries complete within 3 seconds
2. Total response time < 20 seconds
3. Network latency between Azure B2C and API

## Best Practices

1. **Always log request/response** for debugging
2. **Keep response minimal** - only include necessary claims
3. **Use simple field names** - avoid complex naming
4. **Test thoroughly** before deploying
5. **Monitor Application Insights** for errors
6. **Set appropriate timeouts** for database queries
7. **Handle all error cases** gracefully

## Environment Variables

```bash
# Required
DEFAULT_TENANT_ID=your-default-tenant-id

# Optional (for Basic Auth)
B2C_API_USERNAME=your-username
B2C_API_PASSWORD=your-password
```

## References

- [Azure B2C API Connector Documentation](https://learn.microsoft.com/en-us/azure/active-directory-b2c/api-connectors-overview)
- [REST API Technical Profile](https://learn.microsoft.com/en-us/azure/active-directory-b2c/restful-technical-profile)
- [User Flow API Connector](https://learn.microsoft.com/en-us/azure/active-directory-b2c/add-api-connector)
