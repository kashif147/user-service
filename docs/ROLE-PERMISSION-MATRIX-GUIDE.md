# Role-Permission Matrix Guide

## 📋 Overview

This guide provides a comprehensive framework for managing roles and permissions in the User-Service system. It includes the complete role hierarchy, permission matrix, and implementation guidelines for consistent authorization across all APIs.

## 🏗️ System Architecture

### Authorization Flow

1. **User Login** → JWT Token with roles & permissions
2. **API Request** → Policy middleware intercepts
3. **Token Validation** → Extract user context
4. **Policy Evaluation** → Check resource, action, role level, permissions
5. **Decision** → PERMIT or DENY
6. **Response** → Allow API call or return 403 error
7. **Caching** → Store decision for performance

### Data Storage Structure

#### Permissions Collection

```javascript
{
  _id: ObjectId("68c84c57f10b0fff9ac905e2"),
  name: "Read Lookups",
  code: "LOOKUP_READ",           // Unique identifier
  description: "Permission to read lookup data",
  resource: "lookup",            // What resource this applies to
  action: "read",               // What action is allowed
  category: "GENERAL",          // Permission category
  level: 1,                     // Privilege level (1-100)
  isSystemPermission: false,
  isActive: true,
  createdAt: Date,
  updatedAt: Date
}
```

#### Roles Collection

```javascript
{
  _id: ObjectId("68c6b4d1e42306a6836622cf"),
  tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453", // Tenant isolation
  name: "Non-Member",
  code: "NON-MEMBER",
  description: "Non-member user role",
  userType: "PORTAL",           // PORTAL, CRM, or SYSTEM
  permissions: [                // Array of permission IDs (strings/ObjectIds)
    "profile.view",
    "dashboard.view",
    "68c84c57f10b0fff9ac905e2", // LOOKUP_READ permission ID
    "68c84c58f10b0fff9ac905ec"  // LOOKUPTYPE_READ permission ID
  ],
  isActive: true,
  isSystemRole: false
}
```

#### Users Collection

```javascript
{
  _id: ObjectId("681117cb357e50dfa229b5f2"),
  tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453",
  userEmail: "kashif147@gmail.com",
  userFullName: "Kashif Rehman",
  userType: "PORTAL",
  roles: ["68c6b4d1e42306a6836622cf"], // Array of role IDs
  isActive: true,
  createdAt: Date,
  updatedAt: Date
}
```

## 🎯 Role Hierarchy & Levels

```javascript
const ROLE_HIERARCHY = {
  // System Roles (Highest Privilege)
  SU: 100, // Super User - bypasses all authorization
  ASU: 95, // Assistant Super User - tenant-scoped management

  // Executive Roles
  GS: 90, // General Secretary
  DGS: 85, // Deputy General Secretary

  // Director Level
  DIR: 80, // Director of Industrial Relations
  DPRS: 80, // Director of Professional and Regulatory Services
  ADIR: 75, // Assistant Director Industrial Relations

  // Management Level
  AM: 70, // Accounts Manager
  DAM: 65, // Deputy Accounts Manager
  MO: 60, // Membership Officer
  AMO: 55, // Assistant Membership Officer

  // Executive Level
  IRE: 50, // Industrial Relation Executive
  IRO: 45, // Industrial Relations Officers
  RO: 40, // Regional Officer
  BO: 35, // Branch Officer

  // Officer Level
  IO: 30, // Information Officer
  HLS: 25, // Head of Library Services
  CC: 20, // Course Coordinator
  ACC: 15, // Assistant Course Coordinator

  // Support Level
  LS: 10, // Librarian
  LA: 5, // Library Assistant
  AA: 5, // Accounts Assistant

  // Basic Access
  REO: 1, // Read Only
  MEMBER: 1, // Member
  "NON-MEMBER": 0, // Non-Member
};
```

## 📊 Permission Matrix by Resource

