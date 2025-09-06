#!/bin/bash

# User Service Script Runner
# This script helps run user-service scripts with environment-specific configurations

# Default to development if no environment specified
ENVIRONMENT=${1:-development}
SCRIPT_COMMAND=${2:-help}

# Validate environment
if [[ "$ENVIRONMENT" != "development" && "$ENVIRONMENT" != "staging" ]]; then
    echo "❌ Invalid environment: $ENVIRONMENT"
    echo "Valid environments: development, staging"
    echo ""
    echo "Usage: $0 [environment] [command]"
    echo "Example: $0 development setup"
    exit 1
fi

# Set environment variable for dotenv
export NODE_ENV=$ENVIRONMENT

case "$SCRIPT_COMMAND" in
  "setup")
    echo "🚀 Setting up RBAC roles for $ENVIRONMENT environment..."
    node scripts/setup-rbac.js
    ;;
  "assign-dry")
    echo "🔍 Running role assignment in dry-run mode for $ENVIRONMENT environment..."
    node scripts/assign-default-roles-enhanced.js --dry-run
    ;;
  "assign")
    echo "🔄 Assigning default roles to users in $ENVIRONMENT environment..."
    node scripts/assign-default-roles-enhanced.js
    ;;
  "assign-force")
    echo "🔄 Force assigning default roles to users in $ENVIRONMENT environment..."
    node scripts/assign-default-roles-enhanced.js --force
    ;;
  "test")
    echo "🧪 Testing default role assignment in $ENVIRONMENT environment..."
    node scripts/test-default-roles.js
    ;;
  "help"|*)
    echo "User Service Script Runner"
    echo ""
    echo "Usage: $0 [environment] [command]"
    echo ""
    echo "Environments:"
    echo "  development  - Use .env.development configuration"
    echo "  staging      - Use .env.staging configuration"
    echo ""
    echo "Commands:"
    echo "  setup       - Initialize RBAC roles"
    echo "  assign-dry  - Preview role assignments (dry run)"
    echo "  assign      - Assign default roles to users"
    echo "  assign-force- Force assign roles (even if users have roles)"
    echo "  test        - Test role assignment functionality"
    echo ""
    echo "Examples:"
    echo "  $0 development setup"
    echo "  $0 staging assign-dry"
    echo "  $0 development assign"
    echo ""
    echo "Current environment: $ENVIRONMENT"
    ;;
esac
