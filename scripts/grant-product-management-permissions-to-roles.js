#!/usr/bin/env node

/**
 * Ensures PRODUCT_WRITE / PRICING_WRITE / PRICING_READ / PRODUCT_TYPE_READ
 * exist and attaches them to CRM roles, so JWTs carry product:write,
 * pricing:write, pricing:read and product-type:read for policy checks.
 *
 * Needed because events-service's auto Product/Pricing linking (creating an
 * event with a Category + prices) forwards the acting user's own JWT to
 * user-service's Product/ProductType/Pricing APIs - there is no service
 * account bypass, so whoever creates/edits events must hold these directly:
 *   - product-type:read  -> resolve the Category's ProductType
 *   - product:write      -> create/update the linked Product
 *   - pricing:write       -> create/update the linked Pricing record
 *   - pricing:read        -> look up current Pricing when syncing an edit
 *
 * Only CRM roles get these - portal/member-facing roles never create events
 * or touch Product Management.
 *
 * MongoDB connection: user-service .env.staging (MONGO_URI).
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/grant-product-management-permissions-to-roles.js
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
    code: "PRODUCT_TYPE_READ",
    name: "Read Product Types",
    description: "View product types (needed to resolve an Event Category to its ProductType)",
    resource: "product-type",
    action: "read",
    level: 10,
  },
  {
    code: "PRODUCT_WRITE",
    name: "Manage Products",
    description: "Create or update products (needed for events-service's auto Product/Pricing link)",
    resource: "product",
    action: "write",
    level: 30,
  },
  {
    code: "PRICING_READ",
    name: "Read Pricing",
    description: "View pricing records (needed when syncing an event's price/date edits)",
    resource: "pricing",
    action: "read",
    level: 10,
  },
  {
    code: "PRICING_WRITE",
    name: "Manage Pricing",
    description: "Create or update pricing records (needed for events-service's auto Product/Pricing link)",
    resource: "pricing",
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
    updatedBy: "grant-product-management-permissions-to-roles",
  };

  let perm = await Permission.findOne({ code: doc.code });
  if (!perm) {
    perm = await Permission.create({ ...full, createdBy: "grant-product-management-permissions-to-roles" });
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
      console.log(`⏭️  ${r.code} (${r.tenantId}): already has all product-management permissions`);
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

  console.log(
    `\n✅ Done. CRM: ${crmResult.updated} updated / ${crmResult.skipped} skipped.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
