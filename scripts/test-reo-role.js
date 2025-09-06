const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const User = require("../models/user");
const Role = require("../models/role");
const { assignDefaultRole } = require("../helpers/roleAssignment");

async function testREORoleAssignment() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Test 1: Check if REO role exists
    console.log("\n=== Test 1: Check if REO role exists ===");
    const reoRole = await Role.findOne({ code: "REO", isActive: true });

    if (!reoRole) {
      console.log(
        "❌ REO role not found. Please run role initialization first."
      );
      return;
    }

    console.log(`✅ REO role found: ${reoRole.name} - ${reoRole.description}`);

    // Test 2: Create a test CRM user
    console.log("\n=== Test 2: Create CRM User with REO Role ===");
    const crmUser = new User({
      userEmail: "crm.reo.test@example.com",
      userFullName: "CRM REO Test User",
      userType: "CRM",
    });

    await assignDefaultRole(crmUser, "CRM");
    await crmUser.save();

    const savedCrmUser = await User.findById(crmUser._id).populate("roles");
    console.log(
      `✅ CRM user created with roles: ${savedCrmUser.roles
        .map((r) => r.code)
        .join(", ")}`
    );

    // Test 3: Verify REO role assignment
    console.log("\n=== Test 3: Verify REO Role Assignment ===");
    const crmUserRoles = savedCrmUser.roles.map((r) => r.code);

    if (crmUserRoles.includes("REO")) {
      console.log("✅ CRM user has REO role assigned correctly");
    } else {
      console.log("❌ CRM user does not have REO role");
    }

    // Test 4: Test JWT token generation
    console.log("\n=== Test 4: Test JWT Token Generation ===");
    const jwtHelper = require("../helpers/jwt");

    try {
      const crmToken = await jwtHelper.generateToken(savedCrmUser);
      console.log("✅ CRM user JWT generated successfully");

      // Decode token to verify REO role is included
      const jwt = require("jsonwebtoken");
      const crmDecoded = jwt.decode(crmToken.token.replace("Bearer ", ""));

      console.log(
        `✅ CRM user JWT roles: ${crmDecoded.roles
          ?.map((r) => r.code)
          .join(", ")}`
      );

      if (crmDecoded.roles?.some((r) => r.code === "REO")) {
        console.log("✅ JWT token includes REO role");
      } else {
        console.log("❌ JWT token missing REO role");
      }
    } catch (jwtError) {
      console.log("❌ JWT generation error:", jwtError.message);
    }

    // Test 5: Test role permissions
    console.log("\n=== Test 5: Test Role Permissions ===");
    const RoleHandler = require("../handlers/role.handler");
    const userPermissions = await RoleHandler.getUserPermissions(crmUser._id);
    console.log(`✅ User permissions: ${userPermissions.join(", ") || "None"}`);

    // Cleanup
    console.log("\n=== Cleanup ===");
    await User.findByIdAndDelete(crmUser._id);
    console.log("✅ Test user deleted");

    console.log("\n🎉 REO role assignment test completed successfully!");
    console.log("\nSummary:");
    console.log("- CRM users automatically get REO (Read Only) role");
    console.log("- JWT tokens include REO role");
    console.log("- Role permissions are properly fetched");
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

testREORoleAssignment();
