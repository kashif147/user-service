/**
 * Event Category Hierarchy Seeding Script
 *
 * Introduces "Event Category" as a LookupType (code EVTCAT) with two Lookup
 * values - "Continuing Professional Development" (code CPD) and
 * "Professional Events" (code EVENT) - and links the existing "Event Type"
 * LookupType under it via the generic Lookup/LookupType parent hierarchy
 * (the same mechanism used for Region -> Branch -> Work Location).
 *
 * This does NOT introduce a new model - EventCategory is deliberately just
 * data on the existing Lookup/LookupType collections, so it flows through
 * all existing CRUD/populate code (lookup.controller.js, lookuptype.ontroller.js)
 * and the frontend's generic hierarchy utilities (lookupHierarchy.js,
 * ParentLookupSelect.jsx) with no further backend/frontend schema changes.
 *
 * Usage: NODE_ENV=staging node scripts/seed-event-category-hierarchy.js
 *
 * Existing "Event Type" Lookup rows are NOT auto-assigned a category here -
 * there is no reliable signal to infer CPD vs EVENT from a name alone, so
 * this script only reports which rows are unmapped. Assign each one's parent
 * via the Configuration UI (Event Type lookup drawer will show a required
 * "Event Category" parent-select once this script has run) or extend
 * EVENT_TYPE_CATEGORY_ASSIGNMENTS below with an explicit code->category map.
 */

const mongoose = require("mongoose");
const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");
const lookupCacheService = require("../services/lookupCacheService");

// Fill in with real Event Type lookup codes -> "CPD" | "EVENT" once known for
// the target environment/tenant, e.g. { CPDSEM: "CPD", CONF: "EVENT" }.
const EVENT_TYPE_CATEGORY_ASSIGNMENTS = {};

const EVENT_TYPE_LOOKUPTYPE_NAME_PATTERN = /^event\s*type$/i;

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
 * Find-or-create the "Event Category" LookupType (code EVTCAT).
 */
async function ensureEventCategoryLookupType(defaultUserId) {
  let eventCategoryType = await LookupType.findOne({ code: "EVTCAT" });

  if (eventCategoryType) {
    console.log(`ℹ️  "Event Category" LookupType already exists (${eventCategoryType._id})`);
    return eventCategoryType;
  }

  eventCategoryType = await new LookupType({
    code: "EVTCAT",
    lookuptype: "Event Category",
    displayname: "Event Category",
    ParentlookuptypeId: null,
    isdeleted: false,
    isactive: true,
    userid: defaultUserId,
  }).save();

  console.log(`✅ Created "Event Category" LookupType (${eventCategoryType._id})`);
  return eventCategoryType;
}

/**
 * Find-or-create the CPD and EVENT Lookup rows under Event Category.
 */
async function ensureEventCategoryLookups(eventCategoryTypeId, defaultUserId) {
  const categories = [
    { code: "CPD", lookupname: "Continuing Professional Development" },
    { code: "EVENT", lookupname: "Professional Events" },
  ];

  const result = {};

  for (const category of categories) {
    let lookup = await Lookup.findOne({
      code: category.code,
      lookuptypeId: eventCategoryTypeId,
    });

    if (lookup) {
      console.log(`ℹ️  "${category.lookupname}" (${category.code}) Lookup already exists (${lookup._id})`);
    } else {
      lookup = await new Lookup({
        code: category.code,
        lookupname: category.lookupname,
        DisplayName: category.lookupname,
        Parentlookupid: null,
        lookuptypeId: eventCategoryTypeId,
        isdeleted: false,
        isactive: true,
        userid: defaultUserId,
      }).save();
      console.log(`✅ Created "${category.lookupname}" (${category.code}) Lookup (${lookup._id})`);
    }

    result[category.code] = lookup;
  }

  return result;
}

/**
 * Find the existing "Event Type" LookupType and set its ParentlookuptypeId
 * to Event Category. Uses a direct .save() (bypassing the lookuptype
 * controller/route) so this doesn't get blocked by the parent-type
 * validation that will start applying to *future* writes once this is set.
 */
async function linkEventTypeToEventCategory(eventCategoryTypeId) {
  const eventTypeType = await LookupType.findOne({
    lookuptype: EVENT_TYPE_LOOKUPTYPE_NAME_PATTERN,
  });

  if (!eventTypeType) {
    console.error(
      '❌ Could not find an "Event Type" LookupType (matched against /^event\\s*type$/i). ' +
        "Confirm the exact lookuptype name/code in this environment and update the script if needed."
    );
    return null;
  }

  if (
    eventTypeType.ParentlookuptypeId &&
    String(eventTypeType.ParentlookuptypeId) === String(eventCategoryTypeId)
  ) {
    console.log('ℹ️  "Event Type" LookupType is already linked to "Event Category"');
    return eventTypeType;
  }

  eventTypeType.ParentlookuptypeId = eventCategoryTypeId;
  await eventTypeType.save();

  console.log('🔗 Linked "Event Type" LookupType -> "Event Category"');
  return eventTypeType;
}

