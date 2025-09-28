#!/bin/bash

# Country Data Seeding Script Runner
# This script runs the country seeding process

echo "🌍 Country Data Seeding Script"
echo "=============================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

# Check if .env file exists
if [ ! -f ".env.development" ] && [ ! -f ".env" ]; then
    echo "⚠️  Warning: No .env.development or .env file found"
    echo "   Make sure your MongoDB connection is configured"
fi

# Set default environment to staging
if [ -z "$NODE_ENV" ]; then
    echo "ℹ️  Using staging environment by default. Set NODE_ENV to change environment"
    export NODE_ENV=staging
fi

# Set default user ID if not provided
if [ -z "$DEFAULT_USER_ID" ]; then
    echo "ℹ️  Using default user ID. Set DEFAULT_USER_ID environment variable to use a specific user"
    export DEFAULT_USER_ID="68c6c6368e834293355e49ba"
fi

echo "📋 Configuration:"
echo "   Environment: $NODE_ENV"
echo "   MongoDB URI: ${MONGO_URI:-'Using environment file'}"
echo "   Default User ID: $DEFAULT_USER_ID"
echo ""

# Ask for confirmation
read -p "🤔 Do you want to proceed with seeding countries data? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Seeding cancelled"
    exit 1
fi

echo ""
echo "🚀 Starting seeding process..."
echo ""

# Run the seeding script
node scripts/seed-countries.js

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Seeding completed successfully!"
    echo ""
    echo "📝 Next steps:"
    echo "   1. Test the country endpoints: GET /countries"
    echo "   2. Check cache statistics: GET /api/cache/lookup/stats"
    echo "   3. Clear cache if needed: POST /api/cache/country/clear"
else
    echo ""
    echo "❌ Seeding failed. Please check the error messages above."
    exit 1
fi
