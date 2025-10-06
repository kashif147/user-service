/**
 * Migration Script: Add category field to existing roles
 *
 * This script adds the 'category' field to all existing roles that don't have one.
 * It maps roles to categories based on their code and user type.
 */

require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});
const mongoose = require("mongoose");
const Role = require("../models/role.model");

// Role code to category mapping
const ROLE_CATEGORY_MAP = {
  // System roles
  SU: "SYSTEM",
  ASU: "SYSTEM",
  SUPER_USER: "SYSTEM",
  ASSISTANT_SUPER_USER: "SYSTEM",
  SYSTEM_ADMIN: "SYSTEM",

  // Portal roles
  MEMBER: "PORTAL",
  MEMBER_BASIC: "PORTAL",
  MEMBER_PREMIUM: "PORTAL",
  PORTAL_USER: "PORTAL",
  PORTAL_ADMIN: "PORTAL",

  // CRM roles
  CRM_USER: "CRM",
  CRM_ADMIN: "CRM",
  CRM_MANAGER: "CRM",
  CRM_AGENT: "CRM",
  REO: "CRM",
  REGIONAL_EDUCATION_OFFICER: "CRM",
};

async function addCategoryToRoles() {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find all roles without a category
    const rolesWithoutCategory = await Role.find({
      $or: [
        { category: { $exists: false } },
        { category: null },
        { category: "" },
      ],
    });

    console.log(
      `📊 Found ${rolesWithoutCategory.length} roles without category field\n`
    );

    if (rolesWithoutCategory.length === 0) {
      console.log("✅ All roles already have categories assigned");
      process.exit(0);
    }

    let updated = 0;
    let skipped = 0;

    for (const role of rolesWithoutCategory) {
      // Skip roles with invalid or empty codes
      if (!role.code || role.code.trim() === "") {
        console.log(`❌ Skipping invalid role (ID: ${role._id}): missing code`);
        skipped++;
        continue;
      }

      const category = ROLE_CATEGORY_MAP[role.code];

      if (category) {
        role.category = category;
        await role.save();
        console.log(
          `✅ Updated role: ${role.code} (${role.name}) → Category: ${category}`
        );
        updated++;
      } else {
        // Default to PORTAL if no mapping found
        role.category = "PORTAL";
        await role.save();
        console.log(
          `⚠️  No mapping found for role: ${role.code} (${role.name}) → Defaulted to: PORTAL`
        );
        skipped++;
      }
    }

    console.log("\n📊 Migration Summary:");
    console.log(`   ✅ Updated: ${updated} roles`);
    console.log(`   ⚠️  Defaulted: ${skipped} roles`);
    console.log(`   📦 Total: ${updated + skipped} roles`);

    // Verify all roles now have categories
    const rolesStillWithoutCategory = await Role.find({
      $or: [
        { category: { $exists: false } },
        { category: null },
        { category: "" },
      ],
    });

    if (rolesStillWithoutCategory.length === 0) {
      console.log("\n✅ All roles now have categories assigned");
    } else {
      console.log(
        `\n⚠️  Warning: ${rolesStillWithoutCategory.length} roles still without category`
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the migration
if (require.main === module) {
  console.log("🚀 Starting role category migration...\n");
  addCategoryToRoles();
}

module.exports = addCategoryToRoles;
