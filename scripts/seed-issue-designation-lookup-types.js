/**
 * Issue Designation LookupType Seeding Script
 *
 * Part of the Issue Management feature (see
 * `we-need-to-implement-hidden-ocean.md` §1.1 "Issue Designation — no local model" /
 * §3.6 point 3). issue-service's IR discriminator (`issue.ir.model.js`'s
 * `issueDesignation` field) resolves against user-service's existing generic
 * Lookup/LookupType system instead of a bespoke model of its own — the same
 * mechanism that already backs Region -> Branch -> Work Location and (more recently)
 * Event Category -> Event Type (see scripts/seed-event-category-hierarchy.js, the
 * closest precedent to this script).
 *
 * This script ONLY creates the two container LookupType documents:
 *   - ISSUEGRP ("Issue Designation Group") — the parent type. Intended to hold 3
 *     fixed group values (Individual / Group-Regional / National) per the plan, but
 *     this script deliberately does NOT create those Lookup values, or any actual
 *     Issue Designation values under ISSUEDESG — that data entry is an operational/
 *     admin task for later via the existing Lookup admin UI, not something to
 *     fabricate here. Once this script has run, both LookupTypes exist and are ready
 *     to receive values through that UI exactly like any other Lookup type.
 *   - ISSUEDESG ("Issue Designations") — the child type, linked under ISSUEGRP via
 *     ParentlookuptypeId, so that validateParentLookup() in
 *     controllers/lookup.controller.js will require every future ISSUEDESG Lookup
 *     value's Parentlookupid to point at one of ISSUEGRP's (future) group values —
 *     exactly the same enforcement Branch -> Region already gets today.
 *
 * NOTE on the group type's code: the plan's own example code "ISSUEDESGRP" is 11
 * characters, which exceeds models/lookupType.model.js's `code` field constraint
 * (`maxlength: 10`, confirmed by reading the schema) and would fail Mongoose
 * validation outright. Using "ISSUEGRP" (8 chars) instead — same meaning ("Issue
 * [Designation] Group"), fits the constraint. ISSUEDESG (9 chars) is unaffected and
 * used as-is.
 *
 * Idempotent: checks for each LookupType by `code` before creating, safe to re-run.
 *
 * Usage: NODE_ENV=staging node scripts/seed-issue-designation-lookup-types.js
 */

const mongoose = require("mongoose");
const LookupType = require("../models/lookupType.model");
const lookupCacheService = require("../services/lookupCacheService");

async function connectToDatabase() {
  try {
    if (process.env.NODE_ENV === "staging") {
      require("dotenv").config({ path: ".env.staging" });
    } else if (process.env.NODE_ENV === "development") {
      require("dotenv").config({ path: ".env.development" });
    } else {
      require("dotenv").config();
    }

    const mongoUri =
      process.env.MONGO_URI || "mongodb://localhost:27017/user-service-db";

    console.log(
      `🔗 Connecting to ${process.env.NODE_ENV || "default"} environment...`
    );
    console.log(`📊 Database: ${mongoUri.split("/").pop().split("?")[0]}`);

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}

/**
 * Find-or-create the "Issue Designation Group" LookupType (code ISSUEGRP).
 * Root type — no parent. Will eventually hold 3 fixed values (Individual /
 * Group-Regional / National), not seeded here.
 */
async function ensureIssueDesignationGroupLookupType(defaultUserId) {
  let groupType = await LookupType.findOne({ code: "ISSUEGRP" });

  if (groupType) {
    console.log(`ℹ️  "Issue Designation Group" LookupType already exists (${groupType._id})`);
    return groupType;
  }

  groupType = await new LookupType({
    code: "ISSUEGRP",
    lookuptype: "Issue Designation Group",
    displayname: "Issue Designation Group",
    ParentlookuptypeId: null,
    isdeleted: false,
    isactive: true,
    userid: defaultUserId,
  }).save();

  console.log(`✅ Created "Issue Designation Group" LookupType (${groupType._id})`);
  return groupType;
}

/**
 * Find-or-create the "Issue Designations" LookupType (code ISSUEDESG), linked
 * under Issue Designation Group via ParentlookuptypeId.
 */
async function ensureIssueDesignationLookupType(groupTypeId, defaultUserId) {
  let designationType = await LookupType.findOne({ code: "ISSUEDESG" });

  if (designationType) {
    if (
      designationType.ParentlookuptypeId &&
      String(designationType.ParentlookuptypeId) === String(groupTypeId)
    ) {
      console.log(`ℹ️  "Issue Designations" LookupType already exists and is linked (${designationType._id})`);
    } else {
      designationType.ParentlookuptypeId = groupTypeId;
      await designationType.save();
      console.log(`🔗 "Issue Designations" LookupType already existed — linked it to Issue Designation Group (${designationType._id})`);
    }
    return designationType;
  }

  designationType = await new LookupType({
    code: "ISSUEDESG",
    lookuptype: "Issue Designations",
    displayname: "Issue Designations",
    ParentlookuptypeId: groupTypeId,
    isdeleted: false,
    isactive: true,
    userid: defaultUserId,
  }).save();

  console.log(`✅ Created "Issue Designations" LookupType (${designationType._id}), linked to Issue Designation Group`);
  return designationType;
}

async function verifySeededData() {
  const groupType = await LookupType.findOne({ code: "ISSUEGRP" });
  const designationType = await LookupType.findOne({ code: "ISSUEDESG" });

  console.log("\n📋 Issue Designation LookupType summary:");
  console.log(
    `📍 ISSUEGRP (Issue Designation Group): ${groupType ? groupType._id : "NOT FOUND"}`
  );
  console.log(
    `📍 ISSUEDESG (Issue Designations): ${designationType ? designationType._id : "NOT FOUND"}, ` +
      `linked to group: ${
        !!(
          groupType &&
          designationType?.ParentlookuptypeId &&
          String(designationType.ParentlookuptypeId) === String(groupType._id)
        )
      }`
  );
  console.log(
    "⚠️  No Lookup values created under either type — the 3 group values " +
      "(Individual / Group-Regional / National) and any real Issue Designation " +
      "values must still be entered via the Lookup admin UI."
  );
}

async function main() {
  try {
    console.log("🚀 Starting Issue Designation LookupType Seeding Process");
    console.log("=====================================================");

    await connectToDatabase();

    const defaultUserId =
      process.env.DEFAULT_USER_ID || "681117cb357e50dfa229b5f2";

    const groupType = await ensureIssueDesignationGroupLookupType(defaultUserId);
    await ensureIssueDesignationLookupType(groupType._id, defaultUserId);

    // This script writes directly via Mongoose, bypassing lookuptype.ontroller.js's
    // create/update handlers - which is the only place that invalidates
    // GET /api/lookup's Redis cache (see seed-event-category-hierarchy.js for the
    // same note). Without this, callers could see a stale lookup-type list for up
    // to the cache TTL after this script runs.
    try {
      await lookupCacheService.clearAllCaches();
      console.log("🗑️  Invalidated lookup caches so the new data is visible immediately");
    } catch (cacheError) {
      console.warn(
        "⚠️  Failed to invalidate lookup cache - new data may not appear via the API for up to the cache TTL:",
        cacheError.message,
      );
    }

    await verifySeededData();

    console.log("=====================================================");
    console.log("✅ Issue Designation LookupType seeding completed successfully!");
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ensureIssueDesignationGroupLookupType,
  ensureIssueDesignationLookupType,
  verifySeededData,
};
