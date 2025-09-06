const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const RoleHandler = require("../handlers/role.handler");

async function initializeAndTest() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Step 1: Initialize roles
    console.log("\n🚀 Initializing roles...");
    const roles = await RoleHandler.initializeRoles();
    console.log(`✅ Initialized ${roles.length} roles`);

    // Step 2: Verify NON-MEMBER and REO roles exist
    console.log("\n🔍 Verifying required roles...");
    const nonMemberRole = await RoleHandler.getRoleByCode("NON-MEMBER");
    const reoRole = await RoleHandler.getRoleByCode("REO");

    console.log(`✅ NON-MEMBER role: ${nonMemberRole.name}`);
    console.log(`✅ REO role: ${reoRole.name}`);

    // Step 3: Test default role assignment
    console.log("\n🧪 Testing default role assignment...");

    // Import the test function
    const { testDefaultRoleAssignment } = require("./test-default-roles");
    await testDefaultRoleAssignment();

    console.log("\n🎉 Setup completed successfully!");
    console.log("\nNext steps:");
    console.log("1. Portal users will automatically get NON-MEMBER role");
    console.log("2. CRM users will automatically get REO (Read Only) role");
    console.log("3. Use ProjectShell-1 to manage roles and permissions");
    console.log("4. JWT tokens now include user roles and permissions");
  } catch (error) {
    console.error("❌ Setup failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

initializeAndTest();
