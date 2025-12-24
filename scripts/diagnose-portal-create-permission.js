#!/usr/bin/env node

/**
 * Comprehensive diagnostic script to check PORTAL_CREATE permission flow
 *
 * Checks:
 * 1. If PORTAL_CREATE permission exists in database
 * 2. If NON-MEMBER and MEMBER roles have PORTAL_CREATE
 * 3. If users have PORTAL_CREATE in their roles
 * 4. Permission structure (resource/action mapping)
 *
 * Usage: NODE_ENV=staging node scripts/diagnose-portal-create-permission.js [userEmail]
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const User = require("../models/user.model");

async function diagnosePortalCreatePermission(userEmail = null) {
  try {
    // Connect to database
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error(
        "MONGO_URI environment variable is not set in .env.staging"
      );
    }

    console.log("🔗 Connecting to staging MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB\n");

    // Step 1: Check if PORTAL_CREATE permission exists
    console.log("=".repeat(60));
    console.log("STEP 1: Checking PORTAL_CREATE Permission");
    console.log("=".repeat(60));

    const portalCreatePermission = await Permission.findOne({
      code: "PORTAL_CREATE",
      isActive: true,
    });

    if (!portalCreatePermission) {
      console.log("❌ PORTAL_CREATE permission NOT FOUND!");
      console.log("💡 Run insert-portal-permissions.js to create it\n");
      process.exit(1);
    }

    console.log("✅ PORTAL_CREATE permission exists:");
    console.log(`   Code: ${portalCreatePermission.code}`);
    console.log(`   Name: ${portalCreatePermission.name}`);
    console.log(`   Resource: ${portalCreatePermission.resource}`);
    console.log(`   Action: ${portalCreatePermission.action}`);
    console.log(`   Category: ${portalCreatePermission.category}`);
    console.log(`   Level: ${portalCreatePermission.level}\n`);

    // Verify resource/action mapping
    if (portalCreatePermission.resource.toLowerCase() !== "portal") {
      console.log(
        `⚠️  WARNING: Permission resource is "${portalCreatePermission.resource}" but should be "portal"`
      );
    }
    if (portalCreatePermission.action.toLowerCase() !== "create") {
      console.log(
        `⚠️  WARNING: Permission action is "${portalCreatePermission.action}" but should be "create"`
      );
    }

    // Step 2: Check all portal permissions
    console.log("=".repeat(60));
    console.log("STEP 2: Checking All Portal Permissions");
    console.log("=".repeat(60));

    const portalPermissions = await Permission.find({
      resource: { $regex: /^portal$/i },
      isActive: true,
    }).sort({ code: 1 });

    console.log(`Found ${portalPermissions.length} portal permission(s):\n`);
    portalPermissions.forEach((perm) => {
      const marker = perm.code === "PORTAL_CREATE" ? " ⭐" : "";
      console.log(
        `  • ${perm.code} - ${perm.name} (${perm.resource}:${perm.action})${marker}`
      );
    });
    console.log();

    // Step 3: Check roles
    console.log("=".repeat(60));
    console.log("STEP 3: Checking NON-MEMBER and MEMBER Roles");
    console.log("=".repeat(60));

    const Tenant = require("../models/tenant.model");
    const tenants = await Tenant.find({ isActive: true });

    if (tenants.length === 0) {
      console.log("❌ No active tenants found!");
      process.exit(1);
    }

    for (const tenant of tenants) {
      console.log(`\n📊 Tenant: ${tenant.name} (${tenant.code})`);

      // Check NON-MEMBER role
      const nonMemberRole = await Role.findOne({
        code: "NON-MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (!nonMemberRole) {
        console.log("❌ NON-MEMBER role not found");
      } else {
        console.log(`\n✅ NON-MEMBER Role:`);
        console.log(`   Name: ${nonMemberRole.name}`);
        console.log(
          `   Total Permissions: ${nonMemberRole.permissions.length}`
        );
        const hasPortalCreate =
          nonMemberRole.permissions.includes("PORTAL_CREATE");
        console.log(
          `   Has PORTAL_CREATE: ${hasPortalCreate ? "✅ YES" : "❌ NO"}`
        );

        // Show all portal permissions
        const portalPerms = nonMemberRole.permissions.filter(
          (p) =>
            typeof p === "string" &&
            (p.includes("PORTAL") || p.includes("portal"))
        );
        if (portalPerms.length > 0) {
          console.log(`   Portal Permissions: ${portalPerms.join(", ")}`);
        } else {
          console.log(`   Portal Permissions: None`);
        }
      }

      // Check MEMBER role
      const memberRole = await Role.findOne({
        code: "MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (!memberRole) {
        console.log("\n❌ MEMBER role not found");
      } else {
        console.log(`\n✅ MEMBER Role:`);
        console.log(`   Name: ${memberRole.name}`);
        console.log(`   Total Permissions: ${memberRole.permissions.length}`);
        const hasPortalCreate =
          memberRole.permissions.includes("PORTAL_CREATE");
        console.log(
          `   Has PORTAL_CREATE: ${hasPortalCreate ? "✅ YES" : "❌ NO"}`
        );

        // Show all portal permissions
        const portalPerms = memberRole.permissions.filter(
          (p) =>
            typeof p === "string" &&
            (p.includes("PORTAL") || p.includes("portal"))
        );
        if (portalPerms.length > 0) {
          console.log(`   Portal Permissions: ${portalPerms.join(", ")}`);
        } else {
          console.log(`   Portal Permissions: None`);
        }
      }
    }

    // Step 4: Check specific user if provided
    if (userEmail) {
      console.log("\n" + "=".repeat(60));
      console.log(`STEP 4: Checking User: ${userEmail}`);
      console.log("=".repeat(60));

      const user = await User.findOne({
        userEmail: userEmail,
        isActive: true,
      }).populate("roles");

      if (!user) {
        console.log(`❌ User not found: ${userEmail}`);
      } else {
        console.log(`\n✅ User Found:`);
        console.log(`   Email: ${user.userEmail}`);
        console.log(`   User Type: ${user.userType}`);
        console.log(`   Tenant ID: ${user.tenantId}`);
        console.log(`   Roles: ${user.roles.length}`);

        // Get user permissions
        const RoleHandler = require("../handlers/role.handler");
        const userPermissions = await RoleHandler.getUserPermissions(
          user._id,
          user.tenantId
        );

        console.log(`\n   User Permissions (${userPermissions.length}):`);
        const portalUserPerms = userPermissions.filter(
          (p) =>
            typeof p === "string" &&
            (p.includes("PORTAL") || p.includes("portal"))
        );
        if (portalUserPerms.length > 0) {
          console.log(`   Portal Permissions: ${portalUserPerms.join(", ")}`);
          const hasPortalCreate = userPermissions.includes("PORTAL_CREATE");
          console.log(
            `   Has PORTAL_CREATE: ${hasPortalCreate ? "✅ YES" : "❌ NO"}`
          );
        } else {
          console.log(`   Portal Permissions: None`);
          console.log(`   Has PORTAL_CREATE: ❌ NO`);
        }

        // Show role details
        console.log(`\n   Role Details:`);
        user.roles.forEach((role) => {
          const hasPortalCreate = role.permissions.includes("PORTAL_CREATE");
          console.log(
            `     • ${role.code} (${role.name}) - PORTAL_CREATE: ${
              hasPortalCreate ? "✅" : "❌"
            }`
          );
        });
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY");
    console.log("=".repeat(60));
    console.log(
      `✅ PORTAL_CREATE permission exists: ${
        portalCreatePermission ? "YES" : "NO"
      }`
    );
    console.log(`   Resource: ${portalCreatePermission.resource}`);
    console.log(`   Action: ${portalCreatePermission.action}`);
    console.log(`   Code: ${portalCreatePermission.code}`);
    console.log("\n💡 To fix missing PORTAL_CREATE in NON-MEMBER role:");
    console.log(
      "   Run: NODE_ENV=staging node scripts/add-portal-create-to-non-member.js"
    );
    console.log("=".repeat(60));
  } catch (error) {
    console.error("❌ Script error:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

// Get user email from command line args
const userEmail = process.argv[2] || null;

// Run the script
diagnosePortalCreatePermission(userEmail)
  .then(() => {
    console.log("\n✅ Diagnostic completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Diagnostic failed:", error.message);
    process.exit(1);
  });
