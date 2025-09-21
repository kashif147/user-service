# PDP Migration - Developer Handoff Guide

## 🎯 What Has Been Implemented

The user-service has been successfully migrated to a **Policy Decision Point (PDP)** architecture. All authorization decisions now flow through centralized policy evaluation instead of inline role/permission checks.

## 🔧 Key Changes Made

### 1. New Components Added

- **`helpers/policyAdapter.js`** - Thin adapter for PDP integration
- **Enhanced PDP endpoints** in `routes/policy.routes.js`
- **Updated policy evaluation service** with tenant isolation
- **Enhanced Redis cache** with tenant-isolated keys
- **Uniform error handlers** in `app.js`

### 2. Updated Components

- **Lookup routes** (`routes/lookup.router.js`) - Now use policyAdapter middleware
- **LookupType routes** (`routes/lookuptype.router.js`) - Now use policyAdapter middleware
- **Role routes** (`routes/role.routes.js`) - Replaced requireRole with policyAdapter
- **Permission routes** (`routes/permission.routes.js`) - Replaced requireRole with policyAdapter

### 3. Resources Now Supported

- `lookup` (read, write, delete)
- `lookupType` (read, write, delete)
- `role` (read, admin)
- `permission` (admin)
- Plus existing: `portal`, `crm`, `admin`, `api`, `user`

## 🚀 Quick Start for Testing

### 1. Setup Environment

```bash
# Run the setup script
node setup-migration-testing.js

# Start the service
npm run dev
```

### 2. Run Tests

```bash
# Comprehensive test suite (recommended)
node test-migration-comprehensive.js

# Basic PDP tests
node test-pdp-implementation.js
```

### 3. Manual Testing

```bash
# Test health endpoint
curl http://localhost:3000/policy/health

# Test policy evaluation (replace YOUR_TOKEN)
curl -X POST http://localhost:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_TOKEN",
    "resource": "lookup",
    "action": "read",
    "context": {"tenantId": "your-tenant-id"}
  }'
```

## 📋 Testing Checklist

### ✅ Core Functionality

- [ ] Service starts without errors
- [ ] PDP endpoints respond correctly
- [ ] Authentication still works
- [ ] Authorization decisions are correct
- [ ] Tenant isolation is enforced
- [ ] Error responses follow uniform format

### ✅ New Features

- [ ] Lookup endpoints are protected
- [ ] LookupType endpoints are protected
- [ ] Policy version headers are present
- [ ] Cache functionality works
- [ ] Batch evaluation works

### ✅ Backward Compatibility

- [ ] Existing user endpoints work
- [ ] Existing role endpoints work
- [ ] JWT authentication unchanged
- [ ] Database operations unchanged
- [ ] Client applications unaffected

## 🔍 What to Test

### 1. Authentication Flow

```bash
# Should return 401
curl http://localhost:3000/lookups

# Should return 200 or 403 (depending on permissions)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups
```

### 2. Authorization Flow

```bash
# Test different permission levels
curl -H "Authorization: Bearer SUPER_USER_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups

curl -H "Authorization: Bearer LIMITED_USER_TOKEN" \
     -H "X-Tenant-ID: your-tenant-id" \
     http://localhost:3000/lookups
```

### 3. Tenant Isolation

```bash
# Should be denied
curl -X POST http://localhost:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_TOKEN",
    "resource": "lookup",
    "action": "read",
    "context": {"tenantId": "different-tenant"}
  }'
```

### 4. Error Response Format

All error responses should follow this format:

```json
{
  "authorized": false,
  "reason": "PERMISSION_DENIED",
  "requiredRoles": [],
  "requiredPermissions": [],
  "userRoles": [],
  "userPermissions": [],
  "policyVersion": "1.0.0",
  "correlationId": "uuid"
}
```

## 🛠️ Configuration

### Environment Variables

```bash
# Required
JWT_SECRET=your-jwt-secret

# Optional (with defaults)
POLICY_VERSION=1.0.0
REDIS_ENABLED=true
POLICY_CACHE_TTL=300
REDIS_URL=redis://localhost:6379
```

### Redis Configuration

