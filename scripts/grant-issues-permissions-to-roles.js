#!/usr/bin/env node

/**
 * Ensures the ISSUES_* permissions (resources "issues", "issues-complaints",
 * "issues-ftp", "issues-ir", "issues-dataprotection", "issues-templates") exist and
 * attaches them to roles so JWTs carry issues:* for policy checks on the new
 * issue-service (backend/issue-service, built in parallel — see
 * `we-need-to-implement-hidden-ocean.md` §3.6).
 *
 * Team visibility is encoded entirely in the RESOURCE, never a compound action, because
 * services/policyEvaluationService.js's evaluateActionPolicy (~line 615-643) only accepts
 * a fixed action enum (read|create|write|update|delete|admin|super_admin) and DENYs any
 * action outside it before the caller's permission array is even checked — a permission
 * code like "issues:read:complaints" would never evaluate to PERMIT.
 *
 * Base grant (issues:read/write, issues-templates:read/write): mirrors
 * grant-events-permissions-to-roles.js's CRM branch exactly (`Role.find({category:"CRM",
 * isActive:true})` gets full read+write). Unlike events-service, Issue Management is an
 * internal CRM case-management feature with no member-portal surface, so — deliberately
 * deviating from the events script here — there is no PORTAL-category branch for the base
 * issues resource.
 *
 * IMPORTANT DATA-QUALITY FINDING (confirmed against the live staging DB, not guessed):
 * the Role schema's `category` field (PORTAL|CRM|SYSTEM) is unreliable for this tenant.
 * Real CRM staff/org roles (GS, DGS, MO, AMO, AM, DAM, IO, IRO, IRE, DIR, ADIR, DPRS, RO,
 * BO, HLS, LS, LA, CC, ACC) all have `category: "PORTAL"` in the DB, with the correct
 * classification only available in a separate, non-schema field (`roleCategory: "CRM"`,
 * added by some other script, not enforced by models/role.model.js). Only "REO" literally
 * has `category: "CRM"`. This is a pre-existing issue (grant-events-permissions-to-roles.js
 * has the exact same limitation — inspect any of those roles' `permissions` array in the
 * DB and you'll see they only got EVENTS_READ/EVENTS_CREATE, the PORTAL-branch grant, never
 * EVENTS_WRITE). This script intentionally does NOT work around it (that would be inventing
 * a new role-classification mechanism outside this task's scope) — re-run this script after
 * `category` is corrected platform-wide if broader CRM write access on `issues`/
 * `issues-templates` is needed.
 *
 * Team-specific resources (issues-complaints/ftp/ir/dataprotection) are granted to
 * specific role CODES (not category) identified by inspecting the live role catalog —
 * see TEAM_ROLE_CODES below and the task report for which roles exist vs. which are gaps.
 * A code that doesn't exist in a given environment is skipped with a warning (idempotent
 * no-op), never invented. Complaints and FTP remain confirmed gaps (no matching role
 * exists yet); Data Protection was filled by scripts/create-dpo-role.js (run that first,
 * or this script's DP grant will just skip with a "not found" warning, same as any other
 * missing code).
 *
 * MongoDB connection: user-service .env.staging (MONGO_URI).
 *
 * Usage (from user-service directory):
 *   NODE_ENV=staging node scripts/grant-issues-permissions-to-roles.js
 */

const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.staging"),
});

const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

