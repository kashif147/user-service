# GET /me Endpoint - Secure User Profile API

## Overview

The `/me` endpoint provides a minimal, authoritative snapshot of the signed-in user with comprehensive security measures, tenant isolation, and caching support. This endpoint is designed for frontend consumption and follows OWASP Top 10 security guidelines.

## Endpoint Specification

```
GET /me
```

### Authentication

- **Required**: Bearer token in Authorization header
- **Token Source**: Azure AD / B2C access token
- **Validation**: JWT verification with tenant isolation

### Request Headers

```
Authorization: Bearer <jwt-token>
If-None-Match: <etag> (optional, for 304 responses)
X-Correlation-ID: <id> (optional, for request tracking)
```

### Response Headers

```
ETag: <hash> (for caching)
X-Policy-Version: <version> (policy version)
Cache-Control: private, max-age=300
```

## Response Format

### Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "user-id",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "fullName": "John Doe",
    "userType": "PORTAL",
    "tenantId": "tenant-id",
    "roles": [
      {
        "code": "MEMBER",
        "name": "Member",
        "description": "Standard member role",
        "userType": "PORTAL"
      }
    ],
    "permissions": ["user:read", "profile:update"],
    "isActive": true,
    "memberSince": "2024-01-01T00:00:00.000Z"
  },
  "policyVersion": 1,
  "correlationId": "req-uuid"
}
```

### Conditional Response (304)

When `If-None-Match` header matches current ETag:

- Status: 304 Not Modified
- Body: Empty
- Headers: ETag, X-Policy-Version

### Error Responses

#### 401 Unauthorized

```json
{
  "error": {
    "message": "Authorization header required",
    "code": "MISSING_TOKEN",
    "status": 401,
    "correlationId": "req-uuid"
  }
}
```

#### 403 Forbidden (Tenant Mismatch)

```json
{
  "error": {
    "message": "TENANT_MISMATCH",
    "code": "TENANT_MISMATCH",
    "status": 403,
    "correlationId": "req-uuid"
  }
}
```

#### 429 Too Many Requests

```json
{
  "error": {
    "message": "Too many profile requests",
    "code": "RATE_LIMIT_EXCEEDED",
    "status": 429,
    "retryAfter": "15 minutes",
    "correlationId": "req-uuid"
  }
}
```

## Security Features

### OWASP Top 10 Compliance

1. **A01: Broken Access Control**

   - Tenant isolation enforced at database level
   - JWT token validation with tenant context
   - Role-based access control

2. **A02: Cryptographic Failures**

   - JWT tokens signed with secure secret
   - ETag generation using MD5 hash
   - HTTPS/TLS enforcement

3. **A03: Injection**

   - Parameterized database queries
   - Input validation and sanitization
   - No SQL injection vectors

4. **A04: Insecure Design**

   - Minimal data exposure principle
   - Secure by default configuration
   - Defense in depth architecture

5. **A05: Security Misconfiguration**

   - Helmet security headers
   - Strict CORS policy
   - Disabled x-powered-by header

6. **A06: Vulnerable Components**

   - Regular dependency updates
   - Security audit compliance
   - Pinned dependency versions

7. **A07: Authentication Failures**

   - JWT token validation
   - Token expiration handling
   - Secure token storage

8. **A08: Software Integrity Failures**

   - Code signing verification
   - Dependency integrity checks
   - Secure deployment pipeline

9. **A09: Logging Failures**

   - No sensitive data in logs
   - Correlation ID tracking
   - Audit trail maintenance

10. **A10: Server-Side Request Forgery**
    - No external request capabilities
    - Input validation
    - Network isolation

### Rate Limiting

- **Limit**: 50 requests per 15 minutes per IP
- **Scope**: /me endpoint specific
- **Bypass**: Super users and development mode
- **Headers**: Standard rate limit headers included

### CORS Configuration

```javascript
{
  origin: ["http://localhost:3000", "http://localhost:3001"],
  credentials: true,
  methods: ["GET"],
  allowedHeaders: ["Authorization", "X-Correlation-ID", "If-None-Match"]
}
```

## Caching Strategy

### Redis Cache

- **Key Format**: `me:user:{tenantId}:{userId}`
- **TTL**: 300 seconds (5 minutes)
- **Fallback**: Database on cache miss
- **Invalidation**: On role/permission changes

### ETag Support

- **Generation**: MD5 hash of user data
- **Format**: `"hash-value"`
- **Usage**: Conditional requests (304 responses)
- **Update**: On data changes

### Cache Invalidation Triggers

- User role assignments
- Role permission changes
- User profile updates
- Policy rule modifications

## Policy Version Management

### Version Tracking

- **Format**: Monotonically increasing integer
- **Increment**: On admin changes
- **Header**: `X-Policy-Version`
- **Purpose**: Client-side cache invalidation

### Version Bump Scenarios

1. Role assignment changes
2. Permission modifications
3. Policy rule updates
4. Cache invalidation events

## Tenant Isolation

### Enforcement Points

1. **JWT Token**: Tenant ID validation
2. **Database Queries**: Tenant-scoped queries
3. **Cache Keys**: Tenant-specific keys
4. **Response Data**: Tenant context validation

### Isolation Guarantees

- Users can only access their tenant's data
- Cross-tenant access attempts return 403
- Cache keys include tenant ID
- Database queries filtered by tenant

## Performance Considerations

### Caching Benefits

- **Redis Hit**: ~1ms response time
- **Database Fallback**: ~50ms response time
- **Cache Miss**: Automatic repopulation
- **Memory Usage**: Minimal per user

### Optimization Features

- **Conditional Requests**: 304 responses
- **Minimal Payload**: Only essential data
- **Compression**: Gzip compression enabled
- **Connection Pooling**: Database connection reuse

## Monitoring and Logging

### Metrics Tracked

- Request count and response times
- Cache hit/miss ratios
- Rate limit violations
- Error rates by type

### Logging Guidelines

- **No PII**: No sensitive data in logs
- **Correlation IDs**: Request tracking
- **Error Context**: Sufficient for debugging
- **Audit Trail**: Security event logging

### Health Checks

- Redis connectivity
- Database connectivity
- Cache performance
- Policy version status

## Usage Examples

### Basic Request

```bash
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer <jwt-token>" \
  -H "X-Correlation-ID: req-123"
