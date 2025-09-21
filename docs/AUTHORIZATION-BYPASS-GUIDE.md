# Authorization Bypass Guide

This guide explains how to use the authorization bypass functionality in the user-service.

## Overview

The authorization bypass feature allows you to temporarily disable **authorization checks** (permission/role validation) while still maintaining **authentication** (token validation). This is controlled through environment variables and uses a special bypass token.

## Authentication vs Authorization

### Authentication (Still Required)

- ✅ **Token validation** - JWT token must be valid and properly signed
- ✅ **Token expiration** - Token must not be expired
- ✅ **Token structure** - Token must contain required fields (tenantId, etc.)
- ✅ **User identity** - User information is extracted from the token

### Authorization (Bypassed)

- ❌ **Permission checks** - Skip checking if user has required permissions
- ❌ **Role validation** - Skip checking if user has required roles
- ❌ **Resource access** - Skip resource-specific access rules
- ❌ **Action validation** - Skip action-specific authorization rules

## Configuration

### Environment Variables

Add these variables to your environment configuration:

```bash
# Enable/disable authorization bypass (but keep authentication)
AUTH_BYPASS_ENABLED=true

# The JWT token that will bypass authorization checks (must be a valid JWT)
AUTH_BYPASS_TOKEN=your-valid-jwt-token-here
```

**Important**: The bypass token must be a **valid JWT token** that can be verified with your `JWT_SECRET`. The system will still authenticate the token but skip authorization checks.

### Example Configuration Files

**Development (.env.development):**

```bash
AUTH_BYPASS_ENABLED=true
AUTH_BYPASS_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJieXBhc3MtdXNlciIsInRlbmFudElkIjoidGVzdC10ZW5hbnQiLCJlbWFpbCI6ImJ5cGFzc0BleGFtcGxlLmNvbSIsInVzZXJUeXBlIjoiQ1JNIiwicm9sZXMiOlt7ImNvZGUiOiJTVSJ9XSwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE2MzQwNjcyMDAsImV4cCI6MTYzNDE1MzYwMH0.example-signature
```

**Staging (.env.staging):**

```bash
AUTH_BYPASS_ENABLED=false
AUTH_BYPASS_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzdGFnaW5nLXVzZXIiLCJ0ZW5hbnRJZCI6InN0YWdpbmctdGVuYW50IiwiZW1haWwiOiJzdGFnaW5nQGV4YW1wbGUuY29tIiwidXNlclR5cGUiOiJDUk0iLCJyb2xlcyI6W3siY29kZSI6IlNVIn1dLCJwZXJtaXNzaW9ucyI6WyIqIl0sImlhdCI6MTYzNDA2NzIwMCwiZXhwIjoxNjM0MTUzNjAwfQ.example-signature
```

**Production (.env.production):**

```bash
AUTH_BYPASS_ENABLED=false
AUTH_BYPASS_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcm9kLXVzZXIiLCJ0ZW5hbnRJZCI6InByb2QtdGVuYW50IiwiZW1haWwiOiJwcm9kQGV4YW1wbGUuY29tIiwidXNlclR5cGUiOiJDUk0iLCJyb2xlcyI6W3siY29kZSI6IlNVIn1dLCJwZXJtaXNzaW9ucyI6WyIqIl0sImlhdCI6MTYzNDA2NzIwMCwiZXhwIjoxNjM0MTUzNjAwfQ.example-signature
```

## Usage

### 1. Generate a Valid JWT Token

First, create a valid JWT token for bypass:

```bash
# Using Node.js to generate a JWT
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({
  sub: 'bypass-user',
  tenantId: 'test-tenant',
  email: 'bypass@example.com',
  userType: 'CRM',
  roles: [{ code: 'SU' }],
  permissions: ['*']
}, process.env.JWT_SECRET, { expiresIn: '24h' });
console.log(token);
"
```

### 2. Enable Bypass

Set the environment variables:

```bash
export AUTH_BYPASS_ENABLED=true
export AUTH_BYPASS_TOKEN=your-generated-jwt-token-here
```

### 3. Use Bypass Token

Include the bypass token in your Authorization header:

```bash
curl -H "Authorization: Bearer your-generated-jwt-token-here" \
     http://localhost:3000/users
```

### 4. Test Bypass

Run the test script:

```bash
AUTH_BYPASS_ENABLED=true AUTH_BYPASS_TOKEN=your-generated-jwt-token-here node test-bypass.js
```

## How It Works

### Policy Evaluation Service

The bypass check happens at the very beginning of the `evaluatePolicy` function, but **still validates the token**:

```javascript
// Check for authorization bypass (but still validate token)
if (process.env.AUTH_BYPASS_ENABLED === "true") {
  const bypassToken = process.env.AUTH_BYPASS_TOKEN;
  if (token === bypassToken) {
    // Still validate the token to ensure it's a valid JWT
    const tokenValidation = await validateToken(token);
    if (!tokenValidation.valid) {
      return {
        decision: "DENY",
        reason: "INVALID_TOKEN",
        error: tokenValidation.error,
        // ... other fields
      };
    }

    // Token is valid, bypass authorization checks
    return {
      decision: "PERMIT",
      reason: "AUTHORIZATION_BYPASS_ENABLED",
      bypass: true,
      user: tokenValidation.user, // Real user data from token
      // ... other fields
    };
  }
}
```

### Middleware Integration

