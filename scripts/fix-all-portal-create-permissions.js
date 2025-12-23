#!/usr/bin/env node

/**
 * Comprehensive script to ensure PORTAL_CREATE permission is properly configured
 * - Adds PORTAL_CREATE to NON-MEMBER role if missing
 * - Adds PORTAL_CREATE to MEMBER role if missing
 * - Verifies permission structure
 * 
 * Usage: NODE_ENV=staging node scripts/fix-all-portal-create-permissions.js
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

async function fixAllPortalCreatePermissions() {
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

    // Verify PORTAL_CREATE permission exists
    console.log("=".repeat(60));
    console.log("STEP 1: Verifying PORTAL_CREATE Permission");
    console.log("=".repeat(60));
    
    const portalCreatePermission = await Permission.findOne({
      code: "PORTAL_CREATE",
      isActive: true,
    });

    if (!portalCreatePermission) {
      console.error("❌ PORTAL_CREATE permission not found in database!");
      console.log("💡 Please run insert-portal-permissions.js first to create portal permissions");
      process.exit(1);
    }

    console.log("✅ PORTAL_CREATE permission exists:");
    console.log(`   Code: ${portalCreatePermission.code}`);
    console.log(`   Resource: ${portalCreatePermission.resource}`);
    console.log(`   Action: ${portalCreatePermission.action}\n`);

    // Get all tenants
    const Tenant = require("../models/tenant.model");
    const tenants = await Tenant.find({ isActive: true });
    
    if (tenants.length === 0) {
      console.error("❌ No active tenants found!");
      process.exit(1);
    }

    console.log("=".repeat(60));
    console.log("STEP 2: Updating Roles");
    console.log("=".repeat(60));
    console.log(`Found ${tenants.length} tenant(s)\n`);

    let nonMemberUpdated = 0;
    let memberUpdated = 0;
    let nonMemberSkipped = 0;
    let memberSkipped = 0;

    // Update roles for each tenant
    for (const tenant of tenants) {
      console.log(`📊 Tenant: ${tenant.name} (${tenant.code})`);

      // Update NON-MEMBER role
      const nonMemberRole = await Role.findOne({
        code: "NON-MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (nonMemberRole) {
        if (!nonMemberRole.permissions.includes("PORTAL_CREATE")) {
          nonMemberRole.permissions = [...nonMemberRole.permissions, "PORTAL_CREATE"];
          nonMemberRole.updatedBy = "fix-portal-create-script";
          await nonMemberRole.save();
          console.log(`   ✅ Added PORTAL_CREATE to NON-MEMBER`);
          nonMemberUpdated++;
        } else {
          console.log(`   ⏭️  NON-MEMBER already has PORTAL_CREATE`);
          nonMemberSkipped++;
        }
      } else {
        console.log(`   ⚠️  NON-MEMBER role not found`);
      }

      // Update MEMBER role
      const memberRole = await Role.findOne({
        code: "MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (memberRole) {
        if (!memberRole.permissions.includes("PORTAL_CREATE")) {
          memberRole.permissions = [...memberRole.permissions, "PORTAL_CREATE"];
          memberRole.updatedBy = "fix-portal-create-script";
          await memberRole.save();
          console.log(`   ✅ Added PORTAL_CREATE to MEMBER`);
          memberUpdated++;
        } else {
          console.log(`   ⏭️  MEMBER already has PORTAL_CREATE`);
          memberSkipped++;
        }
      } else {
        console.log(`   ⚠️  MEMBER role not found`);
      }
      console.log();
    }

    // Summary
    console.log("=".repeat(60));
    console.log("📊 SUMMARY");
    console.log("=".repeat(60));
    console.log(`Tenants processed: ${tenants.length}`);
    console.log(`\nNON-MEMBER Role:`);
    console.log(`   Updated: ${nonMemberUpdated}`);
    console.log(`   Already had permission: ${nonMemberSkipped}`);
    console.log(`\nMEMBER Role:`);
    console.log(`   Updated: ${memberUpdated}`);
    console.log(`   Already had permission: ${memberSkipped}`);
    console.log("=".repeat(60));

    if (nonMemberUpdated > 0 || memberUpdated > 0) {
      console.log("\n✅ Successfully updated roles!");
      console.log("\n⚠️  IMPORTANT: Users need to refresh their tokens to get updated permissions:");
      console.log("   - Logout and login again");
      console.log("   - Or call /auth/refresh-token endpoint");
    } else {
      console.log("\n✅ All roles already have PORTAL_CREATE permission!");
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
fixAllPortalCreatePermissions()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error.message);
    process.exit(1);
  });

