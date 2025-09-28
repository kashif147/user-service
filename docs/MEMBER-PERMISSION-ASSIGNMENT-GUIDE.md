# MEMBER Role Portal Permissions Assignment Guide

## Overview

This guide helps you assign Portal permissions to the MEMBER role in your staging User-Service database based on the specified access criteria.

## Prerequisites

1. **Portal Permissions Created**: Run `insert-portal-permissions.js` first to create the permissions
2. **MEMBER Role Exists**: Ensure MEMBER role exists in your staging database
3. **Environment Configuration**: `.env.staging` file with proper database credentials

## Permission Mapping

The script maps your criteria to User-Service permissions as follows:

### Full Access Resources (read, create, write, delete)

- **Portal**: `PORTAL_READ`, `PORTAL_CREATE`, `PORTAL_WRITE`, `PORTAL_DELETE`
- **Events**: `EVENTS_READ`, `EVENTS_CREATE`, `EVENTS_WRITE`, `EVENTS_DELETE`
- **Resources**: `RESOURCES_READ`, `RESOURCES_CREATE`, `RESOURCES_WRITE`, `RESOURCES_DELETE`
- **Change of Category**: `CHANGEOFCATEGORY_READ`, `CHANGEOFCATEGORY_CREATE`, `CHANGEOFCATEGORY_WRITE`, `CHANGEOFCATEGORY_DELETE`
- **Transfer Requests**: `TRANSFERREQUESTS_READ`, `TRANSFERREQUESTS_CREATE`, `TRANSFERREQUESTS_WRITE`, `TRANSFERREQUESTS_DELETE`
- **Communication**: `COMMUNICATION_READ`, `COMMUNICATION_CREATE`, `COMMUNICATION_WRITE`, `COMMUNICATION_DELETE`
- **Queries**: `QUERIES_READ`, `QUERIES_CREATE`, `QUERIES_WRITE`, `QUERIES_DELETE`

### Read-Only Resources

- **Application**: `APPLICATION_READ`
- **Dashboard**: `DASHBOARD_READ`

### Limited Access Resources

- **Profile**: `PROFILE_READ`, `PROFILE_WRITE` (maps from personalDetails & professionalDetails)
- **Payments**: `PAYMENTS_READ`, `PAYMENTS_CREATE`, `PAYMENTS_WRITE` (no delete)
- **Subscriptions**: `SUBSCRIPTIONS_READ`, `SUBSCRIPTIONS_WRITE` (maps from subscriptionDetails)
- **Voting**: `VOTING_READ`, `VOTING_CREATE`, `VOTING_WRITE` (no delete)

## Running the Script

### Method 1: Using Environment Variable

```bash
# Set staging environment
export NODE_ENV=staging

# Run the assignment script
node assign-portal-permissions-to-member.js
```

### Method 2: Direct Command

```bash
# Run with staging environment directly
NODE_ENV=staging node assign-portal-permissions-to-member.js
```

## Expected Output

