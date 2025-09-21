# Duplicate Permissions & Roles Cleanup

## Overview

This cleanup process removes duplicate permissions and roles from your staging environment while preserving only the correct ones with LOOKUP_READ permissions.

## Files Created

1. **`cleanup-duplicate-permissions-roles.js`** - Main cleanup script
2. **`test-cleanup-verification.js`** - Verification and testing script
3. **`run-cleanup.sh`** - Automated runner script
4. **`DUPLICATE-CLEANUP-GUIDE.md`** - This documentation

## What Gets Cleaned

### Duplicate Permissions

- Removes permissions with duplicate `code` values
- Keeps the oldest permission (first created)
- Updates all role references to point to the kept permission

### Duplicate Roles

- Removes roles with duplicate `code` + `tenantId` combinations
- Keeps the oldest role (first created)
- Updates all user references to point to the kept role

### Incorrect Permissions

- Removes permissions not in the predefined correct list
- Ensures only valid permissions remain

### Incorrect Roles

- Removes roles not in the predefined correct list
- Ensures only valid roles remain

## Correct Permissions Preserved

The cleanup preserves these permissions:

### Lookup Permissions

- `LOOKUP_READ` (Level 1) - Read lookup data
- `LOOKUP_WRITE` (Level 30) - Create/update lookups
- `LOOKUP_DELETE` (Level 60) - Delete lookups

### LookupType Permissions

- `LOOKUPTYPE_READ` (Level 1) - Read lookup types
- `LOOKUPTYPE_WRITE` (Level 30) - Create/update lookup types
- `LOOKUPTYPE_DELETE` (Level 60) - Delete lookup types

### User Permissions

- `USER_READ`, `USER_WRITE`, `USER_DELETE`, `USER_MANAGE_ROLES`

### Role Permissions

- `ROLE_READ`, `ROLE_WRITE`, `ROLE_DELETE`, `ROLE_PERMISSION_ASSIGN`

### Admin Permissions

- `ADMIN_ACCESS`, `ADMIN_READ`, `ADMIN_WRITE`

### Portal Permissions

- `PORTAL_ACCESS`, `PORTAL_PROFILE_READ`, `PORTAL_PROFILE_WRITE`, `PORTAL_DASHBOARD_READ`

### CRM Permissions

- `CRM_ACCESS`, `CRM_MEMBER_READ`, `CRM_MEMBER_WRITE`, `CRM_MEMBER_DELETE`

### System Permissions

- `READ_ONLY` - System-wide read access

## Correct Roles Preserved

The cleanup preserves these roles with their hierarchy levels:

### System Roles (Levels 95-100)

- `SU` (100) - Super User
- `ASU` (95) - Assistant Super User

### Executive Roles (Levels 85-90)

- `GS` (90) - General Secretary
- `DGS` (85) - Deputy General Secretary

### Director Level (Levels 75-80)

- `DIR` (80) - Director of Industrial Relations
- `DPRS` (80) - Director of Professional and Regulatory Services
- `ADIR` (75) - Assistant Director Industrial Relations

### Management Level (Levels 55-70)

- `AM` (70) - Accounts Manager
- `DAM` (65) - Deputy Accounts Manager
- `MO` (60) - Membership Officer
- `AMO` (55) - Assistant Membership Officer

### Executive Level (Levels 35-50)

- `IRE` (50) - Industrial Relation Executive
- `IRO` (45) - Industrial Relations Officers
- `RO` (40) - Regional Officer
- `BO` (35) - Branch Officer

### Officer Level (Levels 15-30)

- `IO` (30) - Information Officer
- `HLS` (25) - Head of Library Services
- `CC` (20) - Course Coordinator
- `ACC` (15) - Assistant Course Coordinator

### Support Level (Levels 5-10)

- `LS` (10) - Librarian
- `LA` (5) - Library Assistant
- `AA` (5) - Accounts Assistant

### Basic Access (Level 1)

- `REO` (1) - Read Only
- `MEMBER` (1) - Member
- `NON-MEMBER` (1) - Non-Member

### AI Agent

- `AI` (50) - AI Agent with read-only access

## LOOKUP_READ Permission Assignment

After cleanup, the script ensures:

- All active roles have `LOOKUP_READ` permission
- All active roles have `LOOKUPTYPE_READ` permission
- These permissions are automatically added if missing

## Usage

### Option 1: Automated Runner (Recommended)

```bash
./run-cleanup.sh
```

### Option 2: Manual Execution

```bash
# Set environment
export NODE_ENV=staging

# Run cleanup
node cleanup-duplicate-permissions-roles.js

# Run verification
node test-cleanup-verification.js
```

## Prerequisites

1. **Environment File**: `.env.staging` must exist with MongoDB connection details
2. **Database Access**: Valid MongoDB connection string
3. **Node.js**: Node.js installed and accessible
4. **Dependencies**: All npm dependencies installed

## Environment Variables Required

```bash
# .env.staging
MONGO_URI=mongodb://your-connection-string
MONGO_USER=your-username
MONGO_PASS=your-password
MONGO_DB=user-service-staging
```

## Safety Features

- **Non-destructive**: Users are preserved, only roles/permissions are cleaned
- **Rollback-safe**: Keeps oldest records, removes newer duplicates
- **Verification**: Comprehensive testing after cleanup
- **Detailed logging**: Full audit trail of all operations

## Verification Tests

The verification script tests:

1. ✅ No duplicate permissions remain
2. ✅ No duplicate roles remain
3. ✅ LOOKUP_READ permission exists
4. ✅ LOOKUPTYPE_READ permission exists
5. ✅ Roles have LOOKUP_READ permissions
6. ✅ Specific role details (e.g., NON-MEMBER)
7. ✅ User role assignments

## Expected Results

After successful cleanup:

- **Clean database** with no duplicates
- **All roles** have LOOKUP_READ permissions
- **Proper hierarchy** maintained
- **Users preserved** with correct role assignments
- **API endpoints** work with proper authorization

## Troubleshooting

### Common Issues

1. **Connection Failed**

   - Check `.env.staging` file exists
   - Verify MongoDB connection string
   - Ensure network connectivity

2. **Permission Denied**

   - Check MongoDB user permissions
   - Verify database access rights

3. **Cleanup Failed**

   - Review error messages
   - Check database state
   - Run verification to identify issues

4. **Verification Failed**
   - Run cleanup again
   - Check for remaining duplicates
   - Verify LOOKUP_READ permissions

### Recovery

If cleanup fails:

1. Check error messages
2. Verify database connectivity
3. Ensure proper permissions
4. Run verification to identify remaining issues
5. Re-run cleanup if needed

## Support

For issues or questions:

1. Check the error logs
2. Review the verification results
3. Ensure all prerequisites are met
4. Verify environment configuration

---

**Created**: January 2025  
**Environment**: Staging  
**Purpose**: Clean duplicate permissions and roles while preserving LOOKUP_READ access
