#!/usr/bin/env node
/**
 * Cleanup script for staging database
 * This script will:
 * 1. Remove all roles and permissions from existing users (without deleting users)
 * 2. Delete all roles
 * 3. Delete all permissions
 * 4. Delete all tenants
 * 5. Prepare database for fresh migration
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const Tenant = require("../models/tenant.model");

async function connectDB() {
  try {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error(
        "MONGO_URI environment variable is not set in .env.staging"
      );
    }

    console.log("🔗 Connecting to staging MongoDB Atlas...");
    console.log("   Database:", mongoUri.split("/")[3].split("?")[0]);

    await mongoose.connect(mongoUri);
    console.log("✓ Connected to staging MongoDB Atlas");
  } catch (error) {
    console.error("✗ Staging MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function showCurrentState() {
  console.log("\n📊 Current Staging Database State:");

  const userCount = await User.countDocuments();
  const roleCount = await Role.countDocuments();
  const permissionCount = await Permission.countDocuments();
  const tenantCount = await Tenant.countDocuments();

  console.log(`  • Users: ${userCount}`);
  console.log(`  • Roles: ${roleCount}`);
  console.log(`  • Permissions: ${permissionCount}`);
  console.log(`  • Tenants: ${tenantCount}`);

  // Show users with roles
  const usersWithRoles = await User.find({ roles: { $exists: true, $ne: [] } })
    .populate("roles", "name code")
    .select("userEmail userFirstName userLastName roles");

  if (usersWithRoles.length > 0) {
    console.log(`\n  👤 Users with roles (${usersWithRoles.length}):`);
    usersWithRoles.slice(0, 5).forEach((user) => {
      const email = user.userEmail || "No email";
      const name = user.userFirstName || user.userLastName || "No name";
      const roleNames = user.roles.map((role) => role.name).join(", ");
      console.log(`    - ${email} (${name}): ${roleNames}`);
    });
    if (usersWithRoles.length > 5) {
      console.log(`    ... and ${usersWithRoles.length - 5} more users`);
    }
  }

  return { userCount, roleCount, permissionCount, tenantCount, usersWithRoles };
}

async function cleanupUserRoles() {
  console.log("\n👤 Cleaning up user roles and permissions...");

  try {
    // Find all users with roles
    const usersWithRoles = await User.find({
      roles: { $exists: true, $ne: [] },
    }).populate("roles", "name code");

    if (usersWithRoles.length === 0) {
      console.log("  ℹ️  No users with roles found, skipping...");
      return;
    }

    console.log(`  📊 Found ${usersWithRoles.length} users with roles`);

    // Remove roles from all users
    const result = await User.updateMany(
      { roles: { $exists: true, $ne: [] } },
      {
        $set: {
          roles: [],
          updatedAt: new Date(),
          updatedBy: "staging-cleanup-script",
        },
      }
    );

    console.log(`  ✅ Removed roles from ${result.modifiedCount} users`);

    // Show sample of cleaned users
    usersWithRoles.slice(0, 3).forEach((user) => {
      const email = user.userEmail || "No email";
      const roleNames = user.roles.map((role) => role.name).join(", ");
      console.log(`    - ${email}: removed roles [${roleNames}]`);
    });

    return result.modifiedCount;
  } catch (error) {
    console.error("  ✗ Failed to cleanup user roles:", error.message);
    throw error;
  }
}

async function cleanupRoles() {
  console.log("\n👥 Cleaning up roles...");

  try {
    const roleCount = await Role.countDocuments();

    if (roleCount === 0) {
      console.log("  ℹ️  No roles found, skipping...");
      return;
    }

    console.log(`  📊 Found ${roleCount} roles to delete`);

    // Show sample roles before deletion
    const sampleRoles = await Role.find({})
      .limit(5)
      .select("name code userType")
      .populate("tenantId", "name");

    sampleRoles.forEach((role) => {
      const tenantName = role.tenantId?.name || "No tenant";
      console.log(`    - ${role.name} (${role.code}) - ${tenantName}`);
    });

    // Delete all roles
    const result = await Role.deleteMany({});

    console.log(`  ✅ Deleted ${result.deletedCount} roles`);

    return result.deletedCount;
  } catch (error) {
    console.error("  ✗ Failed to cleanup roles:", error.message);
    throw error;
  }
}

async function cleanupPermissions() {
  console.log("\n🔐 Cleaning up permissions...");

  try {
    const permissionCount = await Permission.countDocuments();

    if (permissionCount === 0) {
      console.log("  ℹ️  No permissions found, skipping...");
      return;
    }

    console.log(`  📊 Found ${permissionCount} permissions to delete`);

    // Show sample permissions before deletion
    const samplePermissions = await Permission.find({})
      .limit(5)
      .select("name code category");

    samplePermissions.forEach((perm) => {
      console.log(`    - ${perm.name} (${perm.code}) - ${perm.category}`);
    });

    // Delete all permissions
    const result = await Permission.deleteMany({});

    console.log(`  ✅ Deleted ${result.deletedCount} permissions`);

    return result.deletedCount;
  } catch (error) {
    console.error("  ✗ Failed to cleanup permissions:", error.message);
    throw error;
  }
}

async function cleanupTenants() {
  console.log("\n🏢 Cleaning up tenants...");

  try {
    const tenantCount = await Tenant.countDocuments();

    if (tenantCount === 0) {
      console.log("  ℹ️  No tenants found, skipping...");
      return;
    }

    console.log(`  📊 Found ${tenantCount} tenants to delete`);

    // Show sample tenants before deletion
    const sampleTenants = await Tenant.find({})
      .limit(5)
      .select("name code status");

    sampleTenants.forEach((tenant) => {
      console.log(`    - ${tenant.name} (${tenant.code}) - ${tenant.status}`);
    });

    // Delete all tenants
    const result = await Tenant.deleteMany({});

    console.log(`  ✅ Deleted ${result.deletedCount} tenants`);

    return result.deletedCount;
  } catch (error) {
    console.error("  ✗ Failed to cleanup tenants:", error.message);
    throw error;
  }
}

async function verifyCleanup() {
  console.log("\n🔍 Verifying cleanup...");

  const userCount = await User.countDocuments();
  const roleCount = await Role.countDocuments();
  const permissionCount = await Permission.countDocuments();
  const tenantCount = await Tenant.countDocuments();

  console.log("  Final counts:");
  console.log(`    • Users: ${userCount} (preserved)`);
  console.log(`    • Roles: ${roleCount} (should be 0)`);
  console.log(`    • Permissions: ${permissionCount} (should be 0)`);
  console.log(`    • Tenants: ${tenantCount} (should be 0)`);

  // Check if any users still have roles
  const usersWithRoles = await User.countDocuments({
    roles: { $exists: true, $ne: [] },
  });

  if (usersWithRoles === 0) {
    console.log("  ✅ All users have been cleaned of roles");
  } else {
    console.log(`  ⚠️  ${usersWithRoles} users still have roles`);
  }

  const isClean =
    roleCount === 0 &&
    permissionCount === 0 &&
    tenantCount === 0 &&
    usersWithRoles === 0;

  return {
    isClean,
    userCount,
    roleCount,
    permissionCount,
    tenantCount,
    usersWithRoles,
  };
}

async function main() {
  console.log("🧹 Starting STAGING database cleanup...\n");
  console.log("🌐 Environment: STAGING");
  console.log("📅 Date:", new Date().toISOString());
  console.log(
    "⚠️  This will clean roles, permissions, and tenants from staging database"
  );
  console.log("✅ Users will be preserved but their roles will be removed\n");

  try {
    // Connect to staging database
    await connectDB();

    // Show current state
    const initialState = await showCurrentState();

    // Confirm cleanup
    console.log("\n⚠️  WARNING: This will:");
    console.log("   1. Remove all roles from existing users");
    console.log("   2. Delete all roles");
    console.log("   3. Delete all permissions");
    console.log("   4. Delete all tenants");
    console.log("   5. Preserve all users");

    // Perform cleanup
    console.log("\n🚀 Starting cleanup process...");

    // Step 1: Remove roles from users
    const usersModified = await cleanupUserRoles();

    // Step 2: Delete all roles
    const rolesDeleted = await cleanupRoles();

    // Step 3: Delete all permissions
    const permissionsDeleted = await cleanupPermissions();

    // Step 4: Delete all tenants
    const tenantsDeleted = await cleanupTenants();

    // Verify cleanup
    const finalState = await verifyCleanup();

    // Summary
    console.log("\n📋 Cleanup Summary:");
    console.log(`  • Users modified: ${usersModified || 0}`);
    console.log(`  • Roles deleted: ${rolesDeleted || 0}`);
    console.log(`  • Permissions deleted: ${permissionsDeleted || 0}`);
    console.log(`  • Tenants deleted: ${tenantsDeleted || 0}`);
    console.log(`  • Users preserved: ${finalState.userCount}`);

    if (finalState.isClean) {
      console.log("\n✅ STAGING database cleanup completed successfully!");
      console.log("🎯 Database is now ready for fresh migration");
    } else {
      console.log(
        "\n⚠️  Cleanup completed with warnings - some data may remain"
      );
    }
  } catch (error) {
    console.error("\n❌ STAGING database cleanup failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from staging MongoDB Atlas");
  }
}

// Run cleanup if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = {
  main,
  cleanupUserRoles,
  cleanupRoles,
  cleanupPermissions,
  cleanupTenants,
  verifyCleanup,
};