/**
 * Backfill Parentlookupid on existing Event Type Lookup rows, using the
 * explicit EVENT_TYPE_CATEGORY_ASSIGNMENTS map. Any row not covered by that
 * map is left untouched and reported, since guessing CPD vs EVENT from a
 * name isn't reliable - those rows must be assigned by hand in Configuration.
 */
async function backfillEventTypeParents(eventTypeTypeId, categoryLookupsByCode) {
  const eventTypeLookups = await Lookup.find({
    lookuptypeId: eventTypeTypeId,
    isdeleted: false,
  });

  const unmapped = [];
  let updated = 0;

  for (const eventType of eventTypeLookups) {
    if (eventType.Parentlookupid) continue; // already assigned, leave as-is

    const categoryCode = EVENT_TYPE_CATEGORY_ASSIGNMENTS[eventType.code];
    const categoryLookup = categoryCode && categoryLookupsByCode[categoryCode];

    if (!categoryLookup) {
      unmapped.push({ code: eventType.code, name: eventType.lookupname });
      continue;
    }

    eventType.Parentlookupid = categoryLookup._id;
    await eventType.save();
    updated += 1;
    console.log(
      `🔗 Assigned Event Type "${eventType.lookupname}" (${eventType.code}) -> ${categoryCode}`
    );
  }

  console.log(`✅ Backfilled ${updated} Event Type lookup(s)`);

  if (unmapped.length > 0) {
    console.log(
      `⚠️  ${unmapped.length} Event Type lookup(s) left unmapped - assign these via Configuration UI:`
    );
    unmapped.forEach((row) => console.log(`   - ${row.name} (${row.code})`));
  }

  return { updated, unmapped };
}

async function verifySeededData() {
  const eventCategoryType = await LookupType.findOne({ code: "EVTCAT" });
  const eventTypeType = await LookupType.findOne({
    lookuptype: EVENT_TYPE_LOOKUPTYPE_NAME_PATTERN,
  });

  if (!eventCategoryType) {
    console.log("⚠️  Verification skipped - Event Category LookupType not found");
    return;
  }

  const categoryLookups = await Lookup.find({
    lookuptypeId: eventCategoryType._id,
    isdeleted: false,
  });

  console.log("\n📋 Event Category hierarchy summary:");
  console.log(
    `📍 Event Category LookupType (${eventCategoryType._id}), ` +
      `Event Type linked: ${eventTypeType && String(eventTypeType.ParentlookuptypeId) === String(eventCategoryType._id)}`
  );

  for (const category of categoryLookups) {
    const childCount = await Lookup.countDocuments({
      Parentlookupid: category._id,
      isdeleted: false,
    });
    console.log(`  🏷️  ${category.lookupname} (${category.code}) - ${childCount} Event Type(s) assigned`);
  }
}

async function main() {
  try {
    console.log("🚀 Starting Event Category Hierarchy Seeding Process");
    console.log("=====================================================");

    await connectToDatabase();

    const defaultUserId =
      process.env.DEFAULT_USER_ID || "681117cb357e50dfa229b5f2";

    const eventCategoryType = await ensureEventCategoryLookupType(defaultUserId);
    const categoryLookupsByCode = await ensureEventCategoryLookups(
      eventCategoryType._id,
      defaultUserId
    );
    const eventTypeType = await linkEventTypeToEventCategory(eventCategoryType._id);

    if (eventTypeType) {
      await backfillEventTypeParents(eventTypeType._id, categoryLookupsByCode);
    }

    // This script writes directly via Mongoose, bypassing lookup.controller.js's
    // create/update handlers - which is the only place that invalidates
    // GET /api/lookup's Redis cache (10 min TTL, keyed "all"). Without this,
    // callers (e.g. events-service resolving an Event Category by id) would
    // see a stale lookup list - and fail with "not found" - for up to 10
    // minutes after this script runs.
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
    console.log("✅ Event Category hierarchy seeding completed successfully!");
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
  ensureEventCategoryLookupType,
  ensureEventCategoryLookups,
  linkEventTypeToEventCategory,
  backfillEventTypeParents,
  verifySeededData,
};