```
🚀 Portal Permissions Assignment to MEMBER Role
==================================================
🌐 Environment: staging
📅 Date: 2025-01-27T...
🎯 Target: MEMBER Role in User-Service Database

🔌 Connecting to staging MongoDB...
✅ Connected to MongoDB successfully

🔍 Finding MEMBER role...
✅ Found MEMBER role: Member (ID: 68c6b4d1e42306a6836622cf)
   Tenant: 68c6ad211ae58311ab994f6d
   Current permissions: 5

🔍 Finding permissions matching criteria...
  ✅ Found: PORTAL_READ (portal.read)
  ✅ Found: PORTAL_CREATE (portal.create)
  ✅ Found: PORTAL_WRITE (portal.write)
  ✅ Found: PORTAL_DELETE (portal.delete)
  ✅ Found: APPLICATION_READ (application.read)
  ✅ Found: DASHBOARD_READ (dashboard.read)
  ✅ Found: EVENTS_READ (events.read)
  ✅ Found: EVENTS_CREATE (events.create)
  ✅ Found: EVENTS_WRITE (events.write)
  ✅ Found: EVENTS_DELETE (events.delete)
  ✅ Found: RESOURCES_READ (resources.read)
  ✅ Found: RESOURCES_CREATE (resources.create)
  ✅ Found: RESOURCES_WRITE (resources.write)
  ✅ Found: RESOURCES_DELETE (resources.delete)
  ✅ Found: PROFILE_READ (profile.read)
  ✅ Found: PROFILE_WRITE (profile.write)
  ✅ Found: PAYMENTS_READ (payments.read)
  ✅ Found: PAYMENTS_CREATE (payments.create)
  ✅ Found: PAYMENTS_WRITE (payments.write)
  ✅ Found: CHANGEOFCATEGORY_READ (changeOfCategory.read)
  ✅ Found: CHANGEOFCATEGORY_CREATE (changeOfCategory.create)
  ✅ Found: CHANGEOFCATEGORY_WRITE (changeOfCategory.write)
  ✅ Found: CHANGEOFCATEGORY_DELETE (changeOfCategory.delete)
  ✅ Found: TRANSFERREQUESTS_READ (transferRequests.read)
  ✅ Found: TRANSFERREQUESTS_CREATE (transferRequests.create)
  ✅ Found: TRANSFERREQUESTS_WRITE (transferRequests.write)
  ✅ Found: TRANSFERREQUESTS_DELETE (transferRequests.delete)
  ✅ Found: SUBSCRIPTIONS_READ (subscriptions.read)
  ✅ Found: SUBSCRIPTIONS_WRITE (subscriptions.write)
  ✅ Found: COMMUNICATION_READ (communication.read)
  ✅ Found: COMMUNICATION_CREATE (communication.create)
  ✅ Found: COMMUNICATION_WRITE (communication.write)
  ✅ Found: COMMUNICATION_DELETE (communication.delete)
  ✅ Found: QUERIES_READ (queries.read)
  ✅ Found: QUERIES_CREATE (queries.create)
  ✅ Found: QUERIES_WRITE (queries.write)
  ✅ Found: QUERIES_DELETE (queries.delete)
  ✅ Found: VOTING_READ (voting.read)
  ✅ Found: VOTING_CREATE (voting.create)
  ✅ Found: VOTING_WRITE (voting.write)

🔐 Assigning 33 permissions to MEMBER role...
  ✅ Added 28 new permissions to MEMBER role
  ⏭️  5 permissions were already assigned

📊 ASSIGNMENT SUMMARY
==================================================
✅ Permissions found: 33
❌ Permissions not found: 0
🆕 New permissions assigned: 28
⏭️  Already assigned: 5

✅ Successfully Found Permissions:
----------------------------------------
  • portal: read, create, write, delete
  • application: read
  • dashboard: read
  • events: read, create, write, delete
  • resources: read, create, write, delete
  • profile: read, write
  • payments: read, create, write
  • changeOfCategory: read, create, write, delete
  • transferRequests: read, create, write, delete
  • subscriptions: read, write
  • communication: read, create, write, delete
  • queries: read, create, write, delete
  • voting: read, create, write

🆕 Newly Assigned Permissions:
-----------------------------------
  • PORTAL_READ - Portal Read
  • PORTAL_CREATE - Portal Create
  • PORTAL_WRITE - Portal Write
  • PORTAL_DELETE - Portal Delete
  • APPLICATION_READ - Application Read
  • DASHBOARD_READ - Dashboard Read
  • EVENTS_READ - Events Read
  • EVENTS_CREATE - Events Create
  • EVENTS_WRITE - Events Write
  • EVENTS_DELETE - Events Delete
  • RESOURCES_READ - Resources Read
  • RESOURCES_CREATE - Resources Create
  • RESOURCES_WRITE - Resources Write
  • RESOURCES_DELETE - Resources Delete
  • PROFILE_READ - Profile Read
  • PROFILE_WRITE - Profile Write
  • PAYMENTS_READ - Payments Read
  • PAYMENTS_CREATE - Payments Create
  • PAYMENTS_WRITE - Payments Write
  • CHANGEOFCATEGORY_READ - Change of Category Read
  • CHANGEOFCATEGORY_CREATE - Change of Category Create
  • CHANGEOFCATEGORY_WRITE - Change of Category Write
  • CHANGEOFCATEGORY_DELETE - Change of Category Delete
  • TRANSFERREQUESTS_READ - Transfer Requests Read
  • TRANSFERREQUESTS_CREATE - Transfer Requests Create
  • TRANSFERREQUESTS_WRITE - Transfer Requests Write
  • TRANSFERREQUESTS_DELETE - Transfer Requests Delete
  • SUBSCRIPTIONS_READ - Subscriptions Read
  • SUBSCRIPTIONS_WRITE - Subscriptions Write
  • COMMUNICATION_READ - Communication Read
  • COMMUNICATION_CREATE - Communication Create
  • COMMUNICATION_WRITE - Communication Write
  • COMMUNICATION_DELETE - Communication Delete
  • QUERIES_READ - Queries Read
  • QUERIES_CREATE - Queries Create
  • QUERIES_WRITE - Queries Write
  • QUERIES_DELETE - Queries Delete
  • VOTING_READ - Voting Read
  • VOTING_CREATE - Voting Create
  • VOTING_WRITE - Voting Write

🔍 Verifying MEMBER role permissions...
✅ MEMBER role now has 33 total permissions

📂 Permissions by Category:
-------------------------
  • PORTAL: 25 permissions
  • PROFILE: 2 permissions
  • FINANCIAL: 3 permissions
  • SUBSCRIPTION: 3 permissions

✅ Portal permissions assignment completed successfully!
🎯 MEMBER role now has access to Portal resources as specified.

🔌 Disconnected from MongoDB
```