```

### Conditional Request

```bash
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer <jwt-token>" \
  -H "If-None-Match: \"abc123def456\""
```

### JavaScript Client

```javascript
const response = await fetch("/me", {
  headers: {
    Authorization: `Bearer ${token}`,
    "X-Correlation-ID": generateUUID(),
  },
});

if (response.status === 304) {
  // Use cached data
} else if (response.ok) {
  const data = await response.json();
  const etag = response.headers.get("ETag");
  const policyVersion = response.headers.get("X-Policy-Version");
  // Update UI with new data
}
```

## Error Handling

### Client-Side Error Handling

```javascript
try {
  const response = await fetch("/me");

  if (response.status === 401) {
    // Redirect to login
    redirectToLogin();
  } else if (response.status === 403) {
    // Show access denied
    showAccessDenied();
  } else if (response.status === 429) {
    // Show rate limit message
    showRateLimitMessage();
  } else if (!response.ok) {
    // Handle other errors
    handleError(response);
  }
} catch (error) {
  // Handle network errors
  handleNetworkError(error);
}
```

## Testing

### Acceptance Tests

Run the comprehensive test suite:

```bash
./test-me-endpoint.sh
```

### Test Scenarios Covered

1. ✅ Startup flow with valid token
2. ✅ Conditional requests (304 responses)
3. ✅ Cache invalidation on role changes
4. ✅ Cross-tenant access prevention
5. ✅ Redis miss fallback to database
6. ✅ Rate limiting enforcement
7. ✅ Missing token handling
8. ✅ Invalid token handling

### Manual Testing

```bash
# Test basic functionality
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer <valid-token>"

# Test conditional request
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer <valid-token>" \
  -H "If-None-Match: \"<etag>\""

# Test rate limiting
for i in {1..60}; do
  curl -X GET http://localhost:3000/me \
    -H "Authorization: Bearer <valid-token>"
done
```

## Deployment Considerations

### Environment Variables

```bash
# Required
JWT_SECRET=your-secret-key
REDIS_URL=redis://localhost:6379
MONGO_URI=mongodb://localhost:27017/user-service

# Optional
ME_CACHE_TTL=300
POLICY_VERSION=1
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### Production Checklist

- [ ] HTTPS/TLS enabled
- [ ] JWT secret configured
- [ ] Redis cluster configured
- [ ] Database connection pool configured
- [ ] Rate limiting configured
- [ ] CORS origins configured
- [ ] Security headers enabled
- [ ] Monitoring configured
- [ ] Logging configured
- [ ] Health checks configured

## Security Audit

### ZAP Baseline Scan

The endpoint should pass OWASP ZAP baseline security scan with:

- No high or medium severity issues
- No sensitive data exposure
- Proper authentication and authorization
- Secure headers implementation
- Rate limiting active

### Penetration Testing

Regular penetration testing should verify:

- Token manipulation attempts
- Cross-tenant access attempts
- Rate limit bypass attempts
- Cache poisoning attempts
- Injection attack attempts

## Maintenance

### Regular Tasks

- Monitor cache hit ratios
- Review rate limit violations
- Update security dependencies
- Rotate JWT secrets
- Review audit logs
- Test cache invalidation

### Troubleshooting

- **High Response Times**: Check Redis connectivity
- **Cache Misses**: Verify cache invalidation logic
- **Rate Limit Issues**: Review rate limit configuration
- **Authentication Errors**: Check JWT secret and token format
- **Tenant Isolation Issues**: Verify database queries and cache keys

---

**Last Updated**: 2024-01-01  
**Version**: 1.0.0  
**Status**: Production Ready ✅
