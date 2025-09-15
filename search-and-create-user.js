#!/usr/bin/env node

/**
 * Search for User and Create if Needed
 *
 * This script searches for a user by email and creates the user
 * with MEMBER role if they don't exist.
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

async function searchForUser(userEmail, tenantId) {
  try {
    console.log(`\n🔍 Searching for user with email: ${userEmail}`);
    console.log("=============================================");

    // Search for user by email (including inactive)
    const user = await User.findOne({
      userEmail: userEmail,
      tenantId: tenantId,
    });

    if (user) {
      console.log(`✅ Found user:`);
      console.log(`   User ID: ${user._id}`);
      console.log(
        `   Name: ${user.userFullName || user.userFirstName || "Not set"}`
      );
      console.log(`   Email: ${user.userEmail}`);
      console.log(`   Tenant: ${user.tenantId}`);
      console.log(`   Active: ${user.isActive}`);
      console.log(`   Roles: ${user.roles ? user.roles.length : 0} roles`);

      if (user.roles && user.roles.length > 0) {
        console.log(`   Current Roles:`);
        user.roles.forEach((role) => {
          console.log(
            `     - ${typeof role === "string" ? role : role.name || role.code}`
          );
        });
      }

      return user;
    } else {
      console.log(
        `❌ User with email ${userEmail} not found in tenant ${tenantId}`
      );
      return null;
    }
  } catch (error) {
    console.error("❌ Error searching for user:", error.message);
    throw error;
  }
}

async function listAllUsers(tenantId) {
  try {
    console.log(`\n📋 Listing all users in staging database...`);
    console.log("=============================================");

    const users = await User.find({ tenantId: tenantId }).select(
      "userEmail userFullName userFirstName isActive roles createdAt"
    );

    if (users.length === 0) {
      console.log("❌ No users found in database for this tenant");
      return;
    }

    console.log(`✅ Found ${users.length} users:`);
    users.forEach((user, index) => {
      const name = user.userFullName || user.userFirstName || "No name";
      console.log(
        `   ${index + 1}. ${user.userEmail} (${name}) - Active: ${
          user.isActive
        } - Roles: ${user.roles ? user.roles.length : 0}`
      );
    });

    return users;
  } catch (error) {
    console.error("❌ Error listing users:", error.message);
    throw error;
  }
}

async function findMemberRole(tenantId) {
  try {
    console.log(`\n🎯 Searching for MEMBER role...`);
    console.log("===============================");

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
    console.log(
      `   Permissions: ${
        memberRole.permissions ? memberRole.permissions.length : 0
      } total`
    );

    return memberRole;
  } catch (error) {
    console.error("❌ Error finding MEMBER role:", error.message);
    throw error;
  }
}

async function createUser(userEmail, memberRole, tenantId) {
  try {
    console.log(`\n👤 Creating new user: ${userEmail}`);
    console.log("===================================");

    const emailPrefix = userEmail.split("@")[0];

    const newUser = await User.create({
      tenantId: tenantId,
      userEmail: userEmail,
      userFirstName: emailPrefix,
      userFullName: emailPrefix,
      userType: "PORTAL",
      roles: [memberRole._id],
      isActive: true,
      createdBy: "system",
      updatedBy: "system",
    });

    console.log(`✅ User created successfully:`);
    console.log(`   User ID: ${newUser._id}`);
    console.log(`   Email: ${newUser.userEmail}`);
    console.log(`   Name: ${newUser.userFullName}`);
    console.log(`   Tenant: ${newUser.tenantId}`);
    console.log(`   Active: ${newUser.isActive}`);
    console.log(`   Roles: ${newUser.roles.length} (MEMBER)`);

    return newUser;
  } catch (error) {
    console.error("❌ Error creating user:", error.message);
    throw error;
  }
}

async function assignMemberRole(user, memberRole) {
  try {
    console.log(`\n🔗 Assigning MEMBER role to user...`);
    console.log("====================================");

    // Check if user already has MEMBER role
    const hasMemberRole =
      user.roles &&
      user.roles.some((role) => {
        const roleId = typeof role === "string" ? role : role._id;
        return roleId === memberRole._id.toString();
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

    // If user was inactive, activate them
    if (!user.isActive) {
      user.isActive = true;
      console.log(`✅ Activated user account`);
    }

    await user.save();

    console.log(`✅ Successfully assigned MEMBER role to ${user.email}`);
    console.log(`   Total roles now: ${updatedRoles.length}`);

    return user;
  } catch (error) {
    console.error("❌ Error assigning role to user:", error.message);
    throw error;
  }
}

async function main() {
  try {
    const userEmail = "fazalazim238@gmail.com";

    console.log("🚀 User Search and Role Assignment");
    console.log("===================================");
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

    // Search for user
    let user = await searchForUser(userEmail, mainTenant._id.toString());

    // If user not found, list all users
    if (!user) {
      await listAllUsers(mainTenant._id.toString());

      // Find MEMBER role
      const memberRole = await findMemberRole(mainTenant._id.toString());

      // Create new user with MEMBER role
      user = await createUser(userEmail, memberRole, mainTenant._id.toString());
    } else {
      // Find MEMBER role
      const memberRole = await findMemberRole(mainTenant._id.toString());

      // Assign MEMBER role to existing user
      user = await assignMemberRole(user, memberRole);
    }

    console.log("\n" + "=".repeat(50));
    console.log("✅ OPERATION COMPLETED SUCCESSFULLY!");
    console.log(`✅ User ${userEmail} has MEMBER role`);
    console.log("✅ User can access lookup and lookuptype read endpoints");
    console.log("=".repeat(50));
  } catch (error) {
    console.error("\n❌ Operation failed:", error.message);
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
  searchForUser,
  listAllUsers,
  findMemberRole,
  createUser,
  assignMemberRole,
};
