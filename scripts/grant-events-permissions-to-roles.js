#!/usr/bin/env node

/**
 * Ensures EVENTS_READ / EVENTS_CREATE / EVENTS_WRITE (resource "events") exist
 * and attaches them to roles so JWTs carry events:* for policy checks on the
 * new events-service.
 *
 * CRM roles get all three (manage events/courses, register/cancel attendees).
 * PORTAL roles get only read + create (self-service browse + register; they
 * never update/delete an Event/Course).
 *
 * MongoDB connection: user-service .env.staging (MONGO_URI).
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/grant-events-permissions-to-roles.js
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.staging"),
});

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

const PERMISSIONS = [
  {
    code: "EVENTS_READ",
    name: "Read Events & Courses",
    description: "View events, courses, registrations and certificates (events-service read APIs)",
    resource: "events",
    action: "read",
    level: 10,
  },
  {
    code: "EVENTS_CREATE",
    name: "Create Events & Courses Registrations",
    description: "Create events/courses, register attendees, and issue certificates",
    resource: "events",
    action: "create",
    level: 30,
  },
  {
    code: "EVENTS_WRITE",
    name: "Manage Events & Courses",
    description: "Update or cancel events, courses, sessions and registrations",
    resource: "events",
    action: "write",
    level: 30,
  },
];

async function ensurePermission(doc) {
  const full = {
    name: doc.name,
    code: doc.code,
    description: doc.description,
    resource: doc.resource,
    action: doc.action,
    category: "CRM",
    level: doc.level,
    isSystemPermission: true,
    isActive: true,
    updatedBy: "grant-events-permissions-to-roles",
  };

  let perm = await Permission.findOne({ code: doc.code });
  if (!perm) {
    perm = await Permission.create({ ...full, createdBy: "grant-events-permissions-to-roles" });
    console.log(`✅ Created permission ${doc.code} (${perm._id})`);
  } else {
    await Permission.updateOne({ _id: perm._id }, { $set: { ...full, updatedAt: new Date() } });
    perm = await Permission.findById(perm._id);
    console.log(`✅ Updated permission ${doc.code} (${perm._id})`);
  }
  return perm;
}

function roleHasPermission(role, code, permissionIdStr) {
  for (const p of role.permissions || []) {
    if (typeof p !== "string") continue;
    if (p === code) return true;
    if (permissionIdStr && p === permissionIdStr) return true;
  }
  return false;
}

async function attachToRoles(roles, perms) {
  let updated = 0;
  let skipped = 0;
  for (const r of roles) {
    const toAdd = perms.filter((perm) => !roleHasPermission(r, perm.code, perm._id.toString()));
    if (toAdd.length === 0) {
      console.log(`⏭️  ${r.code} (${r.tenantId}): already has all events permissions`);
      skipped++;
      continue;
    }
    await Role.updateOne(
      { _id: r._id },
      { $addToSet: { permissions: { $each: toAdd.map((p) => p.code) } } },
    );
    console.log(`✅ ${r.code} (${r.tenantId}): added ${toAdd.map((p) => p.code).join(", ")}`);
    updated++;
  }
  return { updated, skipped };
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set (user-service .env.staging)");
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected\n");

  const perms = [];
  for (const doc of PERMISSIONS) {
    perms.push(await ensurePermission(doc));
  }

  const crmRoles = await Role.find({ category: "CRM", isActive: true }).lean();
  console.log(`\n📋 Found ${crmRoles.length} active CRM role(s)`);
  const crmResult = await attachToRoles(crmRoles, perms);

  const portalRoles = await Role.find({ category: "PORTAL", isActive: true }).lean();
  console.log(`\n📋 Found ${portalRoles.length} active PORTAL role(s)`);
  const readCreatePerms = perms.filter((p) => p.action !== "write");
  const portalResult = await attachToRoles(portalRoles, readCreatePerms);

  console.log(
    `\n✅ Done. CRM: ${crmResult.updated} updated / ${crmResult.skipped} skipped. ` +
      `PORTAL: ${portalResult.updated} updated / ${portalResult.skipped} skipped.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
