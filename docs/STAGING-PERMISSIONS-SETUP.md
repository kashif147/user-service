# Portal Permissions Setup for Staging Environment

## Overview

This guide helps you insert the new Portal permissions into your staging User-Service database.

## Prerequisites

1. **Environment Configuration**: Create a `.env.staging` file with your staging database credentials
2. **Database Access**: MongoDB connection with proper credentials
3. **Script Access**: The `insert-portal-permissions.js` script is ready to use

## Environment Setup

Create a `.env.staging` file in your project root:

```bash
# Staging Environment Configuration
NODE_ENV=staging
PORT=3001

# MongoDB Configuration
MONGO_URI=mongodb+srv://your-username:your-password@clusterprojectshell.tptnh8w.mongodb.net/user-service-staging?retryWrites=true&w=majority&appName=ClusterProjectShell
MONGO_USER=your-username
MONGO_PASS=your-password
MONGO_DB=user-service-staging

# JWT Configuration
JWT_SECRET=your-staging-jwt-secret-key
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d

# Other configurations...
```

## Running the Script

### Method 1: Using Environment Variable

```bash
# Set staging environment
export NODE_ENV=staging

# Run the script
node insert-portal-permissions.js
```

### Method 2: Direct Command

```bash
# Run with staging environment directly
NODE_ENV=staging node insert-portal-permissions.js
```

## What the Script Does

The script will:

1. **Connect** to your staging MongoDB database
2. **Check** for existing permissions to avoid duplicates
3. **Insert** 40 new Portal permissions covering:
   - Portal resources (read, create, write, delete)
   - Application resources (read, create, write, delete)
   - Portal modules (dashboard, events, resources)
   - Member modules (profile, payments, subscriptions, etc.)
   - Communication and voting features
4. **Report** success/failure for each permission
5. **Generate** a summary of created and skipped permissions

## Expected Output

```
🚀 Portal Permissions Insertion Script
========================================
🌐 Environment: staging
📅 Date: 2025-01-27T...
🎯 Target: User-Service Database

🔌 Connecting to staging MongoDB...
✅ Connected to MongoDB successfully

🔐 Inserting 40 new Portal permissions...
  ✅ Created permission: PORTAL_READ (Portal Read)
  ✅ Created permission: PORTAL_CREATE (Portal Create)
  ⚠️  Permission DASHBOARD_READ already exists, skipping...
  ...

📊 INSERTION SUMMARY
==================================================
✅ Successfully created: 35 permissions
⚠️  Skipped (already exist): 5 permissions
📋 Total processed: 40 permissions

🆕 Newly Created Permissions:
------------------------------
  • PORTAL_READ - Portal Read (PORTAL, Level 1)
  • PORTAL_CREATE - Portal Create (PORTAL, Level 20)
  ...

📂 Permissions by Category:
-------------------------
  • PORTAL: 25 permissions
  • PROFILE: 2 permissions
  • FINANCIAL: 3 permissions
  • SUBSCRIPTION: 10 permissions

✅ Portal permissions insertion completed successfully!
🎯 New permissions are now available for role assignment.

🔌 Disconnected from MongoDB
```

## Permissions Created

### Portal Resources (4 permissions)

- `PORTAL_READ` - Read portal resources
- `PORTAL_CREATE` - Create portal resources
- `PORTAL_WRITE` - Update portal resources
- `PORTAL_DELETE` - Delete portal resources

### Application Resources (4 permissions)

- `APPLICATION_READ` - Read applications
- `APPLICATION_CREATE` - Create applications
- `APPLICATION_WRITE` - Update applications
- `APPLICATION_DELETE` - Delete applications

### Portal Modules (9 permissions)

- `DASHBOARD_READ` - Read dashboard
- `EVENTS_READ/CREATE/WRITE/DELETE` - Events management
- `RESOURCES_READ/CREATE/WRITE/DELETE` - Resources management

### Member Modules (23 permissions)

- **Profile**: `PROFILE_READ/WRITE`
- **Payments**: `PAYMENTS_READ/CREATE/WRITE`
- **Subscriptions**: `SUBSCRIPTIONS_READ/WRITE`
- **Change of Category**: `CHANGEOFCATEGORY_READ/CREATE/WRITE/DELETE`
- **Transfer Requests**: `TRANSFERREQUESTS_READ/CREATE/WRITE/DELETE`
- **Communication**: `COMMUNICATION_READ/CREATE/WRITE/DELETE`
- **Queries**: `QUERIES_READ/CREATE/WRITE/DELETE`
- **Voting**: `VOTING_READ/CREATE/WRITE`

## Next Steps

After running the script:

1. **Verify** permissions were created in your staging database
2. **Assign** appropriate permissions to roles based on your RBAC requirements
3. **Test** API endpoints with the new permissions
4. **Update** your frontend applications to use the new permission codes

## Troubleshooting

### Connection Issues

- Verify your `.env.staging` file has correct MongoDB credentials
- Check if your IP is whitelisted in MongoDB Atlas
- Ensure the database name matches your staging database

### Permission Conflicts

- The script automatically skips existing permissions
- Check the summary to see which permissions were skipped
- Existing permissions will not be modified

### Environment Issues

- Make sure `NODE_ENV=staging` is set
- Verify the `.env.staging` file exists and is readable
- Check file permissions on the script (`chmod +x insert-portal-permissions.js`)