| Resource       | Action            | Permission Code          | Min Role Level | User Types  | Description                 |
| -------------- | ----------------- | ------------------------ | -------------- | ----------- | --------------------------- |
| **LOOKUP**     | read              | `LOOKUP_READ`            | 0              | PORTAL, CRM | Read lookup data            |
| **LOOKUP**     | write             | `LOOKUP_WRITE`           | 30             | CRM         | Create/update lookups       |
| **LOOKUP**     | delete            | `LOOKUP_DELETE`          | 60             | CRM         | Delete lookups              |
| **LOOKUPTYPE** | read              | `LOOKUPTYPE_READ`        | 0              | PORTAL, CRM | Read lookup types           |
| **LOOKUPTYPE** | write             | `LOOKUPTYPE_WRITE`       | 30             | CRM         | Create/update lookup types  |
| **LOOKUPTYPE** | delete            | `LOOKUPTYPE_DELETE`      | 60             | CRM         | Delete lookup types         |
| **USER**       | read              | `USER_READ`              | 30             | CRM         | Read user data              |
| **USER**       | write             | `USER_WRITE`             | 30             | CRM         | Create/update users         |
| **USER**       | delete            | `USER_DELETE`            | 60             | CRM         | Delete users                |
| **USER**       | manage_roles      | `USER_MANAGE_ROLES`      | 80             | CRM         | Assign/remove user roles    |
| **ROLE**       | read              | `ROLE_READ`              | 30             | CRM         | Read role data              |
| **ROLE**       | write             | `ROLE_WRITE`             | 30             | CRM         | Create/update roles         |
| **ROLE**       | delete            | `ROLE_DELETE`            | 60             | CRM         | Delete roles                |
| **ROLE**       | permission_assign | `ROLE_PERMISSION_ASSIGN` | 80             | CRM         | Assign permissions to roles |
| **ADMIN**      | access            | `ADMIN_ACCESS`           | 80             | CRM         | Access admin panel          |
| **ADMIN**      | read              | `ADMIN_READ`             | 80             | CRM         | Read admin data             |
| **ADMIN**      | write             | `ADMIN_WRITE`            | 80             | CRM         | Admin write operations      |
| **ADMIN**      | delete            | `ADMIN_DELETE`           | 80             | CRM         | Admin delete operations     |
| **CRM**        | access            | `CRM_ACCESS`             | 30             | CRM         | Access CRM system           |
| **CRM**        | member_read       | `CRM_MEMBER_READ`        | 30             | CRM         | Read member data            |
| **CRM**        | member_write      | `CRM_MEMBER_WRITE`       | 30             | CRM         | Create/update members       |
| **CRM**        | member_delete     | `CRM_MEMBER_DELETE`      | 60             | CRM         | Delete members              |
| **PORTAL**     | access            | `PORTAL_ACCESS`          | 0              | PORTAL      | Access portal               |
| **PORTAL**     | profile_read      | `PORTAL_PROFILE_READ`    | 0              | PORTAL      | Read own profile            |
| **PORTAL**     | profile_write     | `PORTAL_PROFILE_WRITE`   | 0              | PORTAL      | Update own profile          |
| **API**        | read              | `API_READ`               | 1              | PORTAL, CRM | API read access             |
| **API**        | write             | `API_WRITE`              | 30             | CRM         | API write access            |
| **API**        | delete            | `API_DELETE`             | 60             | CRM         | API delete access           |
| **TENANT**     | read              | `TENANT_READ`            | 80             | CRM         | Read tenant data            |
| **TENANT**     | write             | `TENANT_WRITE`           | 80             | CRM         | Create/update tenants       |
| **TENANT**     | delete            | `TENANT_DELETE`          | 100            | CRM         | Delete tenants              |

## 🏗️ How to Define Roles and Permissions

### 1. Permission Definition

```javascript
// Permission Schema Structure
{
  name: "Read Lookups",                    // Human-readable name
  code: "LOOKUP_READ",                     // Unique identifier (RESOURCE_ACTION format)
  description: "Permission to read lookup data",
  resource: "lookup",                      // Resource this applies to
  action: "read",                          // Action allowed
  category: "GENERAL",                     // Permission category
  level: 0,                               // Minimum privilege level (0-100)
  isSystemPermission: false,              // System vs custom permission
  isActive: true,                         // Active status
  tenantId: null                          // Global permission (null) or tenant-specific
}
```

**Example Permission Creation:**

```javascript
const lookupReadPermission = {
  name: "Read Lookups",
  code: "LOOKUP_READ",
  description: "Permission to read lookup data",
  resource: "lookup",
  action: "read",
  category: "GENERAL",
  level: 0, // Anyone can read
  isSystemPermission: true, // Core system permission
  isActive: true,
};
```

### 2. Role Definition

