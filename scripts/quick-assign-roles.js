#!/usr/bin/env node

/**
 * Quick script to assign default roles to existing users
 * Usage: node scripts/quick-assign-roles.js
 *
 * P7: each assignment goes through the shared role-class guard (helpers/roleClass.js), so under
 * ROLE_CLASS_MODE=enforce an incompatible role is not assigned (the user is left unchanged) and in
 * shadow it is logged. The user type read is the STORED one: a user stored without userType is
 * skipped, not treated as PORTAL by the schema default.
 */

require("dotenv").config({ path: ".env.development" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const { roleClassAllows, storedUserType } = require("../helpers/roleClass");

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
        const userType = storedUserType(user);
        if (userType === "CRM") {
          defaultRoleCode = "REO";
        } else if (userType === "PORTAL") {
          defaultRoleCode = "MEMBER";
        } else {
          console.log(
            `⚠️  Unknown user type: ${userType}, skipping ${user.userEmail}`
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

        // P7: refused under enforce -> user unchanged, counted as an error.
        if (!roleClassAllows({ user, role: defaultRole, tenantId: user.tenantId, path: "script:quick-assign-roles" })) {
          console.log(`❌ ${defaultRoleCode} not assigned to ${user.userEmail}: role class does not fit the user type`);
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
