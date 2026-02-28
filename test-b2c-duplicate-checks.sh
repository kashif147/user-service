#!/bin/bash

# Comprehensive test script for Azure B2C /api/user/validate endpoint
# Tests duplicate detection for email, mobile phone, and member number
# Usage: ./test-b2c-duplicate-checks.sh [environment]

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

echo "Testing Azure B2C Duplicate Detection: $API_URL"
echo "==============================================="
echo ""

# Test 1: New user with all unique data (should pass)
echo "Test 1: New User - All Unique Data (HTTP 200, action=Continue)"
echo "---------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "newuser@example.com",
    "givenName": "New",
    "surname": "User",
    "displayName": "New User",
    "mobilephone": "+1234567890",
    "memberno": "MEM-NEW-001",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 2: Duplicate email (should block)
echo "Test 2: Duplicate Email (HTTP 200, action=ShowBlockPage)"
echo "---------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "existing@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "+9999999999",
    "memberno": "MEM-UNIQUE-001",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 3: Duplicate mobile phone (unique email)
echo "Test 3: Duplicate Mobile Phone (HTTP 200, action=ShowBlockPage)"
echo "----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "newemail@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "+1234567890",
    "memberno": "MEM-UNIQUE-002",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 4: Duplicate member number (unique email and mobile)
echo "Test 4: Duplicate Member Number (HTTP 200, action=ShowBlockPage)"
echo "-----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "anotheremail@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "+9988776655",
    "memberno": "MEM-EXISTING-001",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 5: Duplicate email AND mobile phone
echo "Test 5: Duplicate Email + Mobile (HTTP 200, action=ShowBlockPage)"
echo "------------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "existing@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "+1234567890",
    "memberno": "MEM-UNIQUE-003",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 6: Duplicate email + mobile + member (all three)
echo "Test 6: Duplicate Email + Mobile + Member (HTTP 200, action=ShowBlockPage)"
echo "---------------------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "existing@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "+1234567890",
    "memberno": "MEM-EXISTING-001",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 7: Only email provided (no mobile or member)
echo "Test 7: Only Email Provided - No Mobile/Member (HTTP 200, action=Continue/ShowBlockPage)"
echo "----------------------------------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "onlyemail@example.com",
    "givenName": "Test",
    "surname": "User",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 8: Invalid mobile phone format (validation error)
echo "Test 8: Invalid Mobile Format (HTTP 400, action=ValidationError)"
echo "-----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "test@example.com",
    "givenName": "Test",
    "surname": "User",
    "mobilephone": "123",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""

# Test 9: Invalid member number format (validation error)
echo "Test 9: Invalid Member Format (HTTP 400, action=ValidationError)"
echo "-----------------------------------------------------------------"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "email": "test@example.com",
    "givenName": "Test",
    "surname": "User",
    "memberno": "AB",
    "step": "PostAttributeCollection"
  }' \
  -s | jq . 2>/dev/null || echo "JSON parse error"

echo ""
echo ""
echo "Testing complete!"
echo ""
echo "Expected Results Summary:"
echo "========================="
echo ""
echo "✅ Test 1: HTTP 200, action=Continue"
echo "   - New user with all unique data"
echo ""
echo "🚫 Test 2: HTTP 200, action=ShowBlockPage"
echo "   - userMessage: 'An account with this email address already exists...'"
echo ""
echo "🚫 Test 3: HTTP 200, action=ShowBlockPage"
echo "   - userMessage: 'An account with this mobile phone number already exists...'"
echo ""
echo "🚫 Test 4: HTTP 200, action=ShowBlockPage"
echo "   - userMessage: 'An account with this member number already exists...'"
echo ""
echo "🚫 Test 5: HTTP 200, action=ShowBlockPage"
echo "   - userMessage: 'An account with this email address and mobile phone number already exists...'"
echo ""
echo "🚫 Test 6: HTTP 200, action=ShowBlockPage"
echo "   - userMessage: 'An account with this email address and mobile phone number and member number already exists...'"
echo ""
echo "✅/🚫 Test 7: Depends on if email exists in DB"
echo ""
echo "❌ Test 8: HTTP 400, action=ValidationError"
echo "   - userMessage: 'Please enter a valid mobile phone number.'"
echo ""
echo "❌ Test 9: HTTP 400, action=ValidationError"
echo "   - userMessage: 'Please enter a valid member number.'"
echo ""
echo "Note: Tests 2-6 depend on having existing users in your database."
echo "Adjust test data based on your actual database contents."
