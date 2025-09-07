// Permission constants for better organization and consistency
const PERMISSIONS = {
  // General read permissions
  READ_ONLY: "read:all",

  // User service permissions
  USER: {
    READ: "user:read",
    WRITE: "user:write",
    DELETE: "user:delete",
    MANAGE_ROLES: "user:manage_roles",
  },

  // Role service permissions
  ROLE: {
    READ: "role:read",
    WRITE: "role:write",
    DELETE: "role:delete",
  },

  // Account service permissions
  ACCOUNT: {
    READ: "account:read",
    PAYMENT: "account:payment",
    TRANSACTION_READ: "account:transaction:read",
    TRANSACTION_WRITE: "account:transaction:write",
  },

  // Portal permissions
  PORTAL: {
    ACCESS: "portal:access",
    PROFILE_READ: "portal:profile:read",
    PROFILE_WRITE: "portal:profile:write",
  },

  // CRM permissions
  CRM: {
    ACCESS: "crm:access",
    MEMBER_READ: "crm:member:read",
    MEMBER_WRITE: "crm:member:write",
    MEMBER_DELETE: "crm:member:delete",
  },
};

module.exports = PERMISSIONS;
