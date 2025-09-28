/**
 * Location Hierarchy Seeding Script
 *
 * Seeds the database with work location hierarchy data:
 * Region -> Branch -> Work Location
 *
 * Usage: NODE_ENV=staging node scripts/seed-location-hierarchy.js
 */

const mongoose = require("mongoose");
const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");
const fs = require("fs");
const path = require("path");

/**
 * Connect to MongoDB
 */
async function connectToDatabase() {
  try {
    // Load environment variables based on NODE_ENV
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
 * Parse CSV data and convert to hierarchy structure
 */
function parseCSVData() {
  try {
    const csvPath = path.join(
      __dirname,
      "../docs/region_branch_worklocation-seeding-data.csv"
    );
    const csvContent = fs.readFileSync(csvPath, "utf8");
    const lines = csvContent.trim().split("\n");

    // Skip header row
    const dataLines = lines.slice(1);

    const hierarchyMap = new Map();

    for (const line of dataLines) {
      const [branch, region, workPlace] = line
        .split(",")
        .map((item) => item.trim().replace(/"/g, ""));

      // Skip empty or invalid entries
      if (
        !branch ||
        !region ||
        !workPlace ||
        branch === "Branch" ||
        region === "Region"
      ) {
        continue;
      }

      // Initialize region if not exists
      if (!hierarchyMap.has(region)) {
        hierarchyMap.set(region, new Map());
      }

      // Initialize branch if not exists
      if (!hierarchyMap.get(region).has(branch)) {
        hierarchyMap.get(region).set(branch, []);
      }

      // Add work location to branch
      hierarchyMap.get(region).get(branch).push(workPlace);
    }

    // Convert to the expected format
    const locationHierarchyData = [];
    for (const [region, branches] of hierarchyMap) {
      const branchData = [];
      for (const [branch, workLocations] of branches) {
        branchData.push({
          branch: branch,
          workLocations: workLocations,
        });
      }
      locationHierarchyData.push({
        region: region,
        branches: branchData,
      });
    }

    console.log(`📊 Parsed ${locationHierarchyData.length} regions from CSV`);
    return locationHierarchyData;
  } catch (error) {
    console.error("❌ Error parsing CSV data:", error);
    throw error;
  }
}

/**
 * Get lookup type IDs
 */
async function getLookupTypeIds() {
  try {
    const regionType = await LookupType.findOne({ code: "REGION" });
    const branchType = await LookupType.findOne({ code: "BRANCH" });
    const workLocType = await LookupType.findOne({ code: "WORKLOC" });

    if (!regionType || !branchType || !workLocType) {
      throw new Error(
        "Required lookup types not found. Please ensure REGION, BRANCH, and WORKLOC types exist."
      );
    }

    return {
      regionTypeId: regionType._id,
      branchTypeId: branchType._id,
      workLocTypeId: workLocType._id,
    };
  } catch (error) {
    console.error("❌ Error getting lookup type IDs:", error);
    throw error;
  }
}

/**
 * Clear existing location hierarchy data
 */
async function clearExistingLocationData() {
  try {
    const { regionTypeId, branchTypeId, workLocTypeId } =
      await getLookupTypeIds();

    const result = await Lookup.deleteMany({
      lookuptypeId: { $in: [regionTypeId, branchTypeId, workLocTypeId] },
    });

    console.log(`🗑️ Cleared ${result.deletedCount} existing location records`);
  } catch (error) {
    console.error("❌ Error clearing existing data:", error);
    throw error;
  }
}

/**
 * Generate unique code for lookup item (max 10 characters)
 */
function generateCode(name, prefix, existingCodes = []) {
  // Calculate available space for name part (max 10 - prefix length - 1 for underscore)
  const prefixLength = prefix.length;
  const maxNameLength = 10 - prefixLength - 1; // -1 for underscore

  let baseName = name
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .substring(0, maxNameLength);

  let code = prefix + "_" + baseName;

  // If code is still too long, truncate further
  if (code.length > 10) {
    const availableLength = 10 - prefixLength - 1;
    baseName = baseName.substring(0, availableLength);
    code = prefix + "_" + baseName;
  }

  let counter = 1;
  let originalCode = code;

  while (existingCodes.includes(code)) {
    // Calculate space for counter
    const counterStr = counter.toString();
    const maxNameWithCounter = 10 - prefixLength - 1 - counterStr.length;
    const truncatedName = baseName.substring(
      0,
      Math.max(0, maxNameWithCounter)
    );
    code = prefix + "_" + truncatedName + counterStr;
    counter++;

    // Prevent infinite loop
    if (counter > 999) {
      code = prefix + "_" + counter;
      break;
    }
  }

  existingCodes.push(code);
  return code;
}

/**
 * Seed location hierarchy data
 */
async function seedLocationHierarchy() {
  try {
    console.log("🏢 Starting location hierarchy seeding...");

    const locationHierarchyData = parseCSVData();

    if (locationHierarchyData.length === 0) {
      console.log("⚠️ No location data found in CSV file.");
      return;
    }

    const { regionTypeId, branchTypeId, workLocTypeId } =
      await getLookupTypeIds();
    const defaultUserId =
      process.env.DEFAULT_USER_ID || "681117cb357e50dfa229b5f2";

    const existingCodes = [];
    const seededData = [];

    // First, seed all regions
    const regionMap = new Map();
    for (const locationData of locationHierarchyData) {
      const regionCode = generateCode(
        locationData.region,
        "REG",
        existingCodes
      );

      const region = new Lookup({
        code: regionCode,
        lookupname: locationData.region,
        DisplayName: locationData.region,
        Parentlookupid: null,
        lookuptypeId: regionTypeId,
        isdeleted: false,
        isactive: true,
        userid: defaultUserId,
      });

      const savedRegion = await region.save();
      regionMap.set(locationData.region, savedRegion._id);
      seededData.push({
        type: "Region",
        name: locationData.region,
        code: regionCode,
      });

      console.log(`📍 Seeded region: ${locationData.region} (${regionCode})`);
    }

    // Then, seed all branches with their parent regions
    const branchMap = new Map();
    for (const locationData of locationHierarchyData) {
      const regionId = regionMap.get(locationData.region);

      for (const branchData of locationData.branches) {
        const branchCode = generateCode(branchData.branch, "BR", existingCodes);

        const branch = new Lookup({
          code: branchCode,
          lookupname: branchData.branch,
          DisplayName: branchData.branch,
          Parentlookupid: regionId,
          lookuptypeId: branchTypeId,
          isdeleted: false,
          isactive: true,
          userid: defaultUserId,
        });

        const savedBranch = await branch.save();
        branchMap.set(branchData.branch, savedBranch._id);
        seededData.push({
          type: "Branch",
          name: branchData.branch,
          code: branchCode,
          parent: locationData.region,
        });

        console.log(
          `🏪 Seeded branch: ${branchData.branch} (${branchCode}) under ${locationData.region}`
        );
      }
    }

    // Finally, seed all work locations with their parent branches
    for (const locationData of locationHierarchyData) {
      for (const branchData of locationData.branches) {
        const branchId = branchMap.get(branchData.branch);

        for (const workLocation of branchData.workLocations) {
          const workLocCode = generateCode(workLocation, "WL", existingCodes);

          const workLoc = new Lookup({
            code: workLocCode,
            lookupname: workLocation,
            DisplayName: workLocation,
            Parentlookupid: branchId,
            lookuptypeId: workLocTypeId,
            isdeleted: false,
            isactive: true,
            userid: defaultUserId,
          });

          await workLoc.save();
          seededData.push({
            type: "Work Location",
            name: workLocation,
            code: workLocCode,
            parent: branchData.branch,
          });

          console.log(
            `🏢 Seeded work location: ${workLocation} (${workLocCode}) under ${branchData.branch}`
          );
        }
      }
    }

    console.log(`✅ Successfully seeded ${seededData.length} location records`);
    return seededData;
  } catch (error) {
    console.error("❌ Error seeding location hierarchy:", error);
    throw error;
  }
}

/**
 * Verify seeded data
 */
async function verifySeededData() {
  try {
    const { regionTypeId, branchTypeId, workLocTypeId } =
      await getLookupTypeIds();

    const regionCount = await Lookup.countDocuments({
      lookuptypeId: regionTypeId,
      isdeleted: false,
    });

    const branchCount = await Lookup.countDocuments({
      lookuptypeId: branchTypeId,
      isdeleted: false,
    });

    const workLocCount = await Lookup.countDocuments({
      lookuptypeId: workLocTypeId,
      isdeleted: false,
    });

    console.log(`📊 Total active records in database:`);
    console.log(`  Regions: ${regionCount}`);
    console.log(`  Branches: ${branchCount}`);
    console.log(`  Work Locations: ${workLocCount}`);

    // Show sample data with hierarchy
    console.log("\n📋 Sample hierarchy:");

    const regions = await Lookup.find({
      lookuptypeId: regionTypeId,
      isdeleted: false,
    })
      .populate("lookuptypeId")
      .limit(3);

    for (const region of regions) {
      console.log(`📍 ${region.lookupname} (${region.code})`);

      const branches = await Lookup.find({
        lookuptypeId: branchTypeId,
        Parentlookupid: region._id,
        isdeleted: false,
      }).limit(3);

      for (const branch of branches) {
        console.log(`  🏪 ${branch.lookupname} (${branch.code})`);

        const workLocs = await Lookup.find({
          lookuptypeId: workLocTypeId,
          Parentlookupid: branch._id,
          isdeleted: false,
        }).limit(3);

        for (const workLoc of workLocs) {
          console.log(`    🏢 ${workLoc.lookupname} (${workLoc.code})`);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error verifying data:", error);
    throw error;
  }
}

/**
 * Main seeding function
 */
async function main() {
  try {
    console.log("🚀 Starting Location Hierarchy Seeding Process");
    console.log("==============================================");

    await connectToDatabase();
    await clearExistingLocationData();
    await seedLocationHierarchy();
    await verifySeededData();

    console.log("==============================================");
    console.log("✅ Location hierarchy seeding completed successfully!");
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// Run the seeding process
if (require.main === module) {
  main();
}

module.exports = {
  seedLocationHierarchy,
  clearExistingLocationData,
  verifySeededData,
};
