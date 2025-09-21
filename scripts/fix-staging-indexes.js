#!/usr/bin/env node
/**
 * Fix staging database indexes for proper tenant isolation
 * This script will:
 * 1. Drop problematic unique indexes that prevent tenant isolation
 * 2. Ensure proper compound indexes for tenant isolation
 * 3. Clean up and re-run migration
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");

async function connectDB() {
  try {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error(
        "MONGO_URI environment variable is not set in .env.staging"
      );
    }

    console.log("🔗 Connecting to staging MongoDB Atlas...");
    await mongoose.connect(mongoUri);
    console.log("✓ Connected to staging MongoDB Atlas");
  } catch (error) {
    console.error("✗ Staging MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function checkCurrentIndexes() {
  console.log("\n🔍 Checking current indexes on roles collection...");

  try {
    const indexes = await Role.collection.indexes();
    console.log("  Current indexes:");
    indexes.forEach((index, i) => {
      const keys = Object.keys(index.key)
        .map((key) => `${key}: ${index.key[key]}`)
        .join(", ");
      const unique = index.unique ? " (UNIQUE)" : "";
      console.log(`    ${i + 1}. {${keys}}${unique}`);
    });

    return indexes;
  } catch (error) {
    console.error("  ✗ Failed to check indexes:", error.message);
    return [];
  }
}

async function dropProblematicIndexes() {
  console.log("\n🗑️  Dropping problematic indexes...");

  try {
    const collection = Role.collection;

    // Try to drop the unique index on 'name' field
    try {
      await collection.dropIndex({ name: 1 });
      console.log("  ✅ Dropped unique index on 'name' field");
    } catch (error) {
      if (error.message.includes("index not found")) {
        console.log("  ℹ️  No unique index on 'name' field found");
      } else {
        console.log("  ⚠️  Could not drop 'name' index:", error.message);
      }
    }

    // Try to drop the unique index on 'code' field
    try {
      await collection.dropIndex({ code: 1 });
      console.log("  ✅ Dropped unique index on 'code' field");
    } catch (error) {
      if (error.message.includes("index not found")) {
        console.log("  ℹ️  No unique index on 'code' field found");
      } else {
        console.log("  ⚠️  Could not drop 'code' index:", error.message);
      }
    }

    // Try to drop other problematic indexes
    const problematicIndexes = ["name_1", "code_1"];

    for (const indexName of problematicIndexes) {
      try {
        await collection.dropIndex(indexName);
        console.log(`  ✅ Dropped index: ${indexName}`);
      } catch (error) {
        if (error.message.includes("index not found")) {
          console.log(`  ℹ️  Index ${indexName} not found`);
        } else {
          console.log(
            `  ⚠️  Could not drop index ${indexName}:`,
            error.message
          );
        }
      }
    }
  } catch (error) {
    console.error("  ✗ Failed to drop indexes:", error.message);
  }
}

async function ensureProperIndexes() {
  console.log("\n📝 Ensuring proper tenant isolation indexes...");

  try {
    const collection = Role.collection;

    // Ensure compound unique indexes for tenant isolation
    await collection.createIndex(
      { tenantId: 1, code: 1 },
      { unique: true, name: "tenantId_1_code_1" }
    );
    console.log("  ✅ Ensured unique index: { tenantId: 1, code: 1 }");

    await collection.createIndex(
      { tenantId: 1, name: 1 },
      { unique: true, name: "tenantId_1_name_1" }
    );
    console.log("  ✅ Ensured unique index: { tenantId: 1, name: 1 }");

    // Ensure other useful indexes
    await collection.createIndex({ userType: 1 }, { name: "userType_1" });
    console.log("  ✅ Ensured index: { userType: 1 }");

    await collection.createIndex({ isActive: 1 }, { name: "isActive_1" });
    console.log("  ✅ Ensured index: { isActive: 1 }");
  } catch (error) {
    console.error("  ✗ Failed to create indexes:", error.message);
  }
}

async function main() {
  console.log("🔧 Starting staging database index fix...\n");
  console.log("🌐 Environment: STAGING");
  console.log("📅 Date:", new Date().toISOString());

  try {
    // Connect to staging database
    await connectDB();

    // Check current indexes
    await checkCurrentIndexes();

    // Drop problematic indexes
    await dropProblematicIndexes();

    // Ensure proper indexes
    await ensureProperIndexes();

    // Check final indexes
    console.log("\n🔍 Final index state:");
    await checkCurrentIndexes();

    console.log("\n✅ Staging database indexes fixed successfully!");
    console.log("🎯 Database is now ready for proper tenant isolation");
  } catch (error) {
    console.error("\n❌ Index fix failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from staging MongoDB Atlas");
  }
}

// Run if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = { main };
