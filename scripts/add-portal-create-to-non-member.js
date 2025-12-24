#!/usr/bin/env node

/**
 * Script to add PORTAL_CREATE permission to NON-MEMBER role
 * This allows non-member portal users to create applications
 *
 * Usage: NODE_ENV=staging node scripts/add-portal-create-to-non-member.js
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

async function addPortalCreateToNonMember() {
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
    console.log("✅ Connected to MongoDB");

    // Find PORTAL_CREATE permission
    console.log("\n📋 Looking for PORTAL_CREATE permission...");
    const portalCreatePermission = await Permission.findOne({
      code: "PORTAL_CREATE",
      isActive: true,
    });

    if (!portalCreatePermission) {
      console.error("❌ PORTAL_CREATE permission not found in database!");
      console.log(
        "💡 Please run insert-portal-permissions.js first to create portal permissions"
      );
      process.exit(1);
    }

    console.log(
      `✅ Found PORTAL_CREATE permission: ${portalCreatePermission.name}`
    );

    // Get all tenants (or use a specific tenant)
    const Tenant = require("../models/tenant.model");
    const tenants = await Tenant.find({ isActive: true });

    if (tenants.length === 0) {
      console.error("❌ No active tenants found!");
      process.exit(1);
    }

    console.log(`\n📊 Found ${tenants.length} tenant(s)`);

    let totalUpdated = 0;
    let totalSkipped = 0;

    // Update NON-MEMBER role for each tenant
    for (const tenant of tenants) {
      console.log(`\n🔍 Processing tenant: ${tenant.name} (${tenant.code})`);

      // Find NON-MEMBER role for this tenant
      const nonMemberRole = await Role.findOne({
        code: "NON-MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (!nonMemberRole) {
        console.log(
          `⚠️  NON-MEMBER role not found for tenant ${tenant.name}, skipping...`
        );
        totalSkipped++;
        continue;
      }

      console.log(`✅ Found NON-MEMBER role: ${nonMemberRole.name}`);

      // Check if permission already exists
      if (nonMemberRole.permissions.includes("PORTAL_CREATE")) {
        console.log(
          `⏭️  NON-MEMBER role already has PORTAL_CREATE permission, skipping...`
        );
        totalSkipped++;
        continue;
      }

      // Add PORTAL_CREATE permission
      const currentPermissions = nonMemberRole.permissions || [];
      nonMemberRole.permissions = [...currentPermissions, "PORTAL_CREATE"];
      nonMemberRole.updatedBy = "add-portal-create-script";
      await nonMemberRole.save();

      console.log(`✅ Added PORTAL_CREATE permission to NON-MEMBER role`);
      console.log(`   Previous permissions: ${currentPermissions.length}`);
      console.log(`   New permissions: ${nonMemberRole.permissions.length}`);

      totalUpdated++;
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY");
    console.log("=".repeat(60));
    console.log(`Tenants processed: ${tenants.length}`);
    console.log(`NON-MEMBER roles updated: ${totalUpdated}`);
    console.log(
      `Skipped (already has permission or role not found): ${totalSkipped}`
    );
    console.log("=".repeat(60));

    if (totalUpdated > 0) {
      console.log(
        "\n✅ Successfully added PORTAL_CREATE permission to NON-MEMBER roles!"
      );
      console.log("🎯 Non-member portal users can now create applications");
    } else {
      console.log(
        "\n⚠️  No roles were updated. All NON-MEMBER roles may already have PORTAL_CREATE permission."
      );
    }
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
addPortalCreateToNonMember()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error.message);
    process.exit(1);
  });