const PERMISSIONS = [
  // Base — floor permission for any issue-service route
  {
    code: "ISSUES_READ",
    name: "Read Issues",
    description: "View issue/case records (issue-service read APIs)",
    resource: "issues",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_WRITE",
    name: "Manage Issues",
    description: "Create/update issue/case records",
    resource: "issues",
    action: "write",
    level: 30,
  },
  // Complaints team
  {
    code: "ISSUES_COMPLAINTS_READ",
    name: "Read Complaint Issues",
    description: "View COMPLAINT-type issues (Complaints team visibility)",
    resource: "issues-complaints",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_COMPLAINTS_WRITE",
    name: "Manage Complaint Issues",
    description: "Create/update COMPLAINT-type issues",
    resource: "issues-complaints",
    action: "write",
    level: 30,
  },
  // Fitness to Practice team
  {
    code: "ISSUES_FTP_READ",
    name: "Read Fitness to Practice Issues",
    description: "View FTP-type issues (Fitness to Practice team visibility)",
    resource: "issues-ftp",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_FTP_WRITE",
    name: "Manage Fitness to Practice Issues",
    description: "Create/update FTP-type issues",
    resource: "issues-ftp",
    action: "write",
    level: 30,
  },
  // Industrial Relations team + Information department (both get the same resource —
  // satisfies "IR issues visible to all IR users AND the Information department" without
  // any special-casing in issue-service itself)
  {
    code: "ISSUES_IR_READ",
    name: "Read Industrial Relations Issues",
    description:
      "View IR-type issues (Industrial Relations team + Information department visibility)",
    resource: "issues-ir",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_IR_WRITE",
    name: "Manage Industrial Relations Issues",
    description: "Create/update IR-type issues",
    resource: "issues-ir",
    action: "write",
    level: 30,
  },
  // Data Protection Officer / DP team
  {
    code: "ISSUES_DATAPROTECTION_READ",
    name: "Read Data Protection Issues",
    description: "View DATA_PROTECTION-type issues (DPO/DP team visibility)",
    resource: "issues-dataprotection",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_DATAPROTECTION_WRITE",
    name: "Manage Data Protection Issues",
    description: "Create/update DATA_PROTECTION-type issues",
    resource: "issues-dataprotection",
    action: "write",
    level: 30,
  },
  // Save-View grid templates (issue-service's future /templates routes)
  {
    code: "ISSUES_TEMPLATES_READ",
    name: "Read Issues Grid Templates",
    description: "View saved Issues grid views/templates",
    resource: "issues-templates",
    action: "read",
    level: 10,
  },
  {
    code: "ISSUES_TEMPLATES_WRITE",
    name: "Manage Issues Grid Templates",
    description: "Create/update saved Issues grid views/templates",
    resource: "issues-templates",
    action: "write",
    level: 30,
  },
];

// Role codes identified by inspecting the live staging role catalog (see task report for
// the full mapping, including gaps where no role exists). Empty array = confirmed gap,
// not an oversight — do not fill in a guess here.
const TEAM_ROLE_CODES = {
  complaints: [], // GAP: no "Complaints" team role exists in the seeded catalog
  ftp: [], // GAP: no "Fitness to Practice" team role exists in the seeded catalog
  // Industrial Relations team (all IR-titled roles) + Information department
  ir: ["IRO", "IRE", "DIR", "ADIR", "IO"],
  // Data Protection Officer - role created by scripts/create-dpo-role.js (run that first).
  dataprotection: ["DPO"],
};

