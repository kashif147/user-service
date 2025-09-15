# Centralized RBAC Testing Guide

## Overview

This guide provides comprehensive testing strategies for the centralized RBAC implementation using `node-policy-client.js` SDK.

## Prerequisites

### 1. Environment Setup

```bash
# Ensure your user-service is running
npm start

# Check if policy evaluation service is running
curl http://localhost:3000/policy/info
```

### 2. Test Data Setup

You'll need valid JWT tokens with different roles and permissions for testing.

## Testing Strategy

### 1. Unit Tests

Test individual components in isolation.

### 2. Integration Tests

Test the complete authorization flow.

### 3. End-to-End Tests

Test real API endpoints with different user scenarios.

## Test Scenarios

### Scenario 1: Super User (SU) Access

**Token**: JWT with `roles: ["SU"]`
**Expected**: Full access to all resources

### Scenario 2: Assistant Super User (ASU) Access

**Token**: JWT with `roles: ["ASU"]`
**Expected**: Limited access based on tenant scope

### Scenario 3: Regular User Access

**Token**: JWT with `roles: ["USER"]`
**Expected**: Minimal access, mostly read-only

### Scenario 4: Invalid/Expired Token

**Token**: Invalid or expired JWT
**Expected**: 401 Unauthorized

### Scenario 5: Missing Token

**Token**: No Authorization header
**Expected**: 401 Unauthorized

## Test Cases by Resource

### Tenant Management Tests

| Endpoint           | Method | SU  | ASU | USER | Invalid Token |
| ------------------ | ------ | --- | --- | ---- | ------------- |
| `/api/tenants`     | POST   | ✅  | ❌  | ❌   | ❌            |
| `/api/tenants`     | GET    | ✅  | ❌  | ❌   | ❌            |
| `/api/tenants/:id` | GET    | ✅  | ❌  | ❌   | ❌            |
| `/api/tenants/:id` | PUT    | ✅  | ❌  | ❌   | ❌            |
| `/api/tenants/:id` | DELETE | ✅  | ❌  | ❌   | ❌            |

### Role Management Tests

| Endpoint         | Method | SU  | ASU | USER | Invalid Token |
| ---------------- | ------ | --- | --- | ---- | ------------- |
| `/api/roles`     | POST   | ✅  | ❌  | ❌   | ❌            |
| `/api/roles`     | GET    | ✅  | ✅  | ❌   | ❌            |
| `/api/roles/:id` | GET    | ✅  | ✅  | ❌   | ❌            |
| `/api/roles/:id` | PUT    | ✅  | ❌  | ❌   | ❌            |
| `/api/roles/:id` | DELETE | ✅  | ❌  | ❌   | ❌            |

### Permission Management Tests

| Endpoint               | Method | SU  | ASU | USER | Invalid Token |
| ---------------------- | ------ | --- | --- | ---- | ------------- |
| `/api/permissions`     | POST   | ✅  | ❌  | ❌   | ❌            |
| `/api/permissions`     | GET    | ✅  | ❌  | ❌   | ❌            |
| `/api/permissions/:id` | GET    | ✅  | ❌  | ❌   | ❌            |
| `/api/permissions/:id` | PUT    | ✅  | ❌  | ❌   | ❌            |
| `/api/permissions/:id` | DELETE | ✅  | ❌  | ❌   | ❌            |

### User Management Tests

| Endpoint         | Method | SU  | ASU | USER | Invalid Token |
| ---------------- | ------ | --- | --- | ---- | ------------- |
| `/api/users`     | POST   | ✅  | ✅  | ❌   | ❌            |
| `/api/users`     | GET    | ✅  | ✅  | ❌   | ❌            |
| `/api/users/:id` | GET    | ✅  | ✅  | ✅\* | ❌            |
| `/api/users/:id` | PUT    | ✅  | ✅  | ❌   | ❌            |
| `/api/users/:id` | DELETE | ✅  | ❌  | ❌   | ❌            |

\*USER can only access their own profile

## Testing Tools

### 1. Postman Collection

Create a Postman collection with all test scenarios.

### 2. cURL Commands

Use cURL for quick API testing.

### 3. Automated Test Scripts

Create Node.js test scripts for comprehensive testing.

## Error Response Testing

### Expected Error Responses

```json
// 401 Unauthorized (Missing Token)
{
  "success": false,
  "error": "Authorization token required",
  "code": "MISSING_TOKEN"
}

// 403 Forbidden (Insufficient Permissions)
{
  "success": false,
  "error": "Insufficient permissions",
  "reason": "INSUFFICIENT_ROLE",
  "code": "PERMISSION_DENIED",
  "resource": "tenant",
  "action": "create"
}

// 500 Internal Server Error (Policy Service Error)
{
  "success": false,
  "error": "Authorization service error",
  "code": "POLICY_SERVICE_ERROR"
}
```

## Performance Testing

### 1. Cache Performance

- Test cache hit rates
- Test cache expiration
- Test cache invalidation

### 2. Response Times

- Measure authorization overhead
- Test batch evaluation performance
- Test concurrent requests

### 3. Fallback Behavior

- Test policy service downtime
- Test network failures
- Test timeout scenarios

## Security Testing

### 1. Token Manipulation

- Test with modified tokens
- Test with expired tokens
- Test with tokens from different tenants

### 2. Privilege Escalation

- Test role escalation attempts
- Test tenant boundary violations
- Test permission bypass attempts

### 3. Input Validation

- Test malformed requests
- Test SQL injection attempts
- Test XSS attempts

## Monitoring and Logging

### 1. Authorization Logs

Monitor authorization decisions and failures.

### 2. Performance Metrics

Track response times and cache performance.

### 3. Error Rates

Monitor authorization error rates and types.

## Test Data Requirements

### JWT Token Structure

```json
{
  "sub": "user-id",
  "tid": "tenant-id",
  "roles": ["SU"],
  "permissions": ["*"],
  "iat": 1234567890,
  "exp": 1234567890
}
```

### Test Users

- Super User (SU): Full access
- Assistant Super User (ASU): Tenant-scoped access
- Regular User (USER): Limited access
- Invalid User: No access

## Automated Testing Scripts

### 1. Basic Authorization Test

```javascript
const testAuthorization = async (token, resource, action, expectedResult) => {
  // Test implementation
};
```

### 2. End-to-End Test Suite

```javascript
const runE2ETests = async () => {
  // Complete test suite
};
```

### 3. Performance Test Suite

```javascript
const runPerformanceTests = async () => {
  // Performance testing
};
```

## Troubleshooting

### Common Issues

1. **Policy Service Not Running**: Check if policy evaluation service is accessible
2. **Token Issues**: Verify JWT token format and expiration
3. **Cache Issues**: Clear policy client cache if needed
4. **Network Issues**: Check connectivity to policy service

### Debug Commands

```bash
# Check policy service status
curl http://localhost:3000/policy/info

# Test policy evaluation
curl -X POST http://localhost:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -d '{"token":"your-jwt-token","resource":"tenant","action":"read"}'

# Check cache statistics
curl http://localhost:3000/policy/cache-stats
```

## Success Criteria

### Functional Requirements

- ✅ All endpoints properly protected
- ✅ Correct authorization decisions
- ✅ Proper error responses
- ✅ Tenant isolation maintained

### Performance Requirements

- ✅ Authorization overhead < 100ms
- ✅ Cache hit rate > 80%
- ✅ 99.9% uptime for policy service

### Security Requirements

- ✅ No privilege escalation possible
- ✅ Proper token validation
- ✅ Secure error handling
- ✅ Audit logging enabled
