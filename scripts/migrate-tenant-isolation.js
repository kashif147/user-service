const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const User = require("../models/user.model");
const Role = require("../models/role.model");

/**
 * Migration script to add tenantId to existing data
 * This script should be run once to migrate existing data to the new tenant-aware schema
 */
async function migrateToTenantIsolation(defaultTenantId) {
  try {
    if (!defaultTenantId) {
      throw new Error("Default tenantId is required for migration");
    }

    console.log(
      `🚀 Starting migration to tenant isolation with default tenant: ${defaultTenantId}`
    );

    // Connection options
    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(process.env.MONGO_URI, options);
    console.log("✅ Connected to MongoDB");

    // Step 1: Migrate Users
    console.log("\n👤 Migrating Users...");
    const usersWithoutTenant = await User.find({
      tenantId: { $exists: false },
    });
    console.log(`Found ${usersWithoutTenant.length} users without tenantId`);

    if (usersWithoutTenant.length > 0) {
      const userUpdateResult = await User.updateMany(
        { tenantId: { $exists: false } },
        {
          $set: {
            tenantId: defaultTenantId,
            createdBy: "migration-script",
            updatedBy: "migration-script",
          },
        }
      );
      console.log(
        `✅ Updated ${userUpdateResult.modifiedCount} users with tenantId`
      );
    }

    // Step 2: Migrate Roles
    console.log("\n👥 Migrating Roles...");
    const rolesWithoutTenant = await Role.find({
      tenantId: { $exists: false },
    });
    console.log(`Found ${rolesWithoutTenant.length} roles without tenantId`);

    if (rolesWithoutTenant.length > 0) {
      const roleUpdateResult = await Role.updateMany(
        { tenantId: { $exists: false } },
        {
          $set: {
            tenantId: defaultTenantId,
            createdBy: "migration-script",
            updatedBy: "migration-script",
          },
        }
      );
      console.log(
        `✅ Updated ${roleUpdateResult.modifiedCount} roles with tenantId`
      );
    }

    // Step 3: Create indexes for tenant isolation
    console.log("\n📊 Creating tenant isolation indexes...");

    try {
      // User indexes
      await User.collection.createIndex(
        { tenantId: 1, userEmail: 1 },
        { unique: true }
      );
      // Phase A / A8: identity uniqueness is partial (populated ids only) — never recreate the
      // old non-partial form here (see scripts/migrate-user-identity-partial-indexes.js).
      await User.collection.createIndex(
        { tenantId: 1, userMicrosoftId: 1 },
        { unique: true, name: "tenantId_1_userMicrosoftId_1_partial", partialFilterExpression: { userMicrosoftId: { $gt: "" } } }
      );
      await User.collection.createIndex(
        { tenantId: 1, userSubject: 1 },
        { unique: true, name: "tenantId_1_userSubject_1_partial", partialFilterExpression: { userSubject: { $gt: "" } } }
      );
      console.log("✅ Created user tenant isolation indexes");
    } catch (error) {
      if (error.code === 85) {
        console.log("✅ User indexes already exist");
      } else {
        throw error;
      }
    }

    try {
      // Role indexes
      await Role.collection.createIndex(
        { tenantId: 1, code: 1 },
        { unique: true }
      );
      await Role.collection.createIndex(
        { tenantId: 1, name: 1 },
        { unique: true }
      );
      console.log("✅ Created role tenant isolation indexes");
    } catch (error) {
      if (error.code === 85) {
        console.log("✅ Role indexes already exist");
      } else {
        throw error;
      }
    }

    // Step 4: Verify migration
    console.log("\n🔍 Verifying migration...");
    const usersWithTenant = await User.countDocuments({
      tenantId: defaultTenantId,
    });
    const rolesWithTenant = await Role.countDocuments({
      tenantId: defaultTenantId,
    });
    const usersWithoutTenantAfter = await User.countDocuments({
      tenantId: { $exists: false },
    });
    const rolesWithoutTenantAfter = await Role.countDocuments({
      tenantId: { $exists: false },
    });

    console.log(`✅ Users with tenantId: ${usersWithTenant}`);
    console.log(`✅ Roles with tenantId: ${rolesWithTenant}`);
    console.log(`✅ Users without tenantId: ${usersWithoutTenantAfter}`);
    console.log(`✅ Roles without tenantId: ${rolesWithoutTenantAfter}`);

    if (usersWithoutTenantAfter === 0 && rolesWithoutTenantAfter === 0) {
      console.log("\n🎉 Migration completed successfully!");
      console.log("\nNext steps:");
      console.log("1. Update your application to use tenant-aware queries");
      console.log("2. Configure B2C/Entra to include tenantId in tokens");
      console.log("3. Update API clients to send tenantId in requests");
      console.log("4. Test the tenant isolation implementation");
    } else {
      console.log(
        "\n⚠️ Migration completed with warnings - some records may need manual review"
      );
    }
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

/**
 * Rollback function to remove tenantId from data (use with caution)
 */
async function rollbackTenantIsolation() {
  try {
    console.log("⚠️ Starting rollback of tenant isolation...");
    console.log("This will remove tenantId from all records!");

    // Connection options
    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(process.env.MONGO_URI, options);
    console.log("✅ Connected to MongoDB");

    // Remove tenantId from users
    const userRollbackResult = await User.updateMany(
      { tenantId: { $exists: true } },
      {
        $unset: {
          tenantId: "",
          createdBy: "",
          updatedBy: "",
        },
      }
    );
    console.log(
      `✅ Removed tenantId from ${userRollbackResult.modifiedCount} users`
    );

    // Remove tenantId from roles
    const roleRollbackResult = await Role.updateMany(
      { tenantId: { $exists: true } },
      {
        $unset: {
          tenantId: "",
          createdBy: "",
          updatedBy: "",
        },
      }
    );
    console.log(
      `✅ Removed tenantId from ${roleRollbackResult.modifiedCount} roles`
    );

    console.log("\n🎉 Rollback completed successfully!");
    console.log("⚠️ Note: You may need to recreate indexes manually");
  } catch (error) {
    console.error("❌ Rollback failed:", error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

// Command line interface
const command = process.argv[2];
const tenantId = process.argv[3];

if (command === "migrate") {
  if (!tenantId) {
    console.error(
      "❌ Usage: node migrate-tenant-isolation.js migrate <defaultTenantId>"
    );
    console.error(
      "Example: node migrate-tenant-isolation.js migrate tenant-001"
    );
    process.exit(1);
  }
  migrateToTenantIsolation(tenantId).catch(console.error);
} else if (command === "rollback") {
  console.log("⚠️ Are you sure you want to rollback tenant isolation? (y/N)");
  process.stdin.once("data", (data) => {
    if (data.toString().trim().toLowerCase() === "y") {
      rollbackTenantIsolation().catch(console.error);
    } else {
      console.log("Rollback cancelled");
      process.exit(0);
    }
  });
} else {
  console.error("❌ Usage:");
  console.error(
    "  Migrate: node migrate-tenant-isolation.js migrate <defaultTenantId>"
  );
  console.error("  Rollback: node migrate-tenant-isolation.js rollback");
  console.error("");
  console.error("Examples:");
  console.error("  node migrate-tenant-isolation.js migrate tenant-001");
  console.error("  node migrate-tenant-isolation.js rollback");
  process.exit(1);
}

module.exports = { migrateToTenantIsolation, rollbackTenantIsolation };
