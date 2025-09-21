# Centralized RBAC Testing Checklist

## Pre-Testing Setup ✅

### 1. Environment Setup

- [ ] User service is running (`npm start`)
- [ ] Policy evaluation service is accessible
- [ ] Database connection is working
- [ ] Redis cache is running (if used)

### 2. Test Data Preparation

- [ ] Valid JWT tokens generated for different roles
- [ ] Test tenant data available
- [ ] Test user data available
- [ ] Test role and permission data available

## Testing Methods Available

### 1. Automated Node.js Tests

```bash
# Test all RBAC endpoints
npm run test:rbac

# Test policy middleware directly
npm run test:policy
```

### 2. Manual cURL Tests

```bash
# Run comprehensive cURL test suite
npm run test:curl
```

### 3. Individual Endpoint Testing

Use the provided cURL commands in `test-rbac.sh` for specific endpoint testing.

## Test Scenarios Checklist

### ✅ Authentication Tests

- [ ] Valid JWT token accepted
- [ ] Invalid JWT token rejected (401)
- [ ] Expired JWT token rejected (401)
- [ ] Missing Authorization header rejected (401)
- [ ] Malformed Authorization header rejected (401)

### ✅ Authorization Tests by Resource

#### Tenant Management

- [ ] SU can create tenants (200)
- [ ] SU can read tenants (200)
- [ ] SU can update tenants (200)
- [ ] SU can delete tenants (200)
- [ ] ASU cannot create tenants (403)
- [ ] ASU cannot read tenants (403)
- [ ] ASU cannot update tenants (403)
- [ ] ASU cannot delete tenants (403)
- [ ] USER cannot access tenant endpoints (403)

#### Role Management

- [ ] SU can create roles (200)
- [ ] SU can read roles (200)
- [ ] SU can update roles (200)
- [ ] SU can delete roles (200)
- [ ] ASU can read roles (200)
- [ ] ASU cannot create roles (403)
- [ ] ASU cannot update roles (403)
- [ ] ASU cannot delete roles (403)
- [ ] USER cannot access role endpoints (403)

#### Permission Management

- [ ] SU can create permissions (200)
- [ ] SU can read permissions (200)
- [ ] SU can update permissions (200)
- [ ] SU can delete permissions (200)
- [ ] ASU cannot access permission endpoints (403)
- [ ] USER cannot access permission endpoints (403)

#### User Management

- [ ] SU can create users (200)
- [ ] SU can read users (200)
- [ ] SU can update users (200)
- [ ] SU can delete users (200)
- [ ] ASU can create users (200)
- [ ] ASU can read users (200)
- [ ] ASU can update users (200)
- [ ] ASU cannot delete users (403)
- [ ] USER cannot create users (403)
- [ ] USER cannot read users (403)
- [ ] USER cannot update users (403)
- [ ] USER cannot delete users (403)

### ✅ Policy Service Tests

- [ ] Policy info endpoint accessible (200)
- [ ] Policy evaluation with valid token (200/403)
- [ ] Policy evaluation with invalid token (403)
- [ ] Batch policy evaluation works
- [ ] Policy cache is working
- [ ] Policy service fallback on failure

### ✅ Error Handling Tests

- [ ] Proper error messages returned
- [ ] Correct HTTP status codes
- [ ] Error logging is working
- [ ] Graceful degradation on service failure

### ✅ Performance Tests

- [ ] Authorization overhead < 100ms
- [ ] Cache hit rate > 80%
- [ ] Concurrent request handling
- [ ] Memory usage is reasonable

### ✅ Security Tests

- [ ] No privilege escalation possible
- [ ] Tenant isolation maintained
- [ ] Token validation is secure
- [ ] No sensitive data in error messages

## Expected Results Summary

| User Role | Tenant | Role | Permission | User |
| --------- | ------ | ---- | ---------- | ---- |
| SU        | Full   | Full | Full       | Full |
| ASU       | None   | Read | None       | CRUD |
| USER      | None   | None | None       | None |

## Common Issues & Solutions

### Issue: Policy Service Not Running

**Solution**: Ensure policy evaluation service is running on the correct port

### Issue: JWT Token Invalid

**Solution**: Check JWT_SECRET environment variable and token format

### Issue: Cache Not Working

**Solution**: Clear cache and check Redis connection

### Issue: Authorization Always Denies

**Solution**: Check policy rules and user permissions

## Testing Commands Quick Reference

```bash
# Start the service
npm start

# Run all automated tests
npm run test:rbac

# Test policy middleware
npm run test:policy

# Run cURL tests
npm run test:curl

# Check service health
curl http://localhost:3000/policy/info

# Test specific endpoint
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/tenants
```

## Success Criteria

### ✅ Functional Requirements

- All endpoints properly protected
- Correct authorization decisions
- Proper error responses
- Tenant isolation maintained

### ✅ Performance Requirements

- Authorization overhead < 100ms
- Cache hit rate > 80%
- 99.9% uptime for policy service

### ✅ Security Requirements

- No privilege escalation possible
- Proper token validation
- Secure error handling
- Audit logging enabled

## Next Steps After Testing

1. **Fix Issues**: Address any failing tests
2. **Performance Tuning**: Optimize slow endpoints
3. **Security Review**: Review authorization logic
4. **Documentation**: Update API documentation
5. **Production Deployment**: Deploy to production environment