```javascript
// Role Schema Structure
{
  tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453", // MANDATORY - tenant isolation
  name: "Non-Member",
  code: "NON-MEMBER",
  description: "Non-member user role",
  userType: "PORTAL",                     // PORTAL, CRM, or SYSTEM
  permissions: [                          // Array of permission IDs
    "68c84c57f10b0fff9ac905e2",         // LOOKUP_READ permission ID
    "68c84c58f10b0fff9ac905ec",         // LOOKUPTYPE_READ permission ID
    "profile.view",                      // Legacy permission (string)
    "dashboard.view"                     // Legacy permission (string)
  ],
  isActive: true,
  isSystemRole: false,                    // System vs custom role
  createdBy: "system",
  updatedBy: "admin@example.com"
}
```

**Example Role Creation:**

```javascript
const nonMemberRole = {
  tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453",
  name: "Non-Member",
  code: "NON-MEMBER",
  description: "Non-member user role with basic portal access",
  userType: "PORTAL",
  permissions: [
    "LOOKUP_READ", // Direct permission code
    "LOOKUPTYPE_READ", // Direct permission code
    "PORTAL_PROFILE_READ", // Direct permission code
    "PORTAL_PROFILE_WRITE", // Direct permission code
  ],
  isActive: true,
  isSystemRole: true,
};
```

### 3. User Assignment

```javascript
// User Schema Structure
{
  tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453", // MANDATORY
  userEmail: "kashif147@gmail.com",
  userFullName: "Kashif Rehman",
  userType: "PORTAL",                     // PORTAL, CRM, or SYSTEM
  roles: [                                // Array of role IDs
    "68c6b4d1e42306a6836622cf"           // NON-MEMBER role ID
  ],
  isActive: true,
  createdAt: Date,
  updatedAt: Date
}
```

## 📋 Role-Permission Assignment Guidelines

### By User Type:

#### PORTAL Users (Members/Non-Members)

```javascript
// NON-MEMBER Role
permissions: [
  "LOOKUP_READ",
  "LOOKUPTYPE_READ",
  "PORTAL_PROFILE_READ",
  "PORTAL_PROFILE_WRITE",
];

// MEMBER Role
permissions: [
  "LOOKUP_READ",
  "LOOKUPTYPE_READ",
  "PORTAL_PROFILE_READ",
  "PORTAL_PROFILE_WRITE",
  "API_READ",
];
```

#### CRM Users (Staff)

```javascript
// REO (Read Only) Role
permissions: [
  "USER_READ",
  "ROLE_READ",
  "LOOKUP_READ",
  "LOOKUPTYPE_READ",
  "CRM_MEMBER_READ",
];

// IO (Information Officer) Role
permissions: [
  "USER_READ",
  "USER_WRITE",
  "ROLE_READ",
  "LOOKUP_READ",
  "LOOKUP_WRITE",
  "LOOKUPTYPE_READ",
  "LOOKUPTYPE_WRITE",
  "CRM_MEMBER_READ",
  "CRM_MEMBER_WRITE",
  "API_READ",
  "API_WRITE",
];

// MO (Membership Officer) Role
permissions: [
  "USER_READ",
  "USER_WRITE",
  "USER_DELETE",
  "ROLE_READ",
  "ROLE_WRITE",
  "LOOKUP_READ",
  "LOOKUP_WRITE",
  "LOOKUP_DELETE",
  "LOOKUPTYPE_READ",
  "LOOKUPTYPE_WRITE",
  "LOOKUPTYPE_DELETE",
  "CRM_MEMBER_READ",
  "CRM_MEMBER_WRITE",
  "CRM_MEMBER_DELETE",
  "API_READ",
  "API_WRITE",
  "API_DELETE",
];

// DIR (Director) Role
permissions: [
  "USER_READ",
  "USER_WRITE",
  "USER_DELETE",
  "USER_MANAGE_ROLES",
  "ROLE_READ",
  "ROLE_WRITE",
  "ROLE_DELETE",
  "ROLE_PERMISSION_ASSIGN",
  "ADMIN_ACCESS",
  "ADMIN_READ",
  "ADMIN_WRITE",
  "ADMIN_DELETE",
  "TENANT_READ",
  "TENANT_WRITE",
  // ... all other permissions
];
```

## 🔧 Implementation Best Practices

### 1. Permission Naming Convention

