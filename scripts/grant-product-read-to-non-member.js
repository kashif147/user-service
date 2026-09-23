#!/usr/bin/env node

/**
 * Ensures PRODUCT_READ exists and attaches it to the NON-MEMBER role for every active
 * tenant, so JWTs carry product:read for policy checks.
 *
 * Needed because the portal calls user-service's GET /api/products/by-type/:productTypeId
 * (to show membership products/pricing during signup) with the CRM/portal JWT forwarded
 * as-is - there is no service-account bypass, so a NON-MEMBER caller must hold
 * product:read directly, same as the existing profile:read/portal:read/etc. it already
 * has. Without this it 403s: evaluatePermissionPolicy requires the exact `product:read`
 * permission in the caller's own permissions array (see rbac-engine.md).
 *
 * category: "PORTAL" (not "CRM", unlike the sibling PRODUCT_WRITE/PRODUCT_TYPE_READ/
 * PRICING_* permissions created by grant-product-management-permissions-to-roles.js,
 * which are deliberately CRM-only - see that script's own header comment) - this is what
 * evaluateResourcePolicy's category check actually compares against the caller's userType
 * (PORTAL -> "PORTAL" category, per policyEvaluationService.js's getUserTypeCategory), not
 * the Role document's own (separately mislabeled, see scripts/create-dpo-role.js) category
 * field.
 *
 * Idempotent - safe to re-run (create-or-update permission, $addToSet on the role).
 *
 * MongoDB connection: user-service .env.staging (MONGO_URI).
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/grant-product-read-to-non-member.js
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.staging"),
});

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const Tenant = require("../models/tenant.model");

const PERMISSION = {
  code: "PRODUCT_READ",
  name: "Read Products",
  description:
    "View products (needed for portal users to see membership products/pricing when applying)",
  resource: "product",
  action: "read",
  category: "PORTAL",
  level: 10,
};

async function ensurePermission(doc) {
  const full = {
    name: doc.name,
    code: doc.code,
    description: doc.description,
    resource: doc.resource,
    action: doc.action,
    category: doc.category,
    level: doc.level,
    isSystemPermission: true,
    isActive: true,
    updatedBy: "grant-product-read-to-non-member",
  };

  let perm = await Permission.findOne({ code: doc.code });
  if (!perm) {
    perm = await Permission.create({
      ...full,
      createdBy: "grant-product-read-to-non-member",
    });
    console.log(`✅ Created permission ${doc.code} (${perm._id})`);
  } else {
    await Permission.updateOne(
      { _id: perm._id },
      { $set: { ...full, updatedAt: new Date() } },
    );
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

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set (user-service .env.staging)");
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected\n");

  const perm = await ensurePermission(PERMISSION);

  const tenants = await Tenant.find({ isActive: true });
  if (tenants.length === 0) {
    console.error("❌ No active tenants found!");
    process.exit(1);
  }
  console.log(`\n📊 Found ${tenants.length} tenant(s)`);

  let updated = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    const nonMemberRole = await Role.findOne({
      code: "NON-MEMBER",
      tenantId: tenant._id.toString(),
      isActive: true,
    });

    if (!nonMemberRole) {
      console.log(
        `⚠️  NON-MEMBER role not found for tenant ${tenant.name}, skipping...`,
      );
      skipped++;
      continue;
    }

    if (roleHasPermission(nonMemberRole, perm.code, perm._id.toString())) {
      console.log(
        `⏭️  ${tenant.name}: NON-MEMBER already has PRODUCT_READ, skipping...`,
      );
      skipped++;
      continue;
    }

    await Role.updateOne(
      { _id: nonMemberRole._id },
      { $addToSet: { permissions: perm.code }, $set: { updatedBy: "grant-product-read-to-non-member" } },
    );
    console.log(`✅ ${tenant.name}: added PRODUCT_READ to NON-MEMBER`);
    updated++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Tenants processed: ${tenants.length}`);
  console.log(`NON-MEMBER roles updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log("=".repeat(60));

  await mongoose.disconnect();
  console.log("\n🔌 Disconnected from MongoDB");
}

main()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  });
