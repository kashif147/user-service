#!/bin/bash

# Product Management Data Verification Script
# This script verifies the seeded data for Product Types, Products, and Pricing

echo "🔍 Starting Product Management Data Verification..."
echo "Environment: ${NODE_ENV:-staging}"
echo ""

# Check if NODE_ENV is set
if [ -z "$NODE_ENV" ]; then
    echo "⚠️  NODE_ENV not set, defaulting to 'staging'"
    export NODE_ENV=staging
fi

# Check if .env.staging exists
if [ ! -f ".env.staging" ]; then
    echo "❌ Error: .env.staging file not found"
    echo "Please ensure the staging environment configuration exists"
    exit 1
fi

echo "📋 Environment: $NODE_ENV"
echo "📁 Using config: .env.$NODE_ENV"
echo ""

# Run the verification script
echo "🔍 Running product management verification script..."
node scripts/verify-product-management.js

# Check exit status
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Product Management verification completed successfully!"
    echo ""
    echo "📊 The verification shows:"
    echo "- All product types with their products"
    echo "- Current pricing for each product"
    echo "- Summary statistics"
    echo "- Data integrity checks"
else
    echo ""
    echo "❌ Product Management verification failed!"
    echo "Please check the error messages above."
    exit 1
fi
