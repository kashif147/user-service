#!/bin/bash

# Location Hierarchy Seeding Script
# Seeds work location hierarchy data into the staging environment from CSV file

echo "🚀 Starting Location Hierarchy Seeding Process"
echo "=============================================="

# Set environment to staging
export NODE_ENV=staging

# Check if CSV file exists
CSV_FILE="docs/region_branch_worklocation-seeding-data.csv"
if [ ! -f "$CSV_FILE" ]; then
    echo "❌ Error: CSV file not found at $CSV_FILE"
    echo "Please ensure the CSV file exists in the docs directory."
    exit 1
fi

echo "📄 Found CSV file: $CSV_FILE"

# Run the seeding script
echo "🌍 Seeding location hierarchy data to staging environment..."
node scripts/seed-location-hierarchy.js

echo ""
echo "✅ Location hierarchy seeding completed!"
echo ""
echo "To verify the data, you can:"
echo "1. Check the MongoDB staging database"
echo "2. Use the API endpoints to query lookup data"
echo "3. Run the verification function in the script"
