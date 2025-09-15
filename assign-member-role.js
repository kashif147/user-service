#!/usr/bin/env node

/**
 * Assign MEMBER Role to User
 *
 * This script assigns the MEMBER role to a specific user
 * in the staging environment.
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: ".env.staging" });

// Import models
const User = require("./models/user");
const Role = require("./models/role");
const Tenant = require("./models/tenant");

async function connectToDatabase() {
  try {
    const mongoUri =
      process.env.MONGO_URI ||
      `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@clusterprojectshell.tptnh8w.mongodb.net/${process.env.MONGO_DB}/?retryWrites=true&w=majority&appName=ClusterProjectShell`;

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });

    console.log(`✅ Connected to MongoDB: ${mongoose.connection.name}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    process.exit(1);
  }
}

async function findUserByEmail(userEmail) {
  try {
    console.log(`\n🔍 Searching for user with email: ${userEmail}`);
    console.log("=============================================");

    // Search for user by email
    const user = await User.findOne({
      email: userEmail,
      isActive: true,
    });

    if (!user) {
      throw new Error(`User with email ${userEmail} not found or inactive`);
    }

    console.log(`✅ Found user: ${user.name || user.email}`);
    console.log(`   User ID: ${user._id}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Active: ${user.isActive}`);
    console.log(
      `   Current Roles: ${user.roles ? user.roles.length : 0} roles`
    );

    if (user.roles && user.roles.length > 0) {
      console.log(`   Existing Roles:`);
      user.roles.forEach((role) => {
        console.log(`     - ${role.name || role} (${role.code || "No code"})`);
      });
    }

    return user;
  } catch (error) {
    console.error("❌ Error finding user:", error.message);
    throw error;
  }
}

async function findMemberRole(tenantId) {
  try {
    console.log(`\n🎯 Searching for MEMBER role in tenant: ${tenantId}`);
    console.log("=============================================");

    const memberRole = await Role.findOne({
      code: "MEMBER",
      tenantId: tenantId,
      isActive: true,
    });

    if (!memberRole) {
      throw new Error("MEMBER role not found or inactive");
    }

    console.log(`✅ Found MEMBER role:`);
    console.log(`   Role ID: ${memberRole._id}`);
    console.log(`   Name: ${memberRole.name}`);
    console.log(`   Code: ${memberRole.code}`);
    console.log(`   Category: ${memberRole.roleCategory}`);
    console.log(`   Tenant: ${memberRole.tenantId}`);
    console.log(`   Active: ${memberRole.isActive}`);
    console.log(`   System Role: ${memberRole.isSystemRole}`);
    console.log(
      `   Permissions: ${
        memberRole.permissions ? memberRole.permissions.length : 0
      } total`
    );

    if (memberRole.permissions && memberRole.permissions.length > 0) {
      console.log(`   Role Permissions:`);
      memberRole.permissions.forEach((permission) => {
        console.log(`     - ${permission}`);
      });
    }

    return memberRole;
  } catch (error) {
    console.error("❌ Error finding MEMBER role:", error.message);
    throw error;
  }
}

async function assignRoleToUser(user, memberRole) {
  try {
    console.log(`\n🔗 Assigning MEMBER role to user...`);
    console.log("====================================");

    // Check if user already has MEMBER role
    const hasMemberRole =
      user.roles &&
      user.roles.some((role) => {
        const roleId = typeof role === "string" ? role : role._id;
        const roleCode = typeof role === "string" ? null : role.code;
        return roleId === memberRole._id.toString() || roleCode === "MEMBER";
      });

    if (hasMemberRole) {
      console.log(`⚠️  User already has MEMBER role assigned`);
      return user;
    }

    // Add MEMBER role to user
    const currentRoles = user.roles || [];
    const updatedRoles = [...currentRoles, memberRole._id];

    user.roles = updatedRoles;
    user.updatedBy = "system";
    user.updatedAt = new Date();

    await user.save();

    console.log(`✅ Successfully assigned MEMBER role to ${user.email}`);
    console.log(`   Total roles now: ${updatedRoles.length}`);

    return user;
  } catch (error) {
    console.error("❌ Error assigning role to user:", error.message);
    throw error;
  }
}

async function verifyRoleAssignment(user, memberRole) {
  try {
    console.log(`\n✅ Verifying role assignment...`);
    console.log("===============================");

    // Fetch updated user with populated roles
    const updatedUser = await User.findById(user._id).populate("roles");

    if (!updatedUser) {
      throw new Error("Could not fetch updated user");
    }

    console.log(`👤 User: ${updatedUser.email}`);
    console.log(
      `   Total Roles: ${updatedUser.roles ? updatedUser.roles.length : 0}`
    );

    if (updatedUser.roles && updatedUser.roles.length > 0) {
      console.log(`   Current Roles:`);
      updatedUser.roles.forEach((role) => {
        const isMemberRole = role._id.toString() === memberRole._id.toString();
        console.log(
          `     ${isMemberRole ? "✅" : "  "} ${role.name} (${role.code}) ${
            isMemberRole ? "- MEMBER ROLE ASSIGNED" : ""
          }`
        );
      });
    }

    // Check if MEMBER role is present
    const hasMemberRole =
      updatedUser.roles &&
      updatedUser.roles.some(
        (role) => role._id.toString() === memberRole._id.toString()
      );

    if (hasMemberRole) {
      console.log(
        `\n🎉 SUCCESS: MEMBER role successfully assigned to ${user.email}`
      );

      // Show permissions this user now has
      if (memberRole.permissions && memberRole.permissions.length > 0) {
        console.log(`\n🔐 User now has access to:`);
        memberRole.permissions.forEach((permission) => {
          if (permission.includes("LOOKUP")) {
            console.log(`   ✅ ${permission}`);
          }
        });
      }
    } else {
      console.log(`\n❌ ERROR: MEMBER role assignment failed`);
    }

    return hasMemberRole;
  } catch (error) {
    console.error("❌ Error verifying role assignment:", error.message);
    return false;
  }
}

async function main() {
  try {
    const userEmail = "fazalazim238@gmail.com";

    console.log("🚀 Assigning MEMBER Role to User");
    console.log("=================================");
    console.log(`📧 Target Email: ${userEmail}`);
    console.log(`🌍 Environment: Staging\n`);

    // Connect to database
    await connectToDatabase();

    // Find main tenant
    const mainTenant = await Tenant.findOne({
      code: { $in: ["MAIN", "DEFAULT", "PRIMARY", "ROOT"] },
      isActive: true,
    });

    if (!mainTenant) {
      throw new Error("No main tenant found");
    }

    console.log(`🏢 Tenant: ${mainTenant.name} (${mainTenant.code})`);
    console.log(`   Tenant ID: ${mainTenant._id}\n`);

    // Find user by email
    const user = await findUserByEmail(userEmail);

    // Find MEMBER role
    const memberRole = await findMemberRole(mainTenant._id.toString());

    // Assign role to user
    await assignRoleToUser(user, memberRole);

    // Verify assignment
    const success = await verifyRoleAssignment(user, memberRole);

    if (success) {
      console.log("\n" + "=".repeat(50));
      console.log("✅ ROLE ASSIGNMENT COMPLETED SUCCESSFULLY!");
      console.log(`✅ User ${userEmail} now has MEMBER role`);
      console.log("✅ User can access lookup and lookuptype read endpoints");
      console.log("=".repeat(50));
    } else {
      console.log("\n" + "=".repeat(50));
      console.log("❌ ROLE ASSIGNMENT FAILED!");
      console.log("=".repeat(50));
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Assignment failed:", error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("\n🔌 Database connection closed");
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  findUserByEmail,
  findMemberRole,
  assignRoleToUser,
  verifyRoleAssignment,
};
