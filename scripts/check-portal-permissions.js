#!/usr/bin/env node

/**
 * Diagnostic script to check portal permissions for NON-MEMBER and MEMBER roles
 * 
 * Usage: NODE_ENV=staging node scripts/check-portal-permissions.js
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

async function checkPortalPermissions() {
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

    // Check if PORTAL_CREATE permission exists
    console.log("📋 Checking PORTAL_CREATE permission...");
    const portalCreatePermission = await Permission.findOne({
      code: "PORTAL_CREATE",
      isActive: true,
    });

    if (!portalCreatePermission) {
      console.log("❌ PORTAL_CREATE permission NOT FOUND in database!");
      console.log("💡 Run insert-portal-permissions.js to create it\n");
    } else {
      console.log("✅ PORTAL_CREATE permission exists:");
      console.log(`   Code: ${portalCreatePermission.code}`);
      console.log(`   Name: ${portalCreatePermission.name}`);
      console.log(`   Resource: ${portalCreatePermission.resource}`);
      console.log(`   Action: ${portalCreatePermission.action}`);
      console.log(`   Category: ${portalCreatePermission.category}`);
      console.log(`   Level: ${portalCreatePermission.level}\n`);
    }

    // Check all portal permissions
    console.log("📋 All Portal Permissions:");
    const portalPermissions = await Permission.find({
      resource: { $regex: /^portal$/i },
      isActive: true,
    }).sort({ code: 1 });

    if (portalPermissions.length === 0) {
      console.log("❌ No portal permissions found!\n");
    } else {
      console.log(`Found ${portalPermissions.length} portal permission(s):\n`);
      portalPermissions.forEach((perm) => {
        console.log(`  • ${perm.code} - ${perm.name} (${perm.resource}:${perm.action})`);
      });
      console.log();
    }

    // Get all tenants
    const Tenant = require("../models/tenant.model");
    const tenants = await Tenant.find({ isActive: true });

    if (tenants.length === 0) {
      console.log("❌ No active tenants found!");
      process.exit(1);
    }

    console.log(`📊 Checking roles for ${tenants.length} tenant(s)...\n`);

    // Check NON-MEMBER and MEMBER roles for each tenant
    for (const tenant of tenants) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Tenant: ${tenant.name} (${tenant.code})`);
      console.log("=".repeat(60));

      // Check NON-MEMBER role
      const nonMemberRole = await Role.findOne({
        code: "NON-MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (!nonMemberRole) {
        console.log("❌ NON-MEMBER role not found");
      } else {
        console.log(`\n✅ NON-MEMBER Role: ${nonMemberRole.name}`);
        console.log(`   Permissions: ${nonMemberRole.permissions.length}`);
        const hasPortalCreate = nonMemberRole.permissions.includes("PORTAL_CREATE");
        console.log(`   Has PORTAL_CREATE: ${hasPortalCreate ? "✅ YES" : "❌ NO"}`);
        
        // Show portal-related permissions
        const portalPerms = nonMemberRole.permissions.filter(p => 
          p.includes("PORTAL") || p.includes("portal")
        );
        if (portalPerms.length > 0) {
          console.log(`   Portal permissions: ${portalPerms.join(", ")}`);
        } else {
          console.log(`   Portal permissions: None`);
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
        console.log(`\n✅ MEMBER Role: ${memberRole.name}`);
        console.log(`   Permissions: ${memberRole.permissions.length}`);
        const hasPortalCreate = memberRole.permissions.includes("PORTAL_CREATE");
        console.log(`   Has PORTAL_CREATE: ${hasPortalCreate ? "✅ YES" : "❌ NO"}`);
        
        // Show portal-related permissions
        const portalPerms = memberRole.permissions.filter(p => 
          p.includes("PORTAL") || p.includes("portal")
        );
        if (portalPerms.length > 0) {
          console.log(`   Portal permissions: ${portalPerms.join(", ")}`);
        } else {
          console.log(`   Portal permissions: None`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY");
    console.log("=".repeat(60));
    console.log(`Portal permissions in database: ${portalPermissions.length}`);
    console.log(`Tenants checked: ${tenants.length}`);
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

// Run the script
checkPortalPermissions()
  .then(() => {
    console.log("\n✅ Diagnostic completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Diagnostic failed:", error.message);
    process.exit(1);
  });

