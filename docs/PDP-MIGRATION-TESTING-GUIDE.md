# PDP Migration Testing Guide

## Overview

This guide provides comprehensive testing procedures to ensure all existing endpoints continue working correctly after migrating to the Policy Decision Point (PDP) architecture.

## Pre-Migration Checklist

### 1. Environment Setup

```bash
# Ensure Redis is running (optional - has local fallback)
redis-server

# Set environment variables
export POLICY_VERSION="1.0.0"
export REDIS_ENABLED="true"
export POLICY_CACHE_TTL="300"
export JWT_SECRET="your-jwt-secret"

# Start the service
npm run dev
```

### 2. Verify Service Health

```bash
# Test basic health endpoints
curl http://localhost:3000/policy/health
curl http://localhost:3000/policy/info
curl http://localhost:3000/policy/cache/stats
```

Expected responses:

- Status: 200
- Headers: `X-Policy-Version: 1.0.0`
- Body: Service information and cache stats

## Testing Existing Endpoints

### 1. Authentication Endpoints

Test that JWT authentication still works:

```bash
# Test with valid token
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/auth/validate

# Test with invalid token (should return 401)
curl -H "Authorization: Bearer invalid-token" \
     http://localhost:3000/auth/validate
```

**Expected Behavior:**

- Valid tokens: 200 with user context
- Invalid tokens: 401 with uniform PDP response format

### 2. User Management Endpoints

Test all user CRUD operations:

```bash
# Create user (requires user:write permission)
curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test User","email":"test@example.com"}' \
     http://localhost:3000/users

# Get all users (requires user:read permission)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/users

# Get specific user (requires user:read permission)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/users/USER_ID

# Update user (requires user:write permission)
curl -X PUT \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Updated User"}' \
     http://localhost:3000/users/USER_ID

# Delete user (requires user:delete permission)
curl -X DELETE \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/users/USER_ID
```

**Expected Behavior:**

- Users with appropriate roles: 200/201 with data
- Users without permissions: 403 with uniform PDP response
- Missing token: 401 with uniform PDP response

### 3. Role Management Endpoints

Test role operations:

```bash
# Create role (requires role:admin permission)
curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test Role","code":"TR"}' \
     http://localhost:3000/roles

# Get all roles (requires role:read permission)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/roles

# Assign role to user (requires role:admin permission)
curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"userId":"USER_ID","roleCode":"TR"}' \
     http://localhost:3000/roles/users/assign-role
```

**Expected Behavior:**

- Super Users (SU): Full access to all operations
- Assistant Super Users (ASU): Read access only
- Other roles: 403 for admin operations

### 4. Lookup Management Endpoints (NEW)

Test the newly protected lookup endpoints:

```bash
# Get all lookups (requires lookup:read permission)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups

# Create lookup (requires lookup:write permission)
curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test Lookup","value":"test-value","lookupType":"TEST"}' \
     http://localhost:3000/lookups

# Update lookup (requires lookup:write permission)
curl -X PUT \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Updated Lookup"}' \
     http://localhost:3000/lookups/LOOKUP_ID

# Delete lookup (requires lookup:delete permission)
curl -X DELETE \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups/LOOKUP_ID
```

### 5. LookupType Management Endpoints (NEW)

Test lookup type operations:

```bash
# Get all lookup types (requires lookupType:read permission)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookupTypes

# Create lookup type (requires lookupType:write permission)
curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     -H "Content-Type: application/json" \
     -d '{"name":"Test Type","code":"TEST"}' \
     http://localhost:3000/lookupTypes
```

## PDP Endpoint Testing

### 1. Single Policy Evaluation

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -H "X-Correlation-ID: test-correlation-123" \
     -d '{
       "token": "YOUR_JWT_TOKEN",
       "resource": "lookup",
       "action": "read",
       "context": {
         "tenantId": "your-tenant-id"
       }
     }' \
     http://localhost:3000/policy/evaluate
```

**Expected Response:**

```json
{
  "authorized": true,
  "decision": "PERMIT",
  "user": { "id": "user-id", "tenantId": "tenant-id" },
  "resource": "lookup",
  "action": "read",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "policyVersion": "1.0.0",
  "correlationId": "test-correlation-123"
}
```

### 2. Batch Policy Evaluation

```bash
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{
       "requests": [
         {
           "token": "YOUR_JWT_TOKEN",
           "resource": "lookup",
           "action": "read",
           "context": {"tenantId": "your-tenant-id"}
         },
         {
           "token": "YOUR_JWT_TOKEN",
           "resource": "lookupType",
           "action": "write",
           "context": {"tenantId": "your-tenant-id"}
         }
       ]
     }' \
     http://localhost:3000/policy/evaluate-batch
```

### 3. Quick Authorization Check

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/policy/check/lookup/read
```

### 4. Get Effective Permissions

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/policy/permissions/lookup
```

## Tenant Isolation Testing

### 1. Cross-Tenant Access Test

```bash
# Test with different tenant ID in context
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{
       "token": "YOUR_JWT_TOKEN",
       "resource": "lookup",
       "action": "read",
       "context": {
         "tenantId": "different-tenant-id"
       }
     }' \
     http://localhost:3000/policy/evaluate
