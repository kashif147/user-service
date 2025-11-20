#!/usr/bin/env node
/**
 * Script to add communication permissions to the database and assign them to ASU role
 * This script:
 * 1. Creates communication permissions if they don't exist
 * 2. Adds communication permissions to ASU (Assistant Super User) role
 * 3. Note: SU (Super User) already has "*" (full access) so doesn't need explicit permissions
 */

require("dotenv-flow").config();

const mongoose = require("mongoose");
const Permission = require("../models/permission.model");
const Role = require("../models/role.model");

const communicationPermissions = [
  {
    name: "Read Communication",
    code: "COMMUNICATION_READ",
    description: "View templates, letters, and bookmarks",
    resource: "communication",
    action: "read",
    category: "COMMUNICATION",
    level: 1,
    isSystemPermission: true,
  },
  {
    name: "Create Communication",
    code: "COMMUNICATION_CREATE",
    description: "Create templates, generate letters, and create bookmarks",
    resource: "communication",
    action: "create",
    category: "COMMUNICATION",
    level: 30,
    isSystemPermission: true,
  },
  {
    name: "Write Communication",
    code: "COMMUNICATION_WRITE",
    description: "Update templates, extract placeholders, and update bookmarks",
    resource: "communication",
    action: "write",
    category: "COMMUNICATION",
    level: 30,
    isSystemPermission: true,
  },
  {
    name: "Delete Communication",
    code: "COMMUNICATION_DELETE",
    description: "Delete templates and bookmarks",
    resource: "communication",
    action: "delete",
    category: "COMMUNICATION",
    level: 50,
    isSystemPermission: true,
  },
];

async function addCommunicationPermissions() {
  try {
    const mongoUri =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      "mongodb://localhost:27017/user-service";

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // Step 1: Create or update communication permissions
    console.log("\n📝 Creating/updating communication permissions...");
    const permissionCodes = [];

    for (const perm of communicationPermissions) {
      const existing = await Permission.findOne({ code: perm.code });
      if (existing) {
        console.log(`   ⏭️  Permission ${perm.code} already exists, updating...`);
        Object.assign(existing, perm);
        existing.updatedAt = new Date();
        await existing.save();
        permissionCodes.push(existing.code);
      } else {
        console.log(`   ✅ Creating permission: ${perm.code}`);
        const created = await Permission.create(perm);
        permissionCodes.push(created.code);
      }
    }

    console.log(`\n✅ ${permissionCodes.length} communication permissions ready`);

    // Step 2: Add permissions to ASU role
    console.log("\n🔧 Updating ASU role with communication permissions...");
    const asuRole = await Role.findOne({ code: "ASU", isActive: true });

    if (!asuRole) {
      console.log("❌ ASU role not found. Please initialize roles first.");
      process.exit(1);
    }

    console.log(`   ✅ Found ASU role: ${asuRole.name} (${asuRole.code})`);

    // Get permission IDs
    const permissionDocs = await Permission.find({
      code: { $in: permissionCodes },
    });
    const permissionIds = permissionDocs.map((p) => p._id.toString());

    // Check current permissions
    const currentPermissionIds = asuRole.permissions
      .filter((p) => typeof p === "string" && p.match(/^[0-9a-fA-F]{24}$/))
      .map((p) => p.toString());
    const currentPermissionCodes = asuRole.permissions.filter(
      (p) => typeof p === "string" && !p.match(/^[0-9a-fA-F]{24}$/)
    );

    // Add new permission IDs if not already present
    let added = 0;
    for (const permId of permissionIds) {
      if (!currentPermissionIds.includes(permId)) {
        asuRole.permissions.push(permId);
        added++;
        console.log(`   ✅ Added permission ID: ${permId}`);
      }
    }

    // Also add permission codes if using string-based permissions
    for (const code of permissionCodes) {
      if (!currentPermissionCodes.includes(code)) {
        asuRole.permissions.push(code);
        added++;
        console.log(`   ✅ Added permission code: ${code}`);
      }
    }

    if (added > 0) {
      await asuRole.save();
      console.log(`\n✅ Added ${added} communication permissions to ASU role`);
    } else {
      console.log(`\n⏭️  ASU role already has all communication permissions`);
    }

    // Step 3: Verify SU role (should have "*" for full access)
    console.log("\n🔍 Verifying SU role...");
    const suRole = await Role.findOne({ code: "SU", isActive: true });
    if (suRole) {
      const hasWildcard = suRole.permissions.includes("*");
      if (hasWildcard) {
        console.log(
          "   ✅ SU role has '*' permission - full access (no explicit permissions needed)"
        );
      } else {
        console.log(
          "   ⚠️  SU role does not have '*' permission. Adding communication permissions..."
        );
        // Add communication permissions to SU as well
        for (const permId of permissionIds) {
          if (!suRole.permissions.includes(permId)) {
            suRole.permissions.push(permId);
          }
        }
        for (const code of permissionCodes) {
          if (!suRole.permissions.includes(code)) {
            suRole.permissions.push(code);
          }
        }
        await suRole.save();
        console.log("   ✅ Added communication permissions to SU role");
      }
    } else {
      console.log("   ⚠️  SU role not found");
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 Summary");
    console.log("=".repeat(60));
    console.log(`✅ Communication permissions: ${permissionCodes.length}`);
    console.log(`   - ${permissionCodes.join(", ")}`);
    console.log(`✅ ASU role updated: ${added > 0 ? "Yes" : "Already up to date"}`);
    console.log(
      `✅ SU role: ${suRole && suRole.permissions.includes("*") ? "Has full access (*)" : "Updated with permissions"}`
    );

    await mongoose.disconnect();
    console.log("\n✅ Script completed successfully!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

addCommunicationPermissions();

