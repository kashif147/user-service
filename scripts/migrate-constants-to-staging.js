#!/usr/bin/env node
/**
 * Migration script to populate STAGING MongoDB with roles, permissions, and tenants from constants
 * This script will:
 * 1. Connect to staging MongoDB Atlas
 * 2. Create sample tenants
 * 3. Populate permissions from constants
 * 4. Create roles with proper tenant isolation
 * 5. Assign roles to any existing users based on their current role assignments
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const Tenant = require("../models/tenant.model");
const axios = require("axios");

// Default roles and permissions data (fallback if API not available)
const DEFAULT_ROLES = [
  // System Roles
  {
    name: "Super User",
    code: "SU",
    description:
      "Super User with full system access and role management capabilities",
    userType: "SYSTEM",
    permissions: ["*"], // Full access
    isSystemRole: true,
  },
  {
    name: "Assistant Super User",
    code: "ASU",
    description:
      "Assistant Super User with tenant-scoped role and permission management",
    userType: "SYSTEM",
    permissions: [
      "USER_READ",
      "USER_WRITE",
      "USER_MANAGE_ROLES",
      "ROLE_READ",
      "ROLE_WRITE",
      "ROLE_PERMISSION_ASSIGN",
    ],
    isSystemRole: true,
  },
  // Portal Roles
  {
    name: "Member",
    code: "MEMBER",
    description: "Registered member with full portal access",
    userType: "PORTAL",
    permissions: [
      "PORTAL_ACCESS",
      "PORTAL_PROFILE_READ",
      "PORTAL_PROFILE_WRITE",
      "ACCOUNT_READ",
      "ACCOUNT_PAYMENT",
      "ACCOUNT_TRANSACTION_READ",
    ],
  },
  {
    name: "Non-Member",
    code: "NON-MEMBER",
    description: "Non-member with limited portal access",
    userType: "PORTAL",
    permissions: [],
  },
  // CRM Roles
  {
    name: "Read Only",
    code: "REO",
    description: "Read Only access with limited permissions",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Membership Officer",
    code: "MO",
    description: "Membership Officer",
    userType: "CRM",
    permissions: [],
  },
  // AI Agent Role
  {
    name: "AI Agent",
    code: "AI",
    description: "AI Agent with read-only access to all microservices",
    userType: "SYSTEM",
    permissions: [
      "READ_ONLY",
      "USER_READ",
      "ROLE_READ",
      "ACCOUNT_READ",
      "ACCOUNT_TRANSACTION_READ",
      "CRM_MEMBER_READ",
    ],
    isSystemRole: true,
  },
];

const DEFAULT_PERMISSIONS = {
  // General read permissions
  READ_ONLY: "read:all",

  // User Service permissions
  USER: {
    READ: "user:read",
    WRITE: "user:write",
    DELETE: "user:delete",
    MANAGE_ROLES: "user:manage_roles",
    CREATE: "user:create",
    UPDATE: "user:update",
    LIST: "user:list",
  },

  // Role Service permissions
  ROLE: {
    READ: "role:read",
    WRITE: "role:write",
    DELETE: "role:delete",
    CREATE: "role:create",
    UPDATE: "role:update",
    LIST: "role:list",
    ASSIGN: "role:assign",
    REMOVE: "role:remove",
  },

  // Account Service permissions
  ACCOUNT: {
    READ: "account:read",
    WRITE: "account:write",
    DELETE: "account:delete",
    PAYMENT: "account:payment",
    TRANSACTION_READ: "account:transaction:read",
    TRANSACTION_WRITE: "account:transaction:write",
    TRANSACTION_DELETE: "account:transaction:delete",
  },

  // Portal Service permissions
  PORTAL: {
    ACCESS: "portal:access",
    PROFILE_READ: "portal:profile:read",
    PROFILE_WRITE: "portal:profile:write",
    PROFILE_DELETE: "portal:profile:delete",
    DASHBOARD_READ: "portal:dashboard:read",
    SETTINGS_READ: "portal:settings:read",
    SETTINGS_WRITE: "portal:settings:write",
  },

  // CRM Service permissions
  CRM: {
    ACCESS: "crm:access",
    MEMBER_READ: "crm:member:read",
    MEMBER_WRITE: "crm:member:write",
    MEMBER_DELETE: "crm:member:delete",
    MEMBER_CREATE: "crm:member:create",
    MEMBER_UPDATE: "crm:member:update",
    MEMBER_LIST: "crm:member:list",
  },
};

// Helper function to fetch roles from API
async function fetchRolesFromAPI() {
  try {
    const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
    const response = await axios.get(`${baseUrl}/api/roles/roles`, {
      headers: {
        Authorization: `Bearer ${
          process.env.SUPER_USER_TOKEN || "fallback-token"
        }`,
        "Content-Type": "application/json",
      },
    });
    return response.data.data || DEFAULT_ROLES;
  } catch (error) {
    console.warn(
      "Failed to fetch roles from API, using defaults:",
      error.message
    );
    return DEFAULT_ROLES;
  }
}

// Helper function to fetch permissions from API
async function fetchPermissionsFromAPI() {
  try {
    const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
    const response = await axios.get(`${baseUrl}/api/permissions/permissions`, {
      headers: {
        Authorization: `Bearer ${
          process.env.SUPER_USER_TOKEN || "fallback-token"
        }`,
        "Content-Type": "application/json",
      },
    });
    return response.data.data || DEFAULT_PERMISSIONS;
  } catch (error) {
    console.warn(
      "Failed to fetch permissions from API, using defaults:",
      error.message
    );
    return DEFAULT_PERMISSIONS;
  }
}

// Default tenants to create for staging
const STAGING_TENANTS = [
  {
    name: "Main Organization (Staging)",
    code: "MAIN",
    description: "Primary organization tenant for staging environment",
    domain: "staging-main.organization.com",
    contactEmail: "admin@staging.organization.com",
    contactPhone: "+1-555-0100",
    status: "ACTIVE",
    subscription: {
      plan: "ENTERPRISE",
      startDate: new Date(),
      autoRenew: true,
    },
  },
  {
    name: "Audit Department (Staging)",
    code: "AUDIT",
    description: "Audit department tenant for staging environment",
    domain: "staging-audit.organization.com",
    contactEmail: "audit@staging.organization.com",
    contactPhone: "+1-555-0101",
    status: "ACTIVE",
    subscription: {
      plan: "PREMIUM",
      startDate: new Date(),
      autoRenew: true,
    },
  },
  {
    name: "Finance Division (Staging)",
    code: "FINANCE",
    description: "Finance division tenant for staging environment",
    domain: "staging-finance.organization.com",
    contactEmail: "finance@staging.organization.com",
    contactPhone: "+1-555-0102",
    status: "ACTIVE",
    subscription: {
      plan: "PREMIUM",
      startDate: new Date(),
      autoRenew: true,
    },
  },
  {
    name: "HR Department (Staging)",
    code: "HR",
    description: "Human Resources department tenant for staging environment",
    domain: "staging-hr.organization.com",
    contactEmail: "hr@staging.organization.com",
    contactPhone: "+1-555-0103",
    status: "ACTIVE",
    subscription: {
      plan: "BASIC",
      startDate: new Date(),
      autoRenew: true,
    },
  },
];

// Helper function to map categories to valid enum values
function mapCategoryToEnum(category) {
  const categoryMap = {
    READ_ONLY: "GENERAL",
    USER: "USER",
    ROLE: "ROLE",
    ACCOUNT: "ACCOUNT",
    PORTAL: "PORTAL",
    CRM: "CRM",
    AUDIT: "AUDIT",
    SUBSCRIPTION: "SUBSCRIPTION",
    PROFILE: "PROFILE",
    FINANCIAL: "FINANCIAL",
    ADMIN: "ADMIN",
    INVOICE: "INVOICE",
    RECEIPT: "RECEIPT",
  };

  return categoryMap[category] || "GENERAL";
}

// Helper function to extract permissions from PERMISSIONS object
function extractPermissions(obj, prefix = "") {
  let permissions = [];

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // This is a permission string
      const resource = value.split(":")[0] || "general";
      const action = value.split(":")[1] || "access";

      permissions.push({
        name: key
          .replace(/_/g, " ")
          .toLowerCase()
          .replace(/\b\w/g, (l) => l.toUpperCase()),
        code: value.toUpperCase().replace(/:/g, "_"),
        description: `${key
          .replace(/_/g, " ")
          .toLowerCase()} permission for ${resource} (staging)`,
        resource: resource,
        action: action,
        category: mapCategoryToEnum(prefix || resource.toUpperCase()),
        level: 1,
        isSystemPermission: prefix === "SYSTEM" || false,
        createdBy: "staging-migration-script",
      });
    } else if (typeof value === "object" && value !== null) {
      // This is a nested object, recurse
      const nestedPermissions = extractPermissions(value, key);
      permissions = permissions.concat(nestedPermissions);
    }
  }

  return permissions;
}

async function connectDB() {
  try {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error(
        "MONGO_URI environment variable is not set in .env.staging"
      );
    }

    console.log("🔗 Connecting to staging MongoDB Atlas...");
    console.log("   Database:", mongoUri.split("/")[3].split("?")[0]);

    await mongoose.connect(mongoUri);
    console.log("✓ Connected to staging MongoDB Atlas");
  } catch (error) {
    console.error("✗ Staging MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function createTenants() {
  console.log("\n📂 Creating staging tenants...");

  const createdTenants = [];

  for (const tenantData of STAGING_TENANTS) {
    try {
      // Check if tenant already exists
      const existingTenant = await Tenant.findOne({
        $or: [{ code: tenantData.code }, { domain: tenantData.domain }],
      });

      if (existingTenant) {
        console.log(
          `  ⚠️  Tenant ${tenantData.code} already exists, skipping...`
        );
        createdTenants.push(existingTenant);
        continue;
      }

      const tenant = new Tenant({
        ...tenantData,
        createdBy: "staging-migration-script",
        updatedBy: "staging-migration-script",
      });

      await tenant.save();
      createdTenants.push(tenant);
      console.log(
        `  ✓ Created staging tenant: ${tenant.name} (${tenant.code})`
      );
    } catch (error) {
      console.error(
        `  ✗ Failed to create staging tenant ${tenantData.code}:`,
        error.message
      );
    }
  }

  return createdTenants;
}

async function createPermissions() {
  console.log("\n🔐 Creating staging permissions...");

  // Fetch permissions from API or use defaults
  const permissionsData = await fetchPermissionsFromAPI();

  // Extract all permissions from the permissions object
  const permissionData = extractPermissions(permissionsData);

  console.log(`  📊 Found ${permissionData.length} permissions to create`);

  const createdPermissions = [];

  for (const permData of permissionData) {
    try {
      // Check if permission already exists
      const existingPermission = await Permission.findOne({
        code: permData.code,
      });

      if (existingPermission) {
        console.log(
          `  ⚠️  Permission ${permData.code} already exists, skipping...`
        );
        createdPermissions.push(existingPermission);
        continue;
      }

      const permission = new Permission(permData);
      await permission.save();
      createdPermissions.push(permission);
      console.log(
        `  ✓ Created staging permission: ${permission.code} (${permission.name})`
      );
    } catch (error) {
      console.error(
        `  ✗ Failed to create staging permission ${permData.code}:`,
        error.message
      );
    }
  }

  return createdPermissions;
}

async function createRoles(tenants) {
  console.log("\n👥 Creating staging roles...");

  const createdRoles = [];

  // Fetch roles from API or use defaults
  const rolesData = await fetchRolesFromAPI();
  console.log(`  📊 Using ${rolesData.length} role definitions`);

  // Create roles for each tenant
  for (const tenant of tenants) {
    console.log(`  📋 Creating roles for staging tenant: ${tenant.name}`);

    for (const roleDefinition of rolesData) {
      try {
        // Check if role already exists for this tenant
        const existingRole = await Role.findOne({
          tenantId: tenant._id.toString(),
          code: roleDefinition.code,
        });

        if (existingRole) {
          console.log(
            `    ⚠️  Role ${roleDefinition.code} already exists for tenant ${tenant.code}, skipping...`
          );
          createdRoles.push(existingRole);
          continue;
        }

        const role = new Role({
          tenantId: tenant._id.toString(),
          name: roleDefinition.name,
          code: roleDefinition.code,
          description: `${roleDefinition.description} (staging)`,
          userType: roleDefinition.userType,
          permissions: Array.isArray(roleDefinition.permissions)
            ? roleDefinition.permissions
            : [],
          isSystemRole: roleDefinition.isSystemRole || false,
          createdBy: "staging-migration-script",
          updatedBy: "staging-migration-script",
        });

        await role.save();
        createdRoles.push(role);
        console.log(`    ✓ Created staging role: ${role.code} - ${role.name}`);
      } catch (error) {
        console.error(
          `    ✗ Failed to create staging role ${roleDefinition.code} for tenant ${tenant.code}:`,
          error.message
        );
      }
    }
  }

  return createdRoles;
}

async function assignRolesToExistingUsers(roles, tenants) {
  console.log("\n👤 Assigning roles to existing staging users...");

  // Get all existing users
  const users = await User.find({}).populate("roles");

  if (users.length === 0) {
    console.log(
      "  📝 No existing users found in staging, skipping role assignment..."
    );
    return;
  }

  console.log(`  📊 Found ${users.length} existing staging users`);

  for (const user of users) {
    try {
      // If user doesn't have a tenantId, assign to main tenant
      if (!user.tenantId) {
        const mainTenant = tenants.find((t) => t.code === "MAIN");
        if (mainTenant) {
          user.tenantId = mainTenant._id.toString();
          console.log(
            `    ✓ Assigned staging user ${
              user.userEmail || user._id
            } to main tenant`
          );
        }
      }

      // If user doesn't have roles assigned, assign default role based on userType
      if (!user.roles || user.roles.length === 0) {
        let defaultRoleCode;

        switch (user.userType) {
          case "PORTAL":
            defaultRoleCode = "MEMBER";
            break;
          case "CRM":
            defaultRoleCode = "REO"; // Read Only as default for CRM users
            break;
          case "SYSTEM":
            defaultRoleCode = "AI"; // AI Agent as default for system users
            break;
          default:
            defaultRoleCode = "MEMBER";
        }

        // Find the role for this user's tenant
        const userTenantId = user.tenantId;
        const defaultRole = roles.find(
          (r) => r.tenantId === userTenantId && r.code === defaultRoleCode
        );

        if (defaultRole) {
          user.roles = [defaultRole._id];
          console.log(
            `    ✓ Assigned default role ${defaultRoleCode} to staging user ${
              user.userEmail || user._id
            }`
          );
        }
      }

      user.updatedBy = "staging-migration-script";
      await user.save();
    } catch (error) {
      console.error(
        `    ✗ Failed to update staging user ${user.userEmail || user._id}:`,
        error.message
      );
    }
  }
}

async function generateMigrationSummary() {
  console.log("\n📊 Staging Migration Summary:");

  const tenantCount = await Tenant.countDocuments();
  const permissionCount = await Permission.countDocuments();
  const roleCount = await Role.countDocuments();
  const userCount = await User.countDocuments();

  console.log(`  • Staging Tenants: ${tenantCount}`);
  console.log(`  • Staging Permissions: ${permissionCount}`);
  console.log(`  • Staging Roles: ${roleCount}`);
  console.log(`  • Staging Users: ${userCount}`);

  // Show sample data
  if (tenantCount > 0) {
    console.log("\n  Sample Staging Tenants:");
    const sampleTenants = await Tenant.find()
      .limit(3)
      .select("name code status");
    sampleTenants.forEach((tenant) => {
      console.log(`    - ${tenant.name} (${tenant.code}) - ${tenant.status}`);
    });
  }

  if (roleCount > 0) {
    console.log("\n  Sample Staging Roles:");
    const sampleRoles = await Role.find()
      .limit(5)
      .select("name code userType tenantId")
      .populate("tenantId", "name");
    sampleRoles.forEach((role) => {
      const tenantName = role.tenantId?.name || "Unknown";
      console.log(
        `    - ${role.name} (${role.code}) - ${role.userType} - Tenant: ${tenantName}`
      );
    });
  }
}

async function main() {
  console.log("🚀 Starting STAGING migration of constants to MongoDB...\n");
  console.log("🌐 Environment: STAGING");
  console.log("📅 Date:", new Date().toISOString());

  try {
    // Connect to staging database
    await connectDB();

    // Create staging tenants
    const tenants = await createTenants();

    // Create staging permissions
    const permissions = await createPermissions();

    // Create staging roles
    const roles = await createRoles(tenants);

    // Assign roles to existing staging users
    await assignRolesToExistingUsers(roles, tenants);

    // Generate summary
    await generateMigrationSummary();

    console.log("\n✅ STAGING migration completed successfully!");
    console.log(
      "🎯 Staging environment is now ready with roles, permissions, and tenants"
    );
  } catch (error) {
    console.error("\n❌ STAGING migration failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from staging MongoDB Atlas");
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = {
  main,
  createTenants,
  createPermissions,
  createRoles,
  assignRolesToExistingUsers,
};
