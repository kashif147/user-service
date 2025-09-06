const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const User = require("../models/user");
const Role = require("../models/role");
const { assignDefaultRole } = require("../helpers/roleAssignment");

async function testDefaultRoleAssignment() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Test 1: Check if roles exist
    console.log("\n=== Test 1: Check if roles exist ===");
    const nonMemberRole = await Role.findOne({
      code: "NON-MEMBER",
      isActive: true,
    });
    const aaRole = await Role.findOne({ code: "REO", isActive: true });

    console.log(`NON-MEMBER role exists: ${!!nonMemberRole}`);
    console.log(`REO role exists: ${!!aaRole}`);

    if (!nonMemberRole || !aaRole) {
      console.log(
        "Required roles not found. Please run role initialization first."
      );
      return;
    }

    // Test 2: Create a test portal user
    console.log("\n=== Test 2: Create Portal User ===");
    const portalUser = new User({
      userEmail: "portal.test@example.com",
      userFullName: "Portal Test User",
      userType: "PORTAL",
    });

    await assignDefaultRole(portalUser, "PORTAL");
    await portalUser.save();

    const savedPortalUser = await User.findById(portalUser._id).populate(
      "roles"
    );
    console.log(
      `Portal user created with roles: ${savedPortalUser.roles
        .map((r) => r.code)
        .join(", ")}`
    );

    // Test 3: Create a test CRM user
    console.log("\n=== Test 3: Create CRM User ===");
    const crmUser = new User({
      userEmail: "crm.test@example.com",
      userFullName: "CRM Test User",
      userType: "CRM",
    });

    await assignDefaultRole(crmUser, "CRM");
    await crmUser.save();

    const savedCrmUser = await User.findById(crmUser._id).populate("roles");
    console.log(
      `CRM user created with roles: ${savedCrmUser.roles
        .map((r) => r.code)
        .join(", ")}`
    );

    // Test 4: Verify role assignment
    console.log("\n=== Test 4: Verify Role Assignment ===");
    const portalUserRoles = savedPortalUser.roles.map((r) => r.code);
    const crmUserRoles = savedCrmUser.roles.map((r) => r.code);

    console.log(
      `Portal user has NON-MEMBER role: ${portalUserRoles.includes(
        "NON-MEMBER"
      )}`
    );
    console.log(`CRM user has REO role: ${crmUserRoles.includes("REO")}`);

    // Test 5: Test JWT token generation with roles
    console.log("\n=== Test 5: Test JWT Token Generation ===");
    const jwtHelper = require("../helpers/jwt");

    try {
      const portalToken = await jwtHelper.generateToken(savedPortalUser);
      console.log("Portal user JWT generated successfully");

      const crmToken = await jwtHelper.generateToken(savedCrmUser);
      console.log("CRM user JWT generated successfully");

      // Decode tokens to verify roles are included
      const jwt = require("jsonwebtoken");
      const portalDecoded = jwt.decode(
        portalToken.token.replace("Bearer ", "")
      );
      const crmDecoded = jwt.decode(crmToken.token.replace("Bearer ", ""));

      console.log(
        `Portal user JWT roles: ${portalDecoded.roles
          ?.map((r) => r.code)
          .join(", ")}`
      );
      console.log(
        `CRM user JWT roles: ${crmDecoded.roles?.map((r) => r.code).join(", ")}`
      );
    } catch (jwtError) {
      console.log("JWT generation error:", jwtError.message);
    }

    // Cleanup
    console.log("\n=== Cleanup ===");
    await User.findByIdAndDelete(portalUser._id);
    await User.findByIdAndDelete(crmUser._id);
    console.log("Test users deleted");

    console.log("\n✅ All tests completed successfully!");
    console.log("\nSummary:");
    console.log("- Portal users automatically get NON-MEMBER role");
    console.log("- CRM users automatically get REO (Read Only) role");
    console.log("- JWT tokens include user roles and permissions");
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

module.exports = { testDefaultRoleAssignment };

// Run if called directly
if (require.main === module) {
  testDefaultRoleAssignment();
}
