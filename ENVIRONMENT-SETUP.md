# Environment Setup Guide

## Quick Setup for Staging

### 1. Create Environment File

Create a `.env` file in your project root with:

```bash
# Database Configuration
MONGO_URI=mongodb://your-staging-host:27017/user-service-staging

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRY=24h

# Server Configuration
PORT=3000
NODE_ENV=staging
```

### 2. Updated Package.json Scripts

Your package.json now includes these convenient scripts:

```bash
# Development
npm run dev                    # Start with nodemon
npm start                     # Start normally

# Staging
npm run dev:staging           # Start staging with nodemon
npm run start:staging         # Start staging normally

# RBAC Management
npm run setup-rbac           # Initialize all roles
npm run assign-roles:dry-run # Preview role assignments
npm run assign-roles         # Assign default roles
npm run assign-roles:force   # Force assign roles
npm run remove-roles         # Preview role removal
npm run remove-roles:force   # Force remove roles
npm run test-roles           # Test role assignments
npm run test-reo             # Test REO role specifically
```

### 3. Environment-Specific Commands

For staging environment:

```bash
# Set staging environment and run
NODE_ENV=staging npm run assign-roles:dry-run

# Or use the staging script
npm run start:staging
```

### 4. Database Connection Fixed

All scripts now use `MONGO_URI` (matching your existing config) instead of `MONGODB_URI`.

### 5. Your Final Command

```bash
# 1. Set up your .env file with MONGO_URI
# 2. Initialize roles
npm run setup-rbac

# 3. Preview role assignments
npm run assign-roles:dry-run

# 4. Execute role assignments
npm run assign-roles
```

### 6. Staging-Specific Setup

For staging environment:

```bash
# Create staging .env
echo "MONGO_URI=mongodb://your-staging-host:27017/user-service-staging" > .env.staging
echo "JWT_SECRET=your-staging-jwt-secret" >> .env.staging
echo "NODE_ENV=staging" >> .env.staging

# Use staging environment
cp .env.staging .env
npm run assign-roles:dry-run
```
