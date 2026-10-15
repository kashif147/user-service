const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const User = require("../models/user.model");

async function removeRolesFromUsers(options = {}) {
  const { dryRun = false, force = false, userType = null } = options;

  try {
    // Build connection string with environment variables
    const mongoUri =
      process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("MONGO_URI is not set (no built-in default)");
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    if (dryRun) {
      console.log("🔍 DRY RUN MODE - No changes will be made");
    }

    // Build query
    let query = {
      roles: { $exists: true, $not: { $size: 0 } },
    };

    if (userType) {
      query.userType = userType;
    }

    console.log("\n📊 Analyzing users with roles...");
    const usersWithRoles = await User.find(query).populate("roles");

    console.log(`Found ${usersWithRoles.length} users with roles`);

    if (usersWithRoles.length === 0) {
      console.log("✅ No users with roles found!");
      return;
    }

    // Show what will be removed
    console.log("\n📋 Removal Plan:");
    usersWithRoles.forEach((user) => {
      const roleCodes = user.roles.map((role) => role.code).join(", ");
      console.log(
        `   - ${user.userEmail} (${user.userType}) → Remove roles: [${roleCodes}]`
      );
    });

    if (dryRun) {
      console.log("\n🔍 DRY RUN COMPLETE - No changes made");
      console.log("Run without --dry-run to execute the removals");
      return;
    }

    // Confirm before proceeding
    if (!force) {
      console.log(
        `\n⚠️  About to remove roles from ${usersWithRoles.length} users.`
      );
      console.log(
        "Add --force flag to skip this confirmation, or Ctrl+C to cancel."
      );
      console.log("Continuing in 5 seconds...");

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Remove roles
    console.log("\n🔄 Removing roles from users...");

    let successCount = 0;
    let errorCount = 0;

    for (const user of usersWithRoles) {
      try {
        user.roles = [];
        await user.save();
        successCount++;
        console.log(`   ✅ Removed roles from ${user.userEmail}`);
      } catch (error) {
        errorCount++;
        console.log(
          `   ❌ Failed to remove roles from ${user.userEmail}: ${error.message}`
        );
      }
    }

    // Summary
    console.log("\n📊 Removal Summary:");
    console.log(`   ✅ Successfully removed roles: ${successCount}`);
    console.log(`   ❌ Failed removals: ${errorCount}`);

    console.log("\n🎉 Role removal completed!");
  } catch (error) {
    console.error("❌ Script failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes("--dry-run"),
  force: args.includes("--force"),
  help: args.includes("--help"),
  userType: null,
};

// Check for user type filter
const userTypeIndex = args.findIndex((arg) => arg === "--user-type");
if (userTypeIndex !== -1 && args[userTypeIndex + 1]) {
  options.userType = args[userTypeIndex + 1];
}

if (options.help) {
  console.log(`
🔄 Role Removal Script

This script removes all roles from users (rollback functionality).

Usage: node scripts/remove-roles.js [options]

Options:
  --dry-run              Show what would be done without making changes
  --force                Skip confirmation prompt
  --user-type PORTAL     Only remove roles from Portal users
  --user-type CRM        Only remove roles from CRM users
  --help                 Show this help message

Examples:
  node scripts/remove-roles.js                    # Remove all roles
  node scripts/remove-roles.js --dry-run          # Preview removals
  node scripts/remove-roles.js --user-type CRM    # Remove only from CRM users
  node scripts/remove-roles.js --force            # Skip confirmation

⚠️  WARNING: This will remove ALL roles from users!
`);
  process.exit(0);
}

removeRolesFromUsers(options);
