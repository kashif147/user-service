#!/usr/bin/env node

/**
 * Ensures AUDIT_READ (resource audit, action read) exists and attaches it to every
 * active CRM role so JWTs include audit:read for policy checks on audit-service.
 *
 * Covers all audit-service read routes:
 *   GET /api/audit-logs
 *   GET /api/audit-logs/summary
 *   GET /api/audit-logs/resource/:resourceType/:resourceId
 *   GET /api/audit-logs/:id
 *
 * MongoDB connection: user-service .env.staging (MONGO_URI).
 * audit-service/.env.staging is PostgreSQL only; it is not used for this script.
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/grant-audit-read-to-crm-roles.js
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.staging"),
});

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

const PERM_CODE = "AUDIT_READ";

async function ensureAuditReadPermission() {
  const doc = {
    name: "Read Audit Logs",
    code: PERM_CODE,
    description:
      "View audit logs, summaries, and per-resource history (audit-service read APIs)",
    resource: "audit",
    action: "read",
    category: "CRM",
    level: 30,
    isSystemPermission: true,
    isActive: true,
    updatedBy: "grant-audit-read-to-crm-roles",
  };

  let perm = await Permission.findOne({ code: PERM_CODE });
  if (!perm) {
    perm = await Permission.create({
      ...doc,
      createdBy: "grant-audit-read-to-crm-roles",
    });
    console.log(`✅ Created permission ${PERM_CODE} (${perm._id})`);
  } else {
    await Permission.updateOne(
      { _id: perm._id },
      { $set: { ...doc, updatedAt: new Date() } }
    );
    perm = await Permission.findById(perm._id);
    console.log(`✅ Updated permission ${PERM_CODE} (${perm._id})`);
  }
  return perm;
}

function roleHasAuditRead(role, permissionIdStr) {
  for (const p of role.permissions || []) {
    if (typeof p !== "string") continue;
    if (p === PERM_CODE) return true;
    if (permissionIdStr && p === permissionIdStr) return true;
  }
  return false;
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set (user-service .env.staging)");
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected\n");

  const perm = await ensureAuditReadPermission();
  const permIdStr = perm._id.toString();

  const crmRoles = await Role.find({ category: "CRM", isActive: true }).lean();
  if (crmRoles.length === 0) {
    console.log("⚠️  No active CRM roles found.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n📋 Found ${crmRoles.length} CRM role(s)\n`);

  let updated = 0;
  let skipped = 0;

  for (const r of crmRoles) {
    if (roleHasAuditRead(r, permIdStr)) {
      console.log(`⏭️  ${r.code} (${r.tenantId}): already has ${PERM_CODE}`);
      skipped++;
      continue;
    }

    await Role.updateOne(
      { _id: r._id },
      {
        $set: {
          permissions: [...(r.permissions || []), PERM_CODE],
          updatedBy: "grant-audit-read-to-crm-roles",
          updatedAt: new Date(),
        },
      }
    );
    console.log(`✅ ${r.code} (${r.tenantId}): added ${PERM_CODE}`);
    updated++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Updated: ${updated}  Skipped: ${skipped}`);
  console.log(
    "Users must sign in again (or refresh token) to receive audit:read in JWT."
  );
  console.log("=".repeat(60));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