All authorization middleware components check for bypass but **still authenticate**:

- `policy.middleware.js` - Policy-based authorization
- `permission.mw.js` - Permission-based authorization
- `policyAdapter.js` - Policy adapter middleware
- `node-policy-client.js` - SDK client middleware

### Bypass Response

When bypass is active, the system returns:

```json
{
  "decision": "PERMIT",
  "reason": "AUTHORIZATION_BYPASS_ENABLED",
  "bypass": true,
  "user": {
    "id": "bypass-user",
    "tenantId": "test-tenant",
    "email": "bypass@example.com",
    "userType": "CRM",
    "roles": [{ "code": "SU" }],
    "permissions": ["*"]
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "policyVersion": "1.0.0"
}
```

## Security Considerations

### ⚠️ Important Security Notes

1. **Never enable bypass in production** unless absolutely necessary
2. **Use strong, unique bypass tokens** - don't use simple strings
3. **Rotate bypass tokens regularly** if used in staging environments
4. **Monitor bypass usage** - log when bypass tokens are used
5. **Disable bypass immediately** after completing your task

### Recommended Token Format

Use a secure, random token:

```bash
# Generate a secure token
openssl rand -hex 32
# Output: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

### Environment-Specific Recommendations

- **Development**: Can be enabled for convenience
- **Staging**: Enable only when needed for testing
- **Production**: Should never be enabled unless emergency

## Testing

### Manual Testing

1. **Enable bypass:**

   ```bash
   export AUTH_BYPASS_ENABLED=true
   export AUTH_BYPASS_TOKEN=test-bypass-12345
   ```

2. **Test with curl:**

   ```bash
   curl -H "Authorization: Bearer test-bypass-12345" \
        http://localhost:3000/policy/check/user/read
   ```

3. **Expected response:**
   ```json
   {
     "authorized": true,
     "reason": "AUTH_BYPASS_ENABLED",
     "bypass": true
   }
   ```

### Automated Testing

Use the provided test script:

```bash
# Run all bypass tests
AUTH_BYPASS_ENABLED=true AUTH_BYPASS_TOKEN=test-token node test-bypass.js
```

## Troubleshooting

### Common Issues

1. **Bypass not working:**

   - Check `AUTH_BYPASS_ENABLED=true` (must be string "true")
   - Verify token matches exactly
   - Ensure environment variables are loaded

2. **Token mismatch:**

   - Compare token character by character
   - Check for extra spaces or newlines
   - Verify encoding (UTF-8)

3. **Environment not loaded:**
   - Restart the application after setting variables
   - Check `.env` file is in correct location
   - Verify environment variable loading

### Debug Mode

Enable debug logging to see bypass attempts:

```bash
DEBUG=policy:* AUTH_BYPASS_ENABLED=true node app.js
```

## API Endpoints

The bypass works with all protected endpoints:

- `POST /policy/evaluate` - Policy evaluation
- `GET /policy/check/:resource/:action` - Quick authorization check
- `GET /users` - User management
- `GET /roles` - Role management
- `GET /permissions` - Permission management
- All other protected routes

## Integration Examples

### Node.js Client

```javascript
const axios = require("axios");

const client = axios.create({
  baseURL: "http://localhost:3000",
  headers: {
    Authorization: `Bearer ${process.env.AUTH_BYPASS_TOKEN}`,
  },
});

// This will bypass authorization if enabled
const response = await client.get("/users");
```

### React/Next.js

```javascript
const response = await fetch("/api/users", {
  headers: {
    Authorization: `Bearer ${process.env.NEXT_PUBLIC_BYPASS_TOKEN}`,
  },
});
```

### cURL Examples

```bash
# Test policy evaluation
curl -X POST http://localhost:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer bypass-token-12345" \
  -d '{"token":"bypass-token-12345","resource":"user","action":"read"}'

# Test user endpoint
curl -H "Authorization: Bearer bypass-token-12345" \
     http://localhost:3000/users
```

## Monitoring and Logging

### Log Bypass Usage

Add logging to track bypass usage:

```javascript
if (process.env.AUTH_BYPASS_ENABLED === "true" && token === bypassToken) {
  console.log(`🚨 BYPASS USED: ${req.method} ${req.path} by ${req.ip}`);
  // Log to monitoring system
}
```

### Metrics

Track bypass metrics:

- Number of bypass requests per hour/day
- Which endpoints use bypass most
- IP addresses using bypass tokens

## Emergency Procedures

### Quick Disable

To immediately disable bypass:

```bash
# Set environment variable
export AUTH_BYPASS_ENABLED=false

# Or restart with new config
AUTH_BYPASS_ENABLED=false node app.js
```

### Token Rotation

To rotate bypass token:

```bash
# Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# Update environment
export AUTH_BYPASS_TOKEN=$NEW_TOKEN

# Restart application
```

## Best Practices

1. **Use bypass sparingly** - only when necessary
2. **Document bypass usage** - keep records of when and why
3. **Time-box bypass sessions** - disable after completing task
4. **Use different tokens per environment** - don't reuse tokens
5. **Monitor bypass activity** - track usage patterns
6. **Regular security reviews** - audit bypass usage regularly

## Support

For issues with the bypass functionality:

1. Check this documentation
2. Run the test script
3. Review application logs
4. Verify environment configuration
5. Contact the development team

---

**Remember: Authorization bypass should be used responsibly and only when necessary. Always prioritize security over convenience.**
