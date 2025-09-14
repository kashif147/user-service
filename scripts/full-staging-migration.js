#!/usr/bin/env node
/**
 * Complete staging migration script
 * This script will:
 * 1. Clean up existing staging database (roles, permissions, tenants)
 * 2. Preserve users but remove their roles
 * 3. Run fresh migration with new data
 */

require("dotenv").config({ path: ".env.staging" });

const cleanupScript = require("./cleanup-staging-db");
const migrationScript = require("./migrate-constants-to-staging");

async function main() {
  console.log("🚀 Starting COMPLETE STAGING migration process...\n");
  console.log("🌐 Environment: STAGING");
  console.log("📅 Date:", new Date().toISOString());
  console.log("🔄 Process: Cleanup → Migration");

  try {
    // Step 1: Cleanup existing data
    console.log("\n" + "=".repeat(60));
    console.log("STEP 1: CLEANUP EXISTING STAGING DATA");
    console.log("=".repeat(60));

    await cleanupScript.main();

    // Step 2: Run fresh migration
    console.log("\n" + "=".repeat(60));
    console.log("STEP 2: MIGRATE FRESH DATA TO STAGING");
    console.log("=".repeat(60));

    await migrationScript.main();

    // Final summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 COMPLETE STAGING MIGRATION SUCCESSFUL!");
    console.log("=".repeat(60));
    console.log("✅ Cleanup: Completed");
    console.log("✅ Migration: Completed");
    console.log("🎯 Staging environment is ready with fresh data");
  } catch (error) {
    console.error("\n" + "=".repeat(60));
    console.error("❌ COMPLETE STAGING MIGRATION FAILED!");
    console.error("=".repeat(60));
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (require.main === module) {
  main();
}

module.exports = { main };
