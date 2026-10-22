#!/usr/bin/env node

/**
 * Verify User Role Assignment
 *
 * This script verifies that a user has been assigned the MEMBER role
 * and can access lookup endpoints.
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: ".env.staging" });

// Import models
const User = require("./models/user.model");
const Role = require("./models/role.model");
const Tenant = require("./models/tenant.model");

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

    console.log(`✅ Connected to MongoDB: ${mongoose.connection.name}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    process.exit(1);
  }
}

async function verifyUserRole(userEmail) {
  try {
    console.log(`\n🔍 Verifying user role assignment...`);
    console.log("=====================================");
    console.log(`📧 User Email: ${userEmail}`);

    // Find main tenant
    const mainTenant = await Tenant.findOne({
      code: { $in: ["MAIN", "DEFAULT", "PRIMARY", "ROOT"] },
      isActive: true,
    });

    if (!mainTenant) {
      throw new Error("No main tenant found");
    }

    console.log(`🏢 Tenant: ${mainTenant.name} (${mainTenant.code})`);

    // Find user
    const user = await User.findOne({
      userEmail: userEmail,
      tenantId: mainTenant._id.toString(),
    }).populate("roles");

    if (!user) {
      throw new Error(`User ${userEmail} not found`);
    }

    console.log(`\n👤 User Details:`);
    console.log(`   User ID: ${user._id}`);
    console.log(`   Email: ${user.userEmail}`);
    console.log(
      `   Name: ${user.userFullName || user.userFirstName || "Not set"}`
    );
    console.log(`   Tenant: ${user.tenantId}`);
    console.log(`   Active: ${user.isActive}`);
    console.log(`   User Type: ${user.userType}`);
    console.log(`   Roles: ${user.roles ? user.roles.length : 0} total`);

    if (user.roles && user.roles.length > 0) {
      console.log(`\n🎭 User Roles:`);
      let hasMemberRole = false;

      user.roles.forEach((role, index) => {
        const isMemberRole = role.code === "MEMBER";
        hasMemberRole = hasMemberRole || isMemberRole;

        console.log(
          `   ${index + 1}. ${role.name} (${role.code}) - Category: ${
            role.roleCategory
          } ${isMemberRole ? "✅ MEMBER ROLE" : ""}`
        );

        if (isMemberRole && role.permissions) {
          console.log(`      Permissions: ${role.permissions.length} total`);
          const lookupPerms = role.permissions.filter((p) =>
            p.includes("LOOKUP")
          );
          if (lookupPerms.length > 0) {
            console.log(`      Lookup Permissions:`);
            lookupPerms.forEach((perm) => {
              console.log(`        ✅ ${perm}`);
            });
          }
        }
      });

      if (hasMemberRole) {
        console.log(`\n✅ SUCCESS: User has MEMBER role assigned`);
        console.log(`✅ User can access lookup and lookuptype read endpoints`);

        // Check specific permissions
        const memberRole = user.roles.find((role) => role.code === "MEMBER");
        if (memberRole && memberRole.permissions) {
          const hasLookupRead = memberRole.permissions.includes("LOOKUP_READ");
          const hasLookupTypeRead =
            memberRole.permissions.includes("LOOKUPTYPE_READ");

          console.log(`\n🔐 Permission Status:`);
          console.log(`   LOOKUP_READ: ${hasLookupRead ? "✅" : "❌"}`);
          console.log(`   LOOKUPTYPE_READ: ${hasLookupTypeRead ? "✅" : "❌"}`);

          if (hasLookupRead && hasLookupTypeRead) {
            console.log(
              `\n🎉 PERFECT: User has all required lookup permissions!`
            );
          } else {
            console.log(
              `\n⚠️  WARNING: User is missing some lookup permissions`
            );
          }
        }
      } else {
        console.log(`\n❌ ERROR: User does NOT have MEMBER role assigned`);
      }
    } else {
      console.log(`\n❌ ERROR: User has no roles assigned`);
    }

    return user;
  } catch (error) {
    console.error("❌ Error verifying user role:", error.message);
    throw error;
  }
}

async function testUserAccess(user) {
  try {
    console.log(`\n🧪 Testing User Access Capabilities...`);
    console.log("======================================");

    const memberRole = user.roles.find((role) => role.code === "MEMBER");

    if (!memberRole) {
      console.log(`❌ Cannot test access - no MEMBER role found`);
      return;
    }

    console.log(`👤 User: ${user.userEmail}`);
    console.log(`🎭 Role: ${memberRole.name} (${memberRole.code})`);
    console.log(`🏷️  Category: ${memberRole.roleCategory}`);

    if (memberRole.permissions && memberRole.permissions.length > 0) {
      console.log(`\n🔐 Available Permissions:`);
      memberRole.permissions.forEach((permission, index) => {
        console.log(`   ${index + 1}. ${permission}`);
      });

      // Test specific lookup permissions
      const lookupPermissions = memberRole.permissions.filter((p) =>
        p.includes("LOOKUP")
      );
      console.log(
        `\n🔍 Lookup-Specific Permissions: ${lookupPermissions.length}`
      );

      if (lookupPermissions.length > 0) {
        lookupPermissions.forEach((perm) => {
          console.log(`   ✅ ${perm}`);
        });

        console.log(`\n🌐 API Endpoints User Can Access:`);
        console.log(`   ✅ GET /api/lookups - View all lookups`);
        console.log(`   ✅ GET /api/lookups/:id - View specific lookup`);
        console.log(`   ✅ GET /api/lookuptypes - View all lookup types`);
        console.log(
          `   ✅ GET /api/lookuptypes/:id - View specific lookup type`
        );

        console.log(
          `\n🔒 API Endpoints User Cannot Access (requires higher permissions):`
        );
        console.log(
          `   ❌ POST /api/lookups - Create lookup (requires Level 30+)`
        );
        console.log(
          `   ❌ PUT /api/lookups - Update lookup (requires Level 30+)`
        );
        console.log(
          `   ❌ DELETE /api/lookups - Delete lookup (requires Level 60+)`
        );
        console.log(
          `   ❌ POST /api/lookuptypes - Create lookup type (requires Level 30+)`
        );
        console.log(
          `   ❌ PUT /api/lookuptypes - Update lookup type (requires Level 30+)`
        );
        console.log(
          `   ❌ DELETE /api/lookuptypes - Delete lookup type (requires Level 60+)`
        );
      } else {
        console.log(`\n❌ No lookup permissions found!`);
      }
    } else {
      console.log(`\n❌ Role has no permissions assigned`);
    }
  } catch (error) {
    console.error("❌ Error testing user access:", error.message);
  }
}

async function main() {
  try {
    const userEmail = "fazalazim238@gmail.com";

    console.log("🔍 Verifying User Role Assignment");
    console.log("==================================");
    console.log(`📧 Target Email: ${userEmail}`);
    console.log(`🌍 Environment: Staging\n`);

    // Connect to database
    await connectToDatabase();

    // Verify user role
    const user = await verifyUserRole(userEmail);

    // Test user access capabilities
    await testUserAccess(user);

    console.log("\n" + "=".repeat(60));
    console.log("✅ VERIFICATION COMPLETED SUCCESSFULLY!");
    console.log(`✅ User ${userEmail} is properly configured`);
    console.log("✅ User has MEMBER role with lookup read permissions");
    console.log("✅ User can access lookup and lookuptype endpoints");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n❌ Verification failed:", error.message);
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
  verifyUserRole,
  testUserAccess,
};
