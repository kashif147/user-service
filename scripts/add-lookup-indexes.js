#!/usr/bin/env node
/**
 * Add performance indexes to Lookup collection
 * This script will:
 * 1. Add single field indexes on lookuptypeId, Parentlookupid, isdeleted, isactive, userid
 * 2. Add compound indexes for common query patterns
 * 3. Verify all indexes are created successfully
 */

require("dotenv").config();

const mongoose = require("mongoose");
const Lookup = require("../models/lookup.model");

async function connectDB() {
  try {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error("MONGO_URI environment variable is not set");
    }

    console.log("🔗 Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("✓ Connected to MongoDB");
  } catch (error) {
    console.error("✗ MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function checkCurrentIndexes() {
  console.log("\n🔍 Checking current indexes on lookups collection...");

  try {
    const indexes = await Lookup.collection.indexes();
    console.log("  Current indexes:");
    indexes.forEach((index, i) => {
      const keys = Object.keys(index.key)
        .map((key) => `${key}: ${index.key[key]}`)
        .join(", ");
      const unique = index.unique ? " (UNIQUE)" : "";
      const name = index.name ? ` [${index.name}]` : "";
      console.log(`    ${i + 1}. {${keys}}${unique}${name}`);
    });

    return indexes;
  } catch (error) {
    console.error("  ✗ Failed to check indexes:", error.message);
    return [];
  }
}

async function createIndexes() {
  console.log("\n📝 Creating performance indexes...");

  try {
    const collection = Lookup.collection;

    // Single field indexes
    console.log("  Creating single field indexes...");
    
    await collection.createIndex(
      { lookuptypeId: 1 },
      { name: "lookuptypeId_1", background: true }
    );
    console.log("  ✅ Created index: { lookuptypeId: 1 }");

    await collection.createIndex(
      { Parentlookupid: 1 },
      { name: "Parentlookupid_1", background: true }
    );
    console.log("  ✅ Created index: { Parentlookupid: 1 }");

    await collection.createIndex(
      { isdeleted: 1 },
      { name: "isdeleted_1", background: true }
    );
    console.log("  ✅ Created index: { isdeleted: 1 }");

    await collection.createIndex(
      { isactive: 1 },
      { name: "isactive_1", background: true }
    );
    console.log("  ✅ Created index: { isactive: 1 }");

    await collection.createIndex(
      { userid: 1 },
      { name: "userid_1", background: true }
    );
    console.log("  ✅ Created index: { userid: 1 }");

    // Compound indexes for common query patterns
    console.log("  Creating compound indexes...");

    // For getLookupsByTypeWithHierarchy: find({ lookuptypeId, isdeleted: false, isactive: true })
    await collection.createIndex(
      { lookuptypeId: 1, isdeleted: 1, isactive: 1 },
      { name: "lookuptypeId_1_isdeleted_1_isactive_1", background: true }
    );
    console.log("  ✅ Created index: { lookuptypeId: 1, isdeleted: 1, isactive: 1 }");

    // For queries filtering by active status
    await collection.createIndex(
      { isactive: 1, isdeleted: 1 },
      { name: "isactive_1_isdeleted_1", background: true }
    );
    console.log("  ✅ Created index: { isactive: 1, isdeleted: 1 }");

    // For hierarchy queries that need to find children by parent
    await collection.createIndex(
      { Parentlookupid: 1, isdeleted: 1, isactive: 1 },
      { name: "Parentlookupid_1_isdeleted_1_isactive_1", background: true }
    );
    console.log("  ✅ Created index: { Parentlookupid: 1, isdeleted: 1, isactive: 1 }");

    console.log("\n  ✅ All indexes created successfully!");
  } catch (error) {
    if (error.code === 85) {
      // Index already exists with different options
      console.log("  ⚠️  Index already exists with different options:", error.message);
    } else if (error.code === 86) {
      // Index already exists
      console.log("  ℹ️  Index already exists");
    } else {
      console.error("  ✗ Failed to create index:", error.message);
      throw error;
    }
  }
}

async function verifyIndexes() {
  console.log("\n🔍 Verifying indexes...");

  try {
    const stats = await Lookup.collection.stats();
    console.log(`  Collection: ${stats.ns}`);
    console.log(`  Document count: ${stats.count}`);
    console.log(`  Index count: ${stats.nindexes}`);

    const indexes = await Lookup.collection.indexes();
    const expectedIndexes = [
      "lookuptypeId_1",
      "Parentlookupid_1",
      "isdeleted_1",
      "isactive_1",
      "userid_1",
      "lookuptypeId_1_isdeleted_1_isactive_1",
      "isactive_1_isdeleted_1",
      "Parentlookupid_1_isdeleted_1_isactive_1",
    ];

    const existingIndexNames = indexes.map((idx) => idx.name);
    const missingIndexes = expectedIndexes.filter(
      (name) => !existingIndexNames.includes(name)
    );

    if (missingIndexes.length > 0) {
      console.log("  ⚠️  Missing indexes:", missingIndexes.join(", "));
    } else {
      console.log("  ✅ All expected indexes are present");
    }
  } catch (error) {
    console.error("  ✗ Failed to verify indexes:", error.message);
  }
}

async function main() {
  console.log("🔧 Starting lookup index creation...\n");
  console.log("📅 Date:", new Date().toISOString());

  try {
    // Connect to database
    await connectDB();

    // Check current indexes
    await checkCurrentIndexes();

    // Create indexes
    await createIndexes();

    // Verify indexes
    await verifyIndexes();

    // Check final indexes
    console.log("\n🔍 Final index state:");
    await checkCurrentIndexes();

    console.log("\n✅ Lookup indexes created successfully!");
    console.log("🚀 Query performance should be significantly improved");
  } catch (error) {
    console.error("\n❌ Index creation failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

// Run if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = { main };