```

**Expected Response:**

```json
{
  "authorized": false,
  "reason": "TENANT_MISMATCH",
  "requiredRoles": [],
  "requiredPermissions": [],
  "userRoles": [],
  "userPermissions": [],
  "policyVersion": "1.0.0",
  "correlationId": "..."
}
```

### 2. Missing Tenant Test

```bash
# Test without tenant ID
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{
       "token": "YOUR_JWT_TOKEN",
       "resource": "lookup",
       "action": "read",
       "context": {}
     }' \
     http://localhost:3000/policy/evaluate
```

## Error Response Testing

### 1. Missing Token Test

```bash
curl http://localhost:3000/lookups
```

**Expected Response:**

```json
{
  "authorized": false,
  "reason": "MISSING_TOKEN",
  "requiredRoles": [],
  "requiredPermissions": [],
  "userRoles": [],
  "userPermissions": [],
  "policyVersion": "1.0.0",
  "correlationId": "..."
}
```

### 2. Insufficient Permissions Test

```bash
# Use token with limited permissions
curl -H "Authorization: Bearer LIMITED_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups
```

## Automated Testing Script

Run the comprehensive test suite:

```bash
# Set test token
export TEST_TOKEN="your-jwt-token"

# Run all tests
node test-pdp-implementation.js
```

## Performance Testing

### 1. Cache Performance

```bash
# Test cache hit rate
curl http://localhost:3000/policy/cache/stats

# Clear cache and test again
curl -X DELETE http://localhost:3000/policy/cache
```

### 2. Batch Evaluation Performance

```bash
# Test with multiple requests
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{
       "requests": [
         {"token": "TOKEN", "resource": "lookup", "action": "read", "context": {"tenantId": "tenant"}},
         {"token": "TOKEN", "resource": "lookup", "action": "write", "context": {"tenantId": "tenant"}},
         {"token": "TOKEN", "resource": "lookupType", "action": "read", "context": {"tenantId": "tenant"}},
         {"token": "TOKEN", "resource": "lookupType", "action": "write", "context": {"tenantId": "tenant"}},
         {"token": "TOKEN", "resource": "role", "action": "read", "context": {"tenantId": "tenant"}}
       ]
     }' \
     http://localhost:3000/policy/evaluate-batch
```

## Migration Validation Checklist

### ✅ Authentication

- [ ] JWT token validation works
- [ ] User context is properly set
- [ ] Tenant ID is extracted correctly

### ✅ Authorization

- [ ] Role-based access control works
- [ ] Permission-based access control works
- [ ] Super User bypass works
- [ ] Tenant isolation is enforced

### ✅ Error Handling

- [ ] 401 responses follow uniform format
- [ ] 403 responses follow uniform format
- [ ] Correlation IDs are included
- [ ] Policy version headers are set

### ✅ Caching

- [ ] Redis cache works (if enabled)
- [ ] Local fallback works (if Redis disabled)
- [ ] Cache keys include tenant ID
- [ ] Cache invalidation works

### ✅ New Resources

- [ ] Lookup endpoints are protected
- [ ] LookupType endpoints are protected
- [ ] Permission mapping is correct
- [ ] Resource access matrix includes new resources

### ✅ PDP Endpoints

- [ ] Single evaluation works
- [ ] Batch evaluation works
- [ ] Quick check works
- [ ] Permissions endpoint works
- [ ] Health check works
- [ ] Cache management works

## Rollback Plan

If issues are found:

1. **Immediate Rollback:**

   ```bash
   # Revert to previous version
   git checkout previous-commit
   npm install
   npm run dev
   ```

2. **Partial Rollback:**

   - Keep PDP endpoints
   - Revert specific route files to old middleware
   - Test incrementally

3. **Configuration Rollback:**

   ```bash
   # Disable Redis caching
   export REDIS_ENABLED="false"

   # Use local fallback only
   export POLICY_CACHE_TTL="60"
   ```

## Monitoring and Alerts

### Key Metrics to Monitor:

- PDP endpoint response times
- Cache hit rates
- Error rates by endpoint
- Tenant isolation violations
- Policy evaluation failures

### Log Monitoring:

```bash
# Monitor PDP logs
tail -f logs/policy-evaluation.log

# Monitor error logs
tail -f logs/error.log | grep "PDP\|policy"
```

## Support and Troubleshooting

### Common Issues:

1. **401 Errors:**

   - Check JWT token validity
   - Verify Authorization header format
   - Check token expiration

2. **403 Errors:**

   - Verify user roles and permissions
   - Check tenant ID matching
   - Review resource-action mapping

3. **Cache Issues:**

   - Check Redis connection
   - Verify cache key generation
   - Test local fallback

4. **Performance Issues:**
   - Monitor cache hit rates
   - Check batch evaluation limits
   - Review policy complexity

### Debug Commands:

```bash
# Test policy evaluation directly
curl -X POST http://localhost:3000/policy/evaluate \
     -H "Content-Type: application/json" \
     -d '{"token":"TOKEN","resource":"lookup","action":"read","context":{"tenantId":"tenant"}}'

# Check cache status
curl http://localhost:3000/policy/cache/stats

# Test health
curl http://localhost:3000/policy/health
```

## Next Steps After Testing

1. **Deploy to Staging:**

   - Run full test suite
   - Monitor performance metrics
   - Test with production-like data

2. **Update Client Applications:**

   - Update SDKs to use new PDP endpoints
   - Test client-side authorization
   - Update error handling

3. **Production Deployment:**

   - Deploy during maintenance window
   - Monitor closely for first 24 hours
   - Have rollback plan ready

4. **Documentation Updates:**
   - Update API documentation
   - Update client integration guides
   - Update troubleshooting guides
