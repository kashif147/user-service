#!/usr/bin/env node

/**
 * Script to assign default roles to existing users
 * - CRM users get "REO" (Read Only) role
 * - PORTAL users get "MEMBER" role
 */

require("dotenv").config({ path: ".env.development" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");

async function connectToDatabase() {
  try {
    const mongoUri =
      process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("MONGO_URI is not set (no built-in default)");
      process.exit(1);
    }

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });

    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    process.exit(1);
  }
}

async function assignDefaultRoles() {
  try {
    console.log("\n🔍 Finding users without roles...");

    // Find users with no roles assigned
    const usersWithoutRoles = await User.find({
      $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }],
    });

    console.log(`📊 Found ${usersWithoutRoles.length} users without roles`);

    if (usersWithoutRoles.length === 0) {
      console.log("✅ All users already have roles assigned");
      return;
    }

    // Group users by tenantId and userType
    const usersByTenantAndType = {};

    usersWithoutRoles.forEach((user) => {
      const key = `${user.tenantId}-${user.userType}`;
      if (!usersByTenantAndType[key]) {
        usersByTenantAndType[key] = [];
      }
      usersByTenantAndType[key].push(user);
    });

    console.log("\n📋 Processing users by tenant and type:");

    let totalProcessed = 0;
    let totalErrors = 0;

    for (const [key, users] of Object.entries(usersByTenantAndType)) {
      const [tenantId, userType] = key.split("-");
      console.log(
        `\n🏢 Tenant: ${tenantId}, Type: ${userType}, Users: ${users.length}`
      );

      // Determine default role code
      let defaultRoleCode;
      if (userType === "CRM") {
        defaultRoleCode = "REO";
      } else if (userType === "PORTAL") {
        defaultRoleCode = "MEMBER";
      } else {
        console.log(`⚠️  Unknown user type: ${userType}, skipping`);
        continue;
      }

      // Find the default role for this tenant
      const defaultRole = await Role.findOne({
        code: defaultRoleCode,
        tenantId: tenantId,
        isActive: true,
      });

      if (!defaultRole) {
        console.log(
          `❌ Default role "${defaultRoleCode}" not found for tenant ${tenantId}`
        );
        console.log(`   Available roles for this tenant:`);
        const availableRoles = await Role.find({
          tenantId: tenantId,
          isActive: true,
        });
        availableRoles.forEach((role) => {
          console.log(`   - ${role.code}: ${role.name} (${role.category})`);
        });
        totalErrors += users.length;
        continue;
      }

      console.log(`✅ Found role: ${defaultRole.name} (${defaultRole.code})`);

      // Assign role to all users in this group
      for (const user of users) {
        try {
          user.roles = [defaultRole._id];
          await user.save();
          console.log(
            `   ✅ Assigned ${defaultRoleCode} role to ${user.userEmail}`
          );
          totalProcessed++;
        } catch (error) {
          console.log(
            `   ❌ Failed to assign role to ${user.userEmail}: ${error.message}`
          );
          totalErrors++;
        }
      }
    }

    console.log("\n📊 Summary:");
    console.log(`✅ Successfully processed: ${totalProcessed} users`);
    console.log(`❌ Errors: ${totalErrors} users`);
  } catch (error) {
    console.error("❌ Error in assignDefaultRoles:", error.message);
    throw error;
  }
}

async function showRoleStatistics() {
  try {
    console.log("\n📈 Role Assignment Statistics:");

    // Count users by type and role status
    const stats = await User.aggregate([
      {
        $group: {
          _id: {
            userType: "$userType",
            tenantId: "$tenantId",
            hasRoles: { $gt: [{ $size: { $ifNull: ["$roles", []] } }, 0] },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.tenantId": 1, "_id.userType": 1, "_id.hasRoles": 1 },
      },
    ]);

    console.log("\nBreakdown by Tenant, User Type, and Role Status:");
    stats.forEach((stat) => {
      const { tenantId, userType, hasRoles } = stat._id;
      const status = hasRoles ? "✅ Has Roles" : "❌ No Roles";
      console.log(
        `   ${tenantId} | ${userType} | ${status}: ${stat.count} users`
      );
    });

    // Show role distribution
    console.log("\nRole Distribution:");
    const roleStats = await User.aggregate([
      { $unwind: { path: "$roles", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "roles",
          localField: "roles",
          foreignField: "_id",
          as: "roleInfo",
        },
      },
      { $unwind: { path: "$roleInfo", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            tenantId: "$tenantId",
            roleCode: "$roleInfo.code",
            roleName: "$roleInfo.name",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.tenantId": 1, "_id.roleCode": 1 } },
    ]);

    roleStats.forEach((stat) => {
      const { tenantId, roleCode, roleName } = stat._id;
      if (roleCode) {
        console.log(
          `   ${tenantId} | ${roleCode} (${roleName}): ${stat.count} users`
        );
      }
    });
  } catch (error) {
    console.error("❌ Error showing statistics:", error.message);
  }
}

async function main() {
  console.log("🚀 Starting Default Role Assignment Script");
  console.log("==========================================");

  try {
    await connectToDatabase();
    await showRoleStatistics();
    await assignDefaultRoles();
    await showRoleStatistics();

    console.log("\n✅ Script completed successfully!");
  } catch (error) {
    console.error("\n❌ Script failed:", error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { assignDefaultRoles, showRoleStatistics };
