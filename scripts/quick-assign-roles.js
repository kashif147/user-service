#!/usr/bin/env node

/**
 * Quick script to assign default roles to existing users
 * Usage: node scripts/quick-assign-roles.js
 */

require("dotenv").config({ path: ".env.development" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");

async function quickAssignRoles() {
  try {
    // Connect to database
    const mongoUri = process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // Find users without roles
    const usersWithoutRoles = await User.find({
      $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }],
    });

    console.log(`📊 Found ${usersWithoutRoles.length} users without roles`);

    if (usersWithoutRoles.length === 0) {
      console.log("✅ All users already have roles!");
      return;
    }

    let processed = 0;
    let errors = 0;

    for (const user of usersWithoutRoles) {
      try {
        // Determine default role code
        let defaultRoleCode;
        if (user.userType === "CRM") {
          defaultRoleCode = "REO";
        } else if (user.userType === "PORTAL") {
          defaultRoleCode = "MEMBER";
        } else {
          console.log(
            `⚠️  Unknown user type: ${user.userType}, skipping ${user.userEmail}`
          );
          continue;
        }

        // Find the default role for this tenant
        const defaultRole = await Role.findOne({
          code: defaultRoleCode,
          tenantId: user.tenantId,
          isActive: true,
        });

        if (!defaultRole) {
          console.log(
            `❌ Role "${defaultRoleCode}" not found for tenant ${user.tenantId}`
          );
          errors++;
          continue;
        }

        // Assign role
        user.roles = [defaultRole._id];
        await user.save();

        console.log(
          `✅ Assigned ${defaultRoleCode} to ${user.userEmail} (${user.userType})`
        );
        processed++;
      } catch (error) {
        console.log(`❌ Error with ${user.userEmail}: ${error.message}`);
        errors++;
      }
    }

    console.log(`\n📊 Summary: ${processed} processed, ${errors} errors`);
  } catch (error) {
    console.error("❌ Script error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected");
  }
}

quickAssignRoles();