// Senior Management Team (SMT) — General Secretary and Deputy General Secretary
// (confirmed live role names: "General Secretary" / "Deputy General Secretary"), top
// organisational leadership rather than IR caseworkers, so kept separate from
// TEAM_ROLE_CODES.ir above. Per explicit user decision, granted full read+write across
// every team resource (Complaints/FTP/IR/DataProtection) plus the base issues/
// issues-templates resources — bypassing the category:"CRM" base-grant branch's known
// mislabeling bug the same way TEAM_ROLE_CODES.ir already does, by matching on role code
// directly rather than the unreliable `category` field.
const SMT_FULL_ACCESS_ROLE_CODES = ["GS", "DGS"];

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
    updatedBy: "grant-issues-permissions-to-roles",
  };

  let perm = await Permission.findOne({ code: doc.code });
  if (!perm) {
    perm = await Permission.create({ ...full, createdBy: "grant-issues-permissions-to-roles" });
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
      console.log(`⏭️  ${r.code} (${r.tenantId}): already has all requested issues permissions`);
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

async function attachToRoleCodes(codes, perms, label) {
  if (!codes.length) {
    console.log(`\n⚠️  ${label}: no candidate role code configured — GAP, see task report. Skipping.`);
    return { updated: 0, skipped: 0 };
  }

  const roles = await Role.find({ code: { $in: codes }, isActive: true }).lean();
  const foundCodes = new Set(roles.map((r) => r.code));
  for (const code of codes) {
    if (!foundCodes.has(code)) {
      console.log(`⚠️  ${label}: role code "${code}" not found in this environment — skipped`);
    }
  }

  console.log(`\n📋 ${label}: found ${roles.length}/${codes.length} configured role(s)`);
  if (roles.length === 0) {
    return { updated: 0, skipped: 0 };
  }
  return attachToRoles(roles, perms);
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
  const byCode = Object.fromEntries(perms.map((p) => [p.code, p]));

  // --- Base grant (issues + issues-templates) — CRM-category roles only, no PORTAL branch
  // (Issue Management has no member-portal surface) ---
  const basePerms = [
    byCode.ISSUES_READ,
    byCode.ISSUES_WRITE,
    byCode.ISSUES_TEMPLATES_READ,
    byCode.ISSUES_TEMPLATES_WRITE,
  ];
  const crmRoles = await Role.find({ category: "CRM", isActive: true }).lean();
  console.log(`\n📋 Found ${crmRoles.length} active CRM-category role(s) for base issues grant`);
  const baseResult = await attachToRoles(crmRoles, basePerms);

  // --- Team-specific grants, by explicit role code (see TEAM_ROLE_CODES header comment) ---
  const complaintsResult = await attachToRoleCodes(
    TEAM_ROLE_CODES.complaints,
    [byCode.ISSUES_COMPLAINTS_READ, byCode.ISSUES_COMPLAINTS_WRITE],
    "Complaints team",
  );

  const ftpResult = await attachToRoleCodes(
    TEAM_ROLE_CODES.ftp,
    [byCode.ISSUES_FTP_READ, byCode.ISSUES_FTP_WRITE],
    "Fitness to Practice team",
  );

  const irResult = await attachToRoleCodes(
    TEAM_ROLE_CODES.ir,
    [byCode.ISSUES_IR_READ, byCode.ISSUES_IR_WRITE],
    "Industrial Relations team + Information department",
  );

  const dpResult = await attachToRoleCodes(
    TEAM_ROLE_CODES.dataprotection,
    [byCode.ISSUES_DATAPROTECTION_READ, byCode.ISSUES_DATAPROTECTION_WRITE],
    "Data Protection Officer / DP team",
  );

  // --- SMT (General Secretary / Deputy General Secretary): full read+write across every
  // team resource, per explicit decision (not a default assumption) — see the header
  // comment above SMT_FULL_ACCESS_ROLE_CODES. ---
  const smtResult = await attachToRoleCodes(
    SMT_FULL_ACCESS_ROLE_CODES,
    [
      byCode.ISSUES_READ,
      byCode.ISSUES_WRITE,
      byCode.ISSUES_TEMPLATES_READ,
      byCode.ISSUES_TEMPLATES_WRITE,
      byCode.ISSUES_COMPLAINTS_READ,
      byCode.ISSUES_COMPLAINTS_WRITE,
      byCode.ISSUES_FTP_READ,
      byCode.ISSUES_FTP_WRITE,
      byCode.ISSUES_IR_READ,
      byCode.ISSUES_IR_WRITE,
      byCode.ISSUES_DATAPROTECTION_READ,
      byCode.ISSUES_DATAPROTECTION_WRITE,
    ],
    "SMT (General Secretary / Deputy General Secretary) — full access",
  );

  console.log(
    `\n✅ Done.` +
      ` Base: ${baseResult.updated} updated / ${baseResult.skipped} skipped.` +
      ` Complaints: ${complaintsResult.updated} updated / ${complaintsResult.skipped} skipped.` +
      ` FTP: ${ftpResult.updated} updated / ${ftpResult.skipped} skipped.` +
      ` IR+Information: ${irResult.updated} updated / ${irResult.skipped} skipped.` +
      ` Data Protection: ${dpResult.updated} updated / ${dpResult.skipped} skipped.` +
      ` SMT full access: ${smtResult.updated} updated / ${smtResult.skipped} skipped.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
