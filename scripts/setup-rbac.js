const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const RoleHandler = require("../handlers/role.handler");

async function initializeAndTest(tenantId) {
  try {
    if (!tenantId) {
      throw new Error("TenantId is required for RBAC setup");
    }

    // Connection options for better Atlas connectivity
    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(process.env.MONGO_URI, options);
    console.log("Connected to MongoDB");

    // Step 1: Initialize roles for specific tenant
    console.log(`\n🚀 Initializing roles for tenant: ${tenantId}...`);
    const roles = await RoleHandler.initializeRoles(tenantId);
    console.log(`✅ Initialized ${roles.length} roles for tenant ${tenantId}`);

    // Step 2: Verify NON-MEMBER and REO roles exist for tenant
    console.log("\n🔍 Verifying required roles...");
    const nonMemberRole = await RoleHandler.getRoleByCode(
      "NON-MEMBER",
      tenantId
    );
    const reoRole = await RoleHandler.getRoleByCode("REO", tenantId);

    console.log(
      `✅ NON-MEMBER role: ${nonMemberRole.name} (tenant: ${tenantId})`
    );
    console.log(`✅ REO role: ${reoRole.name} (tenant: ${tenantId})`);

    // Step 3: Test default role assignment
    console.log("\n🧪 Testing default role assignment...");

    // Import the test function
    const { testDefaultRoleAssignment } = require("./test-default-roles");
    await testDefaultRoleAssignment(tenantId);

    console.log(`\n🎉 Setup completed successfully for tenant: ${tenantId}!`);
    console.log("\nNext steps:");
    console.log("1. Portal users will automatically get NON-MEMBER role");
    console.log("2. CRM users will automatically get REO (Read Only) role");
    console.log("3. Use ProjectShell-1 to manage roles and permissions");
    console.log("4. JWT tokens now include user roles and permissions");
    console.log("5. All operations are tenant-isolated");
  } catch (error) {
    console.error("❌ Setup failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

// Get tenantId from command line arguments
const tenantId = process.argv[2];
if (!tenantId) {
  console.error("❌ Usage: node setup-rbac.js <tenantId>");
  console.error("Example: node setup-rbac.js tenant-001");
  process.exit(1);
}

initializeAndTest(tenantId);