## Complete Setup Process

### Step 1: Create Portal Permissions

```bash
NODE_ENV=staging node insert-portal-permissions.js
```

### Step 2: Assign Permissions to MEMBER Role

```bash
NODE_ENV=staging node assign-portal-permissions-to-member.js
```

## What the Script Does

1. **Connects** to your staging MongoDB database
2. **Finds** the MEMBER role in the database
3. **Maps** your criteria to existing User-Service permissions
4. **Identifies** which permissions to assign based on resource/action pairs
5. **Assigns** new permissions to the MEMBER role (skips already assigned ones)
6. **Reports** detailed summary of assignments
7. **Verifies** the final permission count and categorization

## Key Features

- **Duplicate Prevention**: Automatically skips permissions already assigned
- **Smart Mapping**: Maps legacy resource names to current User-Service naming
- **Comprehensive Logging**: Detailed progress and summary reports
- **Error Handling**: Graceful failure handling with clear error messages
- **Verification**: Confirms final permission assignment

## Troubleshooting

### MEMBER Role Not Found

- Ensure MEMBER role exists in your staging database
- Check that the role has `category: "PORTAL"` and `isActive: true`

### Permissions Not Found

- Run `insert-portal-permissions.js` first to create the permissions
- Verify permissions exist with the correct resource/action combinations

### Connection Issues

- Verify your `.env.staging` file has correct MongoDB credentials
- Check database connectivity and IP whitelisting

## Next Steps

After running the script:

1. **Test** MEMBER role permissions in your application
2. **Verify** users with MEMBER role can access Portal resources
3. **Update** your frontend to use the new permission codes
4. **Monitor** API access logs for permission validation

## Permission Summary

The MEMBER role will have access to:

- **33 Total Permissions** across Portal resources
- **Full CRUD access** to: Portal, Events, Resources, Change of Category, Transfer Requests, Communication, Queries
- **Read-only access** to: Application, Dashboard
- **Limited access** to: Profile (R/W), Payments (R/C/W), Subscriptions (R/W), Voting (R/C/W)

This provides comprehensive Portal access while maintaining appropriate security boundaries.
