#!/bin/bash

# Centralized RBAC cURL Test Script
# This script provides cURL commands for testing the centralized RBAC implementation

# Configuration
BASE_URL="http://localhost:3000"
JWT_SECRET="your-jwt-secret"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Centralized RBAC cURL Test Script${NC}"
echo "================================================"

# Function to generate JWT token (requires node)
generate_token() {
    local payload="$1"
    node -e "
        const jwt = require('jsonwebtoken');
        const payload = $payload;
        const token = jwt.sign(payload, '$JWT_SECRET', { expiresIn: '1h' });
        console.log(token);
    "
}

# Function to make authenticated request
make_request() {
    local method="$1"
    local endpoint="$2"
    local token="$3"
    local data="$4"
    
    echo -e "${YELLOW}Testing: $method $endpoint${NC}"
    
    if [ -n "$data" ]; then
        curl -s -w "\nHTTP Status: %{http_code}\n" \
            -X "$method" \
            -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint"
    else
        curl -s -w "\nHTTP Status: %{http_code}\n" \
            -X "$method" \
            -H "Authorization: Bearer $token" \
            "$BASE_URL$endpoint"
    fi
    
    echo -e "\n${BLUE}----------------------------------------${NC}\n"
}

# Check if service is running
echo -e "${YELLOW}🔍 Checking if service is running...${NC}"
if curl -s "$BASE_URL/policy/info" > /dev/null; then
    echo -e "${GREEN}✅ Service is running${NC}\n"
else
    echo -e "${RED}❌ Service is not running. Please start with: npm start${NC}"
    exit 1
fi

# Generate test tokens
echo -e "${YELLOW}🔑 Generating test tokens...${NC}"

SU_TOKEN=$(generate_token '{
    "sub": "su-user-123",
    "tid": "tenant-123",
    "roles": ["SU"],
    "permissions": ["*"]
}')

ASU_TOKEN=$(generate_token '{
    "sub": "asu-user-456",
    "tid": "tenant-123",
    "roles": ["ASU"],
    "permissions": ["user:read", "user:update", "role:read"]
}')

USER_TOKEN=$(generate_token '{
    "sub": "user-789",
    "tid": "tenant-123",
    "roles": ["USER"],
    "permissions": ["user:read"]
}')

INVALID_TOKEN="invalid.jwt.token"

echo -e "${GREEN}✅ Tokens generated${NC}\n"

# Test Policy Service
echo -e "${BLUE}📋 Testing Policy Service${NC}"
echo "================================"

echo -e "${YELLOW}Policy Info:${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" "$BASE_URL/policy/info"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

echo -e "${YELLOW}Policy Evaluate (SU - Tenant Read):${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$SU_TOKEN\",
        \"resource\": \"tenant\",
        \"action\": \"read\"
    }" \
    "$BASE_URL/policy/evaluate"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

echo -e "${YELLOW}Policy Evaluate (ASU - Tenant Create):${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ASU_TOKEN\",
        \"resource\": \"tenant\",
        \"action\": \"create\"
    }" \
    "$BASE_URL/policy/evaluate"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

# Test Tenant Routes
echo -e "${BLUE}🏢 Testing Tenant Routes${NC}"
echo "=============================="

echo -e "${YELLOW}Tenant Create (SU):${NC}"
make_request "POST" "/api/tenants" "$SU_TOKEN" '{
    "name": "Test Tenant",
    "code": "TEST",
    "domain": "test.com"
}'

echo -e "${YELLOW}Tenant Create (ASU) - Should Fail:${NC}"
make_request "POST" "/api/tenants" "$ASU_TOKEN" '{
    "name": "Test Tenant",
    "code": "TEST",
    "domain": "test.com"
}'

echo -e "${YELLOW}Tenant List (SU):${NC}"
make_request "GET" "/api/tenants" "$SU_TOKEN"

echo -e "${YELLOW}Tenant List (ASU) - Should Fail:${NC}"
make_request "GET" "/api/tenants" "$ASU_TOKEN"

echo -e "${YELLOW}Tenant List (Invalid Token) - Should Fail:${NC}"
make_request "GET" "/api/tenants" "$INVALID_TOKEN"

# Test Role Routes
echo -e "${BLUE}👥 Testing Role Routes${NC}"
echo "============================"

echo -e "${YELLOW}Role Create (SU):${NC}"
make_request "POST" "/api/roles" "$SU_TOKEN" '{
    "name": "Test Role",
    "code": "TEST_ROLE",
    "description": "Test role for testing"
}'

echo -e "${YELLOW}Role Create (ASU) - Should Fail:${NC}"
make_request "POST" "/api/roles" "$ASU_TOKEN" '{
    "name": "Test Role",
    "code": "TEST_ROLE",
    "description": "Test role for testing"
}'

