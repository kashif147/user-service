#!/bin/bash

# Duplicate Cleanup Runner Script
# This script runs the cleanup process and verification

echo "🧹 Starting Duplicate Cleanup Process..."
echo "=========================================="

# Set environment
export NODE_ENV=staging

# Check if .env.staging exists
if [ ! -f ".env.staging" ]; then
    echo "❌ Error: .env.staging file not found!"
    echo "Please create .env.staging with your MongoDB connection details"
    exit 1
fi

echo "📋 Environment: STAGING"
echo "📅 Date: $(date)"
echo ""

# Step 1: Run cleanup
echo "🚀 Step 1: Running duplicate cleanup..."
echo "--------------------------------------"
node cleanup-duplicate-permissions-roles.js

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Cleanup completed successfully!"
else
    echo ""
    echo "❌ Cleanup failed! Please check the errors above."
    exit 1
fi

echo ""
echo "🧪 Step 2: Running verification tests..."
echo "----------------------------------------"
node test-cleanup-verification.js

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 VERIFICATION PASSED!"
    echo "✅ Database cleanup is complete and successful"
    echo "✅ LOOKUP_READ permissions are properly configured"
else
    echo ""
    echo "⚠️  VERIFICATION FAILED!"
    echo "❌ Please review the test results above"
    echo "❌ You may need to run the cleanup again"
    exit 1
fi

echo ""
echo "🎯 Cleanup process completed!"
echo "Your staging database is now clean with proper LOOKUP_READ permissions."
