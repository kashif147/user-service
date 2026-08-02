#!/usr/bin/env node

/**
 * Creates the "Data Protection Officer" role (code DPO) that
 * scripts/grant-issues-permissions-to-roles.js's TEAM_ROLE_CODES.dataprotection gap has
 * been waiting on since it was first written — no DPO/DP-team role existed anywhere in
 * the seeded catalog until now (confirmed by inspecting the live role catalog directly).
 *
 * Matches the same seniority/authority tier as the existing Assistant Director of
 * Industrial Relations role (level 75) - a Data Protection Officer is a statutorily
 * independent, senior accountable role under GDPR, not a junior specialist post.
 *
 * category: "PORTAL" (not "CRM") deliberately matches the existing, if mislabeled,
 * convention every other real CRM/staff role in this tenant already uses (DIR/ADIR/IRO/
 * IRE/IO/GS/DGS are all category:"PORTAL" too - see grant-issues-permissions-to-roles.js's
 * header comment for the confirmed data-quality finding) - making DPO an outlier here
 * would just create a second inconsistency instead of fixing the real one. roleCategory:
 * "CRM" is set the same way those roles' documents already carry it - via the raw
 * collection, bypassing Mongoose's strict schema, since models/role.model.js doesn't
 * declare that field at all.
 *
 * Idempotent — safe to re-run (checks for an existing {tenantId, code} first).
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/create-dpo-role.js
 *
 * After this runs, re-run scripts/grant-issues-permissions-to-roles.js (with "DPO" added
 * to TEAM_ROLE_CODES.dataprotection) to actually grant it issues-dataprotection:read/write.
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.staging"),
});

const mongoose = require("mongoose");
const Role = require("../models/role.model");

// Same tenant every other Issue Management role script in this session has targeted -
// the one populated tenant in this environment (see grant-issues-permissions-to-roles.js's
// own live-catalog inspection).
const TENANT_ID = "68cbf7806080b4621d469d34";

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set (user-service .env.staging)");
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected\n");

  const existing = await Role.findOne({ tenantId: TENANT_ID, code: "DPO" }).lean();
  if (existing) {
    console.log(`⏭️  DPO role already exists (${existing._id}) - no-op`);
  } else {
    const role = await Role.create({
      tenantId: TENANT_ID,
      name: "Data Protection Officer",
      code: "DPO",
      description: "Data Protection Officer",
      category: "PORTAL",
      level: 75,
      permissions: [],
      isActive: true,
      isSystemRole: false,
      createdBy: "create-dpo-role",
    });
    console.log(`✅ Created role DPO / "Data Protection Officer" (${role._id})`);

    // Set roleCategory the same way every other real CRM role's document already carries
    // it - via the raw collection, since it's not part of the Mongoose schema and
    // Role.create() above would silently drop it.
    await mongoose.connection.db
      .collection("roles")
      .updateOne({ _id: role._id }, { $set: { roleCategory: "CRM" } });
    console.log(`✅ Set roleCategory: "CRM" on DPO (matches DIR/ADIR/IRO/IRE/IO/GS/DGS)`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
