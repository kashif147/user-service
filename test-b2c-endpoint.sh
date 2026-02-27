#!/bin/bash

# Test script for Azure B2C /api/user/validate endpoint
# Usage: ./test-b2c-endpoint.sh [environment]
# Example: ./test-b2c-endpoint.sh local
# Example: ./test-b2c-endpoint.sh production

ENVIRONMENT=${1:-local}

# Set API endpoint based on environment
if [ "$ENVIRONMENT" = "local" ]; then
    API_URL="http://localhost:3000/api/user/validate"
elif [ "$ENVIRONMENT" = "dev" ]; then
    API_URL="https://your-dev-url.azurewebsites.net/api/user/validate"
elif [ "$ENVIRONMENT" = "production" ]; then
    API_URL="https://your-prod-url.azurewebsites.net/api/user/validate"
else
    echo "Unknown environment: $ENVIRONMENT"
    exit 1
fi

echo "Testing Azure B2C validate endpoint: $API_URL"
echo "=========================================="
echo ""

# Test 1: New user (should return Continue with default tenantId)
echo "Test 1: New User Registration (HTTP 200, action=Continue)"
echo "-----------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "newuser@example.com",
    "givenName": "New",
    "surname": "User",
    "displayName": "New User",
    "step": "PostAttributeCollection"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 2: Existing user signup attempt (should return ShowBlockPage)
echo "Test 2: Existing User Signup Attempt (HTTP 200, action=ShowBlockPage)"
echo "----------------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "existing@example.com",
    "givenName": "Existing",
    "surname": "User",
    "step": "PostAttributeCollection"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 3: Invalid email format (should return ValidationError HTTP 400)
echo "Test 3: Invalid Email Format (HTTP 400, action=ValidationError)"
echo "----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "invalid-email",
    "givenName": "Test",
    "surname": "User"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 4: Missing email (should return ValidationError HTTP 400)
echo "Test 4: Missing Email (HTTP 400, action=ValidationError)"
echo "---------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "givenName": "Test",
    "surname": "User"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 5: Invalid mobile phone (should return ValidationError HTTP 400)
echo "Test 5: Invalid Mobile Phone (HTTP 400, action=ValidationError)"
echo "----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "test@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "123"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 6: Invalid member number (should return ValidationError HTTP 400)
echo "Test 6: Invalid Member Number (HTTP 400, action=ValidationError)"
echo "-----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "test@example.com",
    "givenName": "Test",
    "surname": "User",
    "memberno": "AB"
  }' \
  -w "\n\nHTTP Status: %{http_code}\nContent-Type: %{content_type}\n" \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""
echo "Testing complete!"
echo ""
echo "Expected Results Summary:"
echo "========================="
echo ""
echo "✅ Test 1: HTTP 200, action=Continue"
echo "   - Should include: email, tenantId, givenName, surname"
echo ""
echo "✅ Test 2: HTTP 200, action=ShowBlockPage"
echo "   - Should include: version, action, userMessage about existing account"
echo ""
echo "✅ Test 3: HTTP 400, action=ValidationError"
echo "   - Should include: version, status=400, action, userMessage about invalid email"
echo ""
echo "✅ Test 4: HTTP 400, action=ValidationError"
echo "   - Should include: version, status=400, action, userMessage about missing email"
echo ""
echo "✅ Test 5: HTTP 400, action=ValidationError"
echo "   - Should include: version, status=400, action, userMessage about invalid phone"
echo ""
echo "✅ Test 6: HTTP 400, action=ValidationError"
echo "   - Should include: version, status=400, action, userMessage about invalid member number"
echo ""
echo "All responses should have Content-Type: application/json"

