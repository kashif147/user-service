# Azure B2C API Connector - Quick Fix Summary

## The Problem
Error: `"returned HTTP error response that could not be parsed"`

## Root Cause
Azure B2C couldn't parse the JSON response due to:
1. Missing `Content-Type: application/json` header
2. Extra fields in response (`objectId`, `step`, `extension_*`)
3. Undefined values in response object

## Changes Made

### 1. Route Middleware (`user.routes.js`)
Added explicit Content-Type header before processing:
```javascript
(req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
}
```

### 2. Controller (`user.controller.js`)
**sendResponse() function:**
- Added `res.setHeader('Content-Type', 'application/json')`

**Response structure simplified:**
- Removed: `objectId`, `step`, `extension_*` attributes
- Kept: `version`, `action`, `email`, `givenName`, `surname`, `displayName`, `tenantId`, `userType`
- Only add fields if they have values (no undefined)

### 3. BasicAuth Middleware (`basicAuth.middleware.js`)
Added Content-Type header to all responses

## Valid Response Formats

### Success (New User)
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

### Success (Existing User)
```json
{
  "version": "1.0.0",
  "action": "Continue",
  "email": "user@example.com",
  "givenName": "John",
  "surname": "Doe",
  "displayName": "John Doe",
  "tenantId": "tenant-123",
  "userType": "Member"
}
```

### Error (Validation Failed)
```json
{
  "version": "1.0.0",
  "action": "ValidationError",
  "userMessage": "An account with this email address already exists. Please sign in instead."
}
```

## Testing

### Local Test
```bash
curl -X POST http://localhost:3000/api/user/validate \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","givenName":"Test","surname":"User","step":"PostAttributeCollection"}'
```

### Expected Response
- HTTP Status: **200** (always)
- Content-Type: **application/json**
- Body: Valid JSON with `version` and `action`

### Use Test Script
```bash
chmod +x test-b2c-endpoint.sh
./test-b2c-endpoint.sh local
```

## What to Check in Azure B2C

1. **API Connector Configuration**
   - URL: `https://your-api.com/api/user/validate`
   - Method: POST
   - Claims to send: email, givenName, surname, displayName, step

2. **User Flow Configuration**
   - Add API connector at "PostAttributeCollection" step
   - Map returned claims to user attributes

3. **Application Insights**
   - Check for API call logs
   - Verify request/response headers
   - Look for Content-Type header

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| "could not be parsed" | Check Content-Type header is set |
| Undefined values in response | Only add fields if they exist |
| Response timeout | Database query takes too long |
| Basic Auth fails | Check B2C_API_USERNAME/PASSWORD env vars |
| User not found in DB | Check DEFAULT_TENANT_ID is set |

## Next Steps

1. Deploy changes to your environment
2. Test with curl or test script
3. Configure API connector in Azure B2C
4. Test end-to-end signup flow
5. Monitor Application Insights for any errors

## Files Modified
- `/controllers/user.controller.js` - Added Content-Type header, simplified response
- `/routes/user.routes.js` - Added Content-Type middleware
- `/middlewares/basicAuth.middleware.js` - Added Content-Type to all responses

## New Files Created
- `/test-b2c-endpoint.sh` - Test script for local/remote testing
- `/AZURE_B2C_INTEGRATION.md` - Complete integration guide
