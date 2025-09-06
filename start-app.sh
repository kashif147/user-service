#!/bin/bash

# User Service Application Starter
# This script starts the user-service application with environment-specific configurations

# Default to development if no environment specified
ENVIRONMENT=${1:-development}

# Validate environment
if [[ "$ENVIRONMENT" != "development" && "$ENVIRONMENT" != "staging" ]]; then
    echo "❌ Invalid environment: $ENVIRONMENT"
    echo "Valid environments: development, staging"
    echo ""
    echo "Usage: $0 [environment]"
    echo "Example: $0 development"
    exit 1
fi

# Set environment variable for dotenv
export NODE_ENV=$ENVIRONMENT

echo "🚀 Starting User Service in $ENVIRONMENT environment..."
echo "📁 Using configuration: .env.$ENVIRONMENT"
echo ""

# Start the application
npm start