```
{RESOURCE}_{ACTION}
- LOOKUP_READ, LOOKUP_WRITE, LOOKUP_DELETE
- USER_READ, USER_WRITE, USER_DELETE, USER_MANAGE_ROLES
- ROLE_READ, ROLE_WRITE, ROLE_DELETE, ROLE_PERMISSION_ASSIGN
```

### 2. Role Assignment Rules

- **Tenant Isolation**: Every role MUST have a `tenantId`
- **User Type Alignment**: PORTAL users get PORTAL roles, CRM users get CRM roles
- **Hierarchy Respect**: Higher-level roles inherit lower-level permissions
- **Permission Consistency**: Use actual database permission codes, not mapped values

### 3. Security Considerations

- **Least Privilege**: Give minimum required permissions
- **Role Hierarchy**: Use privilege levels (0-100) for authorization
- **Tenant Isolation**: Always check tenantId matches
- **System vs Custom**: Distinguish between system and custom roles/permissions

### 4. Migration Strategy

When updating existing roles:

1. **Audit Current**: Check existing permission assignments
2. **Map Permissions**: Convert legacy permissions to new format
3. **Test Thoroughly**: Verify all APIs work with new permissions
4. **Deploy Gradually**: Update roles in stages

## 🚨 Common Issues & Solutions

### Issue 1: Permission Population Returns Undefined

**Problem**: `role.permissions` shows `undefined: undefined`
**Cause**: Mixed permission storage (strings vs ObjectIds)
**Solution**: Use consistent permission codes as strings

### Issue 2: INSUFFICIENT_ROLE_LEVEL Error

**Problem**: User gets denied despite having permissions
**Cause**: Role level too low for action requirement
**Solution**: Check role hierarchy and adjust levels

### Issue 3: Tenant Mismatch

**Problem**: User can't access resources
**Cause**: tenantId mismatch between user and resource
**Solution**: Ensure tenant isolation is properly implemented

### Issue 4: Permission Mapping Mismatch

**Problem**: API denies access despite correct permissions
**Cause**: Permission mapping uses wrong permission codes
**Solution**: Use direct database permission codes in policy service

## 📝 Quick Reference Commands

### Check User Permissions

```bash
NODE_ENV=staging node check-staging-lookup-permissions.js
```

### Fix Permission Assignments

```bash
NODE_ENV=staging node fix-lookup-permissions.js
```

### Test Policy Evaluation

```bash
NODE_ENV=staging node test-policy-evaluation.js
```

### Test API Access

```bash
NODE_ENV=staging node test-lookup-api.js
```

## 🔄 Policy Service Configuration

The policy service uses this mapping in `services/policyEvaluationService.js`:

```javascript
const permissionMap = {
  portal: {
    read: "PORTAL_PROFILE_READ",
    write: "PORTAL_PROFILE_WRITE",
  },
  crm: {
    read: "CRM_MEMBER_READ",
    write: "CRM_MEMBER_WRITE",
    delete: "CRM_MEMBER_DELETE",
  },
  user: {
    read: "USER_READ",
    write: "USER_WRITE",
    delete: "USER_DELETE",
  },
  role: {
    read: "ROLE_READ",
    write: "ROLE_WRITE",
    delete: "ROLE_DELETE",
  },
  lookup: {
    read: "LOOKUP_READ",
    write: "LOOKUP_WRITE",
    delete: "LOOKUP_DELETE",
  },
  lookupType: {
    read: "LOOKUPTYPE_READ",
    write: "LOOKUPTYPE_WRITE",
    delete: "LOOKUPTYPE_DELETE",
  },
  admin: {
    read: "ADMIN_READ",
    write: "ADMIN_WRITE",
    delete: "ADMIN_DELETE",
  },
  api: {
    read: "API_READ",
    write: "API_WRITE",
    delete: "API_DELETE",
  },
  tenant: {
    read: "TENANT_READ",
    write: "TENANT_WRITE",
    delete: "TENANT_DELETE",
  },
};
```

## 📚 Additional Resources

- [RBAC API Guide](./RBAC-API-GUIDE.md)
- [React Developer Guide](./REACT-DEVELOPER-GUIDE.md)
- [React Native Developer Guide](./REACT-NATIVE-DEVELOPER-GUIDE.md)
- [Testing Guide](./RBAC-TESTING-GUIDE.md)
- [Implementation Guide](./IMPLEMENTATION-GUIDE.md)

---

**Last Updated**: January 2024  
**Version**: 1.0.0  
**Maintainer**: Development Team