- **Primary**: Redis cache with tenant isolation
- **Fallback**: Local in-memory cache
- **TTL**: 5 minutes (configurable)
- **Keys**: `tenantId:tokenHash:resource:action:context`

## 📊 Monitoring

### Key Metrics to Watch

- PDP endpoint response times
- Cache hit rates
- Error rates by endpoint
- Tenant isolation violations

### Health Checks

```bash
# Service health
curl http://localhost:3000/policy/health

# Cache stats
curl http://localhost:3000/policy/cache/stats

# Policy info
curl http://localhost:3000/policy/info
```

## 🚨 Troubleshooting

### Common Issues

1. **401 Errors**

   - Check JWT token validity
   - Verify Authorization header format
   - Check token expiration

2. **403 Errors**

   - Verify user roles and permissions
   - Check tenant ID matching
   - Review resource-action mapping

3. **Cache Issues**

   - Check Redis connection
   - Verify cache key generation
   - Test local fallback

4. **Performance Issues**
   - Monitor cache hit rates
   - Check batch evaluation limits
   - Review policy complexity

### Debug Commands

```bash
# Test policy evaluation directly
curl -X POST http://localhost:3000/policy/evaluate \
  -H "Content-Type: application/json" \
  -d '{"token":"TOKEN","resource":"lookup","action":"read","context":{"tenantId":"tenant"}}'

# Check cache status
curl http://localhost:3000/policy/cache/stats

# Clear cache
curl -X DELETE http://localhost:3000/policy/cache
```

## 🔄 Rollback Plan

If issues are found:

### Immediate Rollback

```bash
# Revert to previous version
git checkout previous-commit
npm install
npm run dev
```

### Partial Rollback

- Keep PDP endpoints
- Revert specific route files to old middleware
- Test incrementally

### Configuration Rollback

```bash
# Disable Redis caching
export REDIS_ENABLED="false"

# Use local fallback only
export POLICY_CACHE_TTL="60"
```

## 📚 Documentation

### Files Created

- `PDP-IMPLEMENTATION-SUMMARY.md` - Detailed implementation overview
- `PDP-MIGRATION-TESTING-GUIDE.md` - Comprehensive testing guide
- `test-migration-comprehensive.js` - Full test suite
- `test-pdp-implementation.js` - Basic PDP tests
- `setup-migration-testing.js` - Setup script

### API Documentation

- All PDP endpoints documented in `routes/policy.routes.js`
- Policy adapter usage in `helpers/policyAdapter.js`
- Error response formats in `app.js`

## 🎯 Next Steps

### For Developers

1. **Run Tests**: Execute the comprehensive test suite
2. **Validate**: Ensure all existing functionality works
3. **Monitor**: Watch for any performance issues
4. **Document**: Update any client integration guides

### For Deployment

1. **Staging**: Deploy to staging environment first
2. **Testing**: Run full test suite in staging
3. **Production**: Deploy during maintenance window
4. **Monitoring**: Monitor closely for first 24 hours

### For Client Applications

1. **Update SDKs**: Use new PDP endpoints for authorization
2. **Error Handling**: Update to handle new error response format
3. **Testing**: Test client-side authorization flows
4. **Documentation**: Update client integration guides

## 🆘 Support

### Getting Help

- Check the troubleshooting section above
- Review the comprehensive testing guide
- Run the diagnostic commands
- Check service logs for errors

### Emergency Contacts

- **Service Issues**: Check `logs/error.log`
- **Cache Issues**: Check `logs/policy-evaluation.log`
- **Performance Issues**: Monitor cache hit rates

## ✅ Success Criteria

The migration is successful when:

- [ ] All tests pass (100% success rate)
- [ ] Existing endpoints work unchanged
- [ ] New PDP endpoints respond correctly
- [ ] Tenant isolation is enforced
- [ ] Error responses follow uniform format
- [ ] Cache functionality works
- [ ] Performance is acceptable
- [ ] No security vulnerabilities introduced

---

**🎉 The PDP migration is complete and ready for testing!**

Follow the testing guide and run the comprehensive test suite to validate the implementation before production deployment.
