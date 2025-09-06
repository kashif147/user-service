# Default Role Assignment Implementation

This document describes the implementation of automatic default role assignment for new users in the user-service.

## Overview

When users are created through any authentication method, they are automatically assigned default roles based on their user type:

- **Portal Users**: Automatically get `NON-MEMBER` role
- **CRM Users**: Automatically get `REO` (Read Only) role

## Implementation Details

### Files Modified

1. **`handlers/b2c.users.handler.js`** - Portal user creation via Microsoft B2C
2. **`handlers/user.handler.js`** - CRM user creation via direct registration
3. **`handlers/azure.ad.handler.js`** - CRM user creation via Azure AD
4. **`helpers/roleAssignment.js`** - New utility for role assignment
5. **`controllers/role.controller.js`** - Added test endpoint
6. **`routes/role.routes.js`** - Added test route

### Helper Function

The `assignDefaultRole` function in `helpers/roleAssignment.js` provides:

```javascript
// Assigns default role based on user type
await assignDefaultRole(user, "PORTAL"); // Assigns NON-MEMBER
await assignDefaultRole(user, "CRM"); // Assigns REO
```

### Default Role Mapping

| User Type | Default Role Code | Default Role Name |
| --------- | ----------------- | ----------------- |
| PORTAL    | NON-MEMBER        | Non-Member        |
| CRM       | REO               | Read Only         |

## Authentication Flow Integration

### Portal Users (Microsoft B2C)

```javascript
// In b2c.users.handler.js
if (user) {
  user.set(update);
} else {
  user = new B2CUser(update);
  // Automatically assign NON-MEMBER role
  await assignDefaultRole(user, "PORTAL");
}
```

### CRM Users (Direct Registration)

```javascript
// In user.handler.js
const result = await User.create({
  userEmail: email,
  password: hashedPwd,
  userType: "CRM",
});
// Automatically assign REO role
await assignDefaultRole(result, "CRM");
```

### CRM Users (Azure AD)

```javascript
// In azure.ad.handler.js
if (user) {
  user.set(update);
} else {
  user = new User(update);
  // Automatically assign REO role
  await assignDefaultRole(user, "CRM");
}
```

## Testing

### Test Script

Run the test script to verify default role assignment:

```bash
node scripts/test-default-roles.js
```

### API Test Endpoint

Test the functionality via API:

```bash
# Test Portal user creation
curl -X POST http://localhost:3000/api/test/default-role \
  -H "Content-Type: application/json" \
  -d '{
    "userType": "PORTAL",
    "email": "test.portal@example.com",
    "fullName": "Test Portal User"
  }'

# Test CRM user creation
curl -X POST http://localhost:3000/api/test/default-role \
  -H "Content-Type: application/json" \
  -d '{
    "userType": "CRM",
    "email": "test.crm@example.com",
    "fullName": "Test CRM User"
  }'
```

### Setup Script

Run the complete setup:

```bash
node scripts/setup-rbac.js
```

## JWT Token Integration

JWT tokens now include user roles and permissions:

```json
{
  "id": "user_id",
  "email": "user@example.com",
  "userType": "PORTAL",
  "roles": [
    {
      "id": "role_id",
      "code": "NON-MEMBER",
      "name": "Non-Member"
    }
  ],
  "permissions": ["permission1", "permission2"]
}
```

## Error Handling

The implementation includes comprehensive error handling:

- **Role Not Found**: Logs warning but continues user creation
- **Database Errors**: Logs error but doesn't fail user creation
- **Invalid User Type**: Skips role assignment for unknown types

## Configuration

### Changing Default Roles

To change the default roles, update the `getDefaultRoleCode` function in `helpers/roleAssignment.js`:

```javascript
module.exports.getDefaultRoleCode = (userType) => {
  const defaultRoles = {
    PORTAL: "MEMBER", // Change from NON-MEMBER to MEMBER
    CRM: "MO", // Change from REO to MO
  };

  return defaultRoles[userType] || null;
};
```

### Adding New User Types

To add support for new user types:

1. Update the `getDefaultRoleCode` function
2. Update the `assignDefaultRole` function
3. Add the new role to the role definitions
4. Update authentication handlers

## Security Considerations

1. **Role Validation**: Only active roles are assigned
2. **User Type Validation**: Only PORTAL and CRM types are supported
3. **Error Isolation**: Role assignment errors don't prevent user creation
4. **Logging**: All role assignments are logged for audit purposes

## Monitoring

Monitor the following logs for role assignment:

```
Assigned NON-MEMBER role to new portal user
Assigned default role to new CRM user
Warning: Default PORTAL role (NON-MEMBER) not found
Error assigning default role to PORTAL user: [error message]
```

## Future Enhancements

1. **Dynamic Default Roles**: Configure default roles via environment variables
2. **Role Templates**: Predefined role sets for different user types
3. **Conditional Assignment**: Assign roles based on user attributes
4. **Audit Trail**: Track all role assignments and changes
5. **Bulk Assignment**: Assign roles to existing users without roles

## Troubleshooting

### Common Issues

1. **Roles Not Assigned**: Ensure roles are initialized first
2. **JWT Missing Roles**: Check if user has roles populated
3. **Permission Errors**: Verify role permissions are defined

### Debug Steps

1. Check if roles exist: `GET /api/roles`
2. Verify user has roles: `GET /api/users/:userId/roles`
3. Test role assignment: `POST /api/test/default-role`
4. Check logs for error messages

## API Reference

### Test Default Role Assignment

**Endpoint**: `POST /api/test/default-role`

**Request Body**:

```json
{
  "userType": "PORTAL|CRM",
  "email": "user@example.com",
  "fullName": "User Name"
}
```

**Response**:

```json
{
  "success": true,
  "message": "Test user created with default role",
  "data": {
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "fullName": "User Name",
      "userType": "PORTAL",
      "roles": [
        {
          "id": "role_id",
          "code": "NON-MEMBER",
          "name": "Non-Member"
        }
      ]
    }
  }
}
```
