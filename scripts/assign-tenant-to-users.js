#!/usr/bin/env node

/**
 * Script to assign tenant ID to users with undefined/null tenantId
 * and assign Super User (SU) role to all users
 * Usage: node scripts/assign-tenant-to-users.js
 */

require("dotenv").config({ path: ".env.development" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");

const TARGET_TENANT_ID = "39866a06-30bc-4a89-80c6-9dd9357dd453";

async function assignTenantToUsers() {
  try {
    // Connect to database
    const mongoUri = process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // Find users with undefined/null tenantId
    const usersWithoutTenant = await User.find({
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: "" },
        { tenantId: undefined },
      ],
    });

    console.log(
      `📊 Found ${usersWithoutTenant.length} users without tenant ID`
    );

    if (usersWithoutTenant.length === 0) {
      console.log("✅ All users already have tenant IDs assigned!");
      return;
    }

    console.log(`🎯 Assigning tenant ID: ${TARGET_TENANT_ID}`);
    console.log("\n📋 Processing users:");

    let processed = 0;
    let errors = 0;

    for (const user of usersWithoutTenant) {
      try {
        const oldTenantId = user.tenantId || "undefined";
        user.tenantId = TARGET_TENANT_ID;
        await user.save();

        console.log(
          `✅ Updated ${user.userEmail} (${user.userType}): ${oldTenantId} → ${TARGET_TENANT_ID}`
        );
        processed++;
      } catch (error) {
        console.log(`❌ Failed to update ${user.userEmail}: ${error.message}`);
        errors++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`✅ Successfully processed: ${processed} users`);
    console.log(`❌ Errors: ${errors} users`);

    // Now assign SU role to all users
    await assignSuperUserRole();

    // Show updated statistics
    await showTenantStatistics();
  } catch (error) {
    console.error("❌ Script error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

async function assignSuperUserRole() {
  try {
    console.log("\n🔐 Assigning Super User (SU) role to all users...");

    // Find the SU role for the target tenant
    const suRole = await Role.findOne({
      code: "SU",
      tenantId: TARGET_TENANT_ID,
      isActive: true,
    });

    if (!suRole) {
      console.log(
        `❌ Super User role not found for tenant ${TARGET_TENANT_ID}`
      );
      console.log("Available roles for this tenant:");
      const availableRoles = await Role.find({
        tenantId: TARGET_TENANT_ID,
        isActive: true,
      });
      availableRoles.forEach((role) => {
        console.log(`   - ${role.code}: ${role.name} (${role.userType})`);
      });
      return;
    }

    console.log(`✅ Found SU role: ${suRole.name} (${suRole.code})`);

    // Find all users in the target tenant
    const allUsers = await User.find({ tenantId: TARGET_TENANT_ID });
    console.log(
      `📊 Found ${allUsers.length} users in tenant ${TARGET_TENANT_ID}`
    );

    let processed = 0;
    let errors = 0;
    let alreadyHadRole = 0;

    for (const user of allUsers) {
      try {
        // Check if user already has SU role
        const hasSuRole = user.roles.some(
          (roleId) => roleId.toString() === suRole._id.toString()
        );

        if (hasSuRole) {
          console.log(`   ⏭️  ${user.userEmail} already has SU role`);
          alreadyHadRole++;
          continue;
        }

        // Add SU role to user's roles
        user.roles.push(suRole._id);
        await user.save();

        console.log(`   ✅ Assigned SU role to ${user.userEmail}`);
        processed++;
      } catch (error) {
        console.log(
          `   ❌ Failed to assign SU role to ${user.userEmail}: ${error.message}`
        );
        errors++;
      }
    }

    console.log(`\n📊 SU Role Assignment Summary:`);
    console.log(`✅ Successfully assigned: ${processed} users`);
    console.log(`⏭️  Already had SU role: ${alreadyHadRole} users`);
    console.log(`❌ Errors: ${errors} users`);
  } catch (error) {
    console.error("❌ Error in assignSuperUserRole:", error.message);
  }
}

async function showTenantStatistics() {
  try {
    console.log("\n📈 Tenant Assignment Statistics:");

    // Count users by tenantId
    const tenantStats = await User.aggregate([
      {
        $group: {
          _id: {
            tenantId: "$tenantId",
            userType: "$userType",
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.tenantId": 1, "_id.userType": 1 },
      },
    ]);

    console.log("\nBreakdown by Tenant ID and User Type:");
    tenantStats.forEach((stat) => {
      const { tenantId, userType } = stat._id;
      const displayTenantId = tenantId || "undefined/null";
      console.log(`   ${displayTenantId} | ${userType}: ${stat.count} users`);
    });

    // Check for users still without tenantId
    const usersStillWithoutTenant = await User.countDocuments({
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: "" },
        { tenantId: undefined },
      ],
    });

    if (usersStillWithoutTenant > 0) {
      console.log(
        `\n⚠️  Warning: ${usersStillWithoutTenant} users still don't have tenant IDs`
      );
    } else {
      console.log("\n✅ All users now have tenant IDs assigned!");
    }
  } catch (error) {
    console.error("❌ Error showing statistics:", error.message);
  }
}

async function main() {
  console.log("🚀 Starting Tenant & Role Assignment Script");
  console.log("==========================================");
  console.log(`🎯 Target Tenant ID: ${TARGET_TENANT_ID}`);
  console.log(`🔐 Assigning Super User (SU) role to all users`);
  console.log("");

  try {
    await assignTenantToUsers();
    console.log("\n✅ Script completed successfully!");
  } catch (error) {
    console.error("\n❌ Script failed:", error.message);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  assignTenantToUsers,
  assignSuperUserRole,
  showTenantStatistics,
};
