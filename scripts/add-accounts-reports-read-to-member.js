#!/usr/bin/env node

/**
 * Script to add accounts.reports read permission to MEMBER (portal member) role
 *
 * Usage: node scripts/add-accounts-reports-read-to-member.js
 * Uses MONGO_URI from .env.staging
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const Tenant = require("../models/tenant.model");

const PERMISSION_CODE = "ACCOUNTS.REPORTS_READ";
const PERMISSION = {
  name: "Read Account Reports",
  code: PERMISSION_CODE,
  description: "View account reports (statements, balances, ledgers)",
  resource: "accounts.reports",
  action: "read",
  category: "ACCOUNT",
  level: 1,
  isSystemPermission: true,
  isActive: true,
};

async function addAccountsReportsReadToMember() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI not set in .env.staging");
    }

    console.log("Connecting to staging MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    let perm = await Permission.findOne({
      code: PERMISSION_CODE,
      isActive: true,
    });
    if (!perm) {
      console.log("Creating ACCOUNTS.REPORTS_READ permission...");
      perm = await Permission.create(PERMISSION);
      console.log("Created permission:", perm.name);
    } else {
      console.log("Permission already exists:", perm.name);
    }

    const tenants = await Tenant.find({ isActive: true });
    if (tenants.length === 0) {
      console.error("No active tenants found");
      process.exit(1);
    }

    let updated = 0;
    let skipped = 0;

    for (const tenant of tenants) {
      const memberRole = await Role.findOne({
        code: "MEMBER",
        tenantId: tenant._id.toString(),
        isActive: true,
      });

      if (!memberRole) {
        console.log(
          `MEMBER role not found for tenant ${tenant.name}, skipping`,
        );
        skipped++;
        continue;
      }

      const perms = memberRole.permissions || [];
      if (perms.includes(PERMISSION_CODE)) {
        console.log(`MEMBER already has ${PERMISSION_CODE} for ${tenant.name}`);
        skipped++;
        continue;
      }

      memberRole.permissions = [...perms, PERMISSION_CODE];
      memberRole.updatedBy = "add-accounts-reports-read-script";
      await memberRole.save();
      console.log(`Added ${PERMISSION_CODE} to MEMBER for ${tenant.name}`);
      updated++;
    }

    console.log("\nSummary:");
    console.log(
      `Tenants: ${tenants.length}, Updated: ${updated}, Skipped: ${skipped}`,
    );
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

addAccountsReportsReadToMember()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
