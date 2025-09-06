# Role Assignment Scripts

This directory contains scripts for managing role assignments in the user-service RBAC system.

## Scripts Overview

### 1. `assign-default-roles.js` - Basic Role Assignment

Assigns default roles to existing users based on their user type.

**Usage:**

```bash
node scripts/assign-default-roles.js
```

### 2. `assign-default-roles-enhanced.js` - Enhanced Role Assignment

Advanced version with dry-run, force options, and better error handling.

**Usage:**

```bash
# Preview changes (recommended first)
node scripts/assign-default-roles-enhanced.js --dry-run

# Execute assignment
node scripts/assign-default-roles-enhanced.js

# Force assignment (skip confirmations)
node scripts/assign-default-roles-enhanced.js --force
```

### 3. `remove-roles.js` - Role Removal (Rollback)

Removes all roles from users (useful for rollback).

**Usage:**

```bash
# Preview removals
node scripts/remove-roles.js --dry-run

# Remove all roles
node scripts/remove-roles.js --force

# Remove only from specific user type
node scripts/remove-roles.js --user-type CRM --force
```

## Default Role Assignment

The scripts assign roles based on user type:

| User Type | Default Role | Description                               |
| --------- | ------------ | ----------------------------------------- |
| PORTAL    | NON-MEMBER   | Non-member with limited portal access     |
| CRM       | REO          | Read Only access with limited permissions |

## Prerequisites

Before running any role assignment scripts:

1. **Initialize Roles:**

   ```bash
   node scripts/setup-rbac.js
   ```

2. **Verify Database Connection:**
   Ensure your `.env` file has correct MongoDB connection string.

3. **Check Required Roles Exist:**
   The scripts will verify that NON-MEMBER and REO roles exist before proceeding.

## Step-by-Step Process

### 1. First Time Setup

```bash
# Initialize all roles
node scripts/setup-rbac.js

# Preview what will be assigned
node scripts/assign-default-roles-enhanced.js --dry-run

# Execute the assignment
node scripts/assign-default-roles-enhanced.js
```

### 2. Verify Assignment

```bash
# Test the system
node scripts/test-default-roles.js

# Test REO role specifically
node scripts/test-reo-role.js
```

### 3. Rollback (if needed)

```bash
# Preview rollback
node scripts/remove-roles.js --dry-run

# Execute rollback
node scripts/remove-roles.js --force
```

## Script Features

### Safety Features

- **Dry Run Mode**: Preview changes without making them
- **Confirmation Prompts**: Ask for confirmation before making changes
- **Error Handling**: Continue processing even if some users fail
- **Detailed Logging**: Show exactly what's happening
- **Verification**: Test JWT generation after assignment

### Error Handling

- Users with unknown user types are skipped
- Database errors don't stop the entire process
- Detailed error reporting for failed assignments
- Rollback capability if something goes wrong

### Performance

- Processes users in batches
- Shows progress for large datasets
- Memory efficient for large user bases

## Command Line Options

### assign-default-roles-enhanced.js

```
--dry-run    Show what would be done without making changes
--force      Skip confirmation prompts
--help       Show help message
```

### remove-roles.js

```
--dry-run              Preview removals without making changes
--force                Skip confirmation prompts
--user-type PORTAL     Only process Portal users
--user-type CRM        Only process CRM users
--help                 Show help message
```

## Example Output

### Successful Assignment

```
🔍 Checking if required roles exist...
✅ NON-MEMBER role found: Non-Member
✅ REO role found: Read Only

📊 Analyzing existing users...
Found 25 users to process
Found 0 users with existing roles

📈 User breakdown:
   - Portal users: 15
   - CRM users: 10
   - Unknown type users: 0

🔄 Assigning default roles...

📝 Processing 15 Portal users...
   ✅ Assigned NON-MEMBER role to user1@example.com
   ✅ Assigned NON-MEMBER role to user2@example.com
   ...

📝 Processing 10 CRM users...
   ✅ Assigned REO role to crm1@example.com
   ✅ Assigned REO role to crm2@example.com
   ...

📊 Assignment Summary:
   ✅ Successfully assigned roles: 25
   ❌ Failed assignments: 0
   ⚠️  Skipped (unknown type): 0

🎉 Default role assignment completed!
```

## Troubleshooting

### Common Issues

1. **"Required roles not found"**

   ```bash
   # Solution: Initialize roles first
   node scripts/setup-rbac.js
   ```

2. **"No users found to process"**

   - All users already have roles assigned
   - Use `--force` to reassign roles

3. **"Users with unknown user types"**

   - Review user data and update userType field
   - These users are skipped for safety

4. **JWT generation errors**
   - Check if user has valid roles assigned
   - Verify JWT helper is working correctly

### Debug Steps

1. **Check user data:**

   ```bash
   # Connect to MongoDB and check users
   db.users.find({}, {userEmail: 1, userType: 1, roles: 1})
   ```

2. **Verify roles exist:**

   ```bash
   # Check roles collection
   db.roles.find({}, {name: 1, code: 1, isActive: 1})
   ```

3. **Test individual user:**
   ```bash
   # Use the test API endpoint
   curl -X POST http://localhost:3000/api/test/default-role \
     -H "Content-Type: application/json" \
     -d '{"userType": "CRM", "email": "test@example.com", "fullName": "Test User"}'
   ```

## Best Practices

1. **Always run dry-run first** to preview changes
2. **Backup your database** before running assignment scripts
3. **Test with a small subset** of users first
4. **Monitor logs** during and after assignment
5. **Verify JWT tokens** are working correctly
6. **Have a rollback plan** ready

## Integration with ProjectShell-1

After running these scripts:

1. **Define Permissions**: Use ProjectShell-1 to set specific permissions for each role
2. **Test Authentication**: Verify users can authenticate with their new roles
3. **Monitor Usage**: Watch for role-related activities in logs
4. **Update UI**: Ensure ProjectShell-1 displays roles correctly

## Support

If you encounter issues:

1. Check the error messages in the script output
2. Review the troubleshooting section above
3. Test with a small subset of users first
4. Use the rollback script if needed
5. Check database connectivity and permissions