echo -e "${YELLOW}Role List (SU):${NC}"
make_request "GET" "/api/roles" "$SU_TOKEN"

echo -e "${YELLOW}Role List (ASU):${NC}"
make_request "GET" "/api/roles" "$ASU_TOKEN"

echo -e "${YELLOW}Role List (USER) - Should Fail:${NC}"
make_request "GET" "/api/roles" "$USER_TOKEN"

# Test Permission Routes
echo -e "${BLUE}🔐 Testing Permission Routes${NC}"
echo "=================================="

echo -e "${YELLOW}Permission Create (SU):${NC}"
make_request "POST" "/api/permissions" "$SU_TOKEN" '{
    "name": "Test Permission",
    "code": "TEST_PERM",
    "description": "Test permission for testing",
    "resource": "test",
    "action": "read"
}'

echo -e "${YELLOW}Permission Create (ASU) - Should Fail:${NC}"
make_request "POST" "/api/permissions" "$ASU_TOKEN" '{
    "name": "Test Permission",
    "code": "TEST_PERM",
    "description": "Test permission for testing",
    "resource": "test",
    "action": "read"
}'

echo -e "${YELLOW}Permission List (SU):${NC}"
make_request "GET" "/api/permissions" "$SU_TOKEN"

echo -e "${YELLOW}Permission List (ASU) - Should Fail:${NC}"
make_request "GET" "/api/permissions" "$ASU_TOKEN"

# Test User Routes
echo -e "${BLUE}👤 Testing User Routes${NC}"
echo "============================"

echo -e "${YELLOW}User Create (SU):${NC}"
make_request "POST" "/api/users" "$SU_TOKEN" '{
    "email": "test@example.com",
    "password": "password123",
    "firstName": "Test",
    "lastName": "User"
}'

echo -e "${YELLOW}User Create (ASU):${NC}"
make_request "POST" "/api/users" "$ASU_TOKEN" '{
    "email": "test2@example.com",
    "password": "password123",
    "firstName": "Test",
    "lastName": "User"
}'

echo -e "${YELLOW}User Create (USER) - Should Fail:${NC}"
make_request "POST" "/api/users" "$USER_TOKEN" '{
    "email": "test3@example.com",
    "password": "password123",
    "firstName": "Test",
    "lastName": "User"
}'

echo -e "${YELLOW}User List (SU):${NC}"
make_request "GET" "/api/users" "$SU_TOKEN"

echo -e "${YELLOW}User List (ASU):${NC}"
make_request "GET" "/api/users" "$ASU_TOKEN"

echo -e "${YELLOW}User List (USER) - Should Fail:${NC}"
make_request "GET" "/api/users" "$USER_TOKEN"

# Test Error Cases
echo -e "${BLUE}❌ Testing Error Cases${NC}"
echo "=========================="

echo -e "${YELLOW}Missing Token:${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" \
    -X GET \
    "$BASE_URL/api/tenants"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

echo -e "${YELLOW}Malformed Token:${NC}"
curl -s -w "\nHTTP Status: %{http_code}\n" \
    -X GET \
    -H "Authorization: Bearer malformed.token" \
    "$BASE_URL/api/tenants"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

echo -e "${YELLOW}Expired Token:${NC}"
EXPIRED_TOKEN=$(node -e "
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({
        sub: 'expired-user',
        tid: 'tenant-123',
        roles: ['SU'],
        permissions: ['*'],
        exp: Math.floor(Date.now() / 1000) - 3600
    }, '$JWT_SECRET');
    console.log(token);
")
curl -s -w "\nHTTP Status: %{http_code}\n" \
    -X GET \
    -H "Authorization: Bearer $EXPIRED_TOKEN" \
    "$BASE_URL/api/tenants"
echo -e "\n${BLUE}----------------------------------------${NC}\n"

echo -e "${GREEN}🎉 All tests completed!${NC}"
echo -e "${BLUE}================================================${NC}"
echo -e "${YELLOW}Summary:${NC}"
echo -e "  - Policy Service: Tested policy evaluation endpoints"
echo -e "  - Tenant Routes: Tested CRUD operations with different roles"
echo -e "  - Role Routes: Tested role management with authorization"
echo -e "  - Permission Routes: Tested permission management"
echo -e "  - User Routes: Tested user management with different access levels"
echo -e "  - Error Cases: Tested invalid tokens and missing authorization"
echo -e "\n${YELLOW}Expected Results:${NC}"
echo -e "  - SU (Super User): Full access to all resources"
echo -e "  - ASU (Assistant Super User): Limited access based on permissions"
echo -e "  - USER (Regular User): Minimal access, mostly read-only"
echo -e "  - Invalid/Expired Tokens: 401 Unauthorized"
echo -e "  - Insufficient Permissions: 403 Forbidden"
