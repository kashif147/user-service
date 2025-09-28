#!/bin/bash

# Product Management Data Seeding Script
# This script seeds sample data for Product Types, Products, and Pricing in the staging database

echo "🚀 Starting Product Management Data Seeding..."
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

# Run the seeding script
echo "🌱 Running product management seeding script..."
node scripts/seed-product-management.js

# Check exit status
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Product Management seeding completed successfully!"
    echo ""
    echo "📊 What was seeded:"
    echo "- 4 Product Types (Membership, CPD, Events, Insurance)"
    echo "- 17 Products across different categories"
    echo "- 17 Pricing records with EUR currency"
    echo ""
    echo "🔗 You can now test the APIs using the Postman collection:"
    echo "   postman-product-management.json"
else
    echo ""
    echo "❌ Product Management seeding failed!"
    echo "Please check the error messages above and try again."
    exit 1
fi
