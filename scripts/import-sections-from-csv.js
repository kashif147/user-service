const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Lookup = require("../models/lookup.model");
const LookupType = require("../models/lookupType.model");

// Load environment variables based on NODE_ENV
if (process.env.NODE_ENV === "staging") {
  require("dotenv").config({ path: ".env.staging" });
} else if (process.env.NODE_ENV === "development") {
  require("dotenv").config({ path: ".env.development" });
} else {
  require("dotenv").config();
}

// Database connection
const connectDB = async () => {
  try {
    // Build connection string with environment variables
    const mongoUri =
      process.env.MONGO_URI ||
      `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@clusterprojectshell.tptnh8w.mongodb.net/${process.env.MONGO_DB}/?retryWrites=true&w=majority&appName=ClusterProjectShell`;

    console.log(
      `🔌 Connecting to ${process.env.NODE_ENV || "default"} environment...`
    );
    console.log(`📊 Database: ${mongoUri.split("/").pop().split("?")[0]}`);

    // Connection options for better Atlas connectivity
    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(mongoUri, options);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

// Import sections from CSV
const importSections = async () => {
  try {
    // Read CSV file
    const csvPath = path.join(__dirname, "../docs/sections.csv");
    const csvContent = fs.readFileSync(csvPath, "utf8");
    const lines = csvContent.trim().split("\n");

    // Skip header row
    const dataLines = lines.slice(1);

    console.log(`📋 Found ${dataLines.length} sections to import`);

    // Find the lookup types
    const primaryLookupType = await LookupType.findOne({ code: "PRI_SEC" });
    const secondaryLookupType = await LookupType.findOne({ code: "SEC_SEC" });

    if (!primaryLookupType) {
      throw new Error("Primary Section lookup type (PRI_SEC) not found");
    }
    if (!secondaryLookupType) {
      throw new Error("Secondary Section lookup type (SEC_SEC) not found");
    }

    console.log(
      `✅ Found Primary Section lookup type: ${primaryLookupType._id}`
    );
    console.log(
      `✅ Found Secondary Section lookup type: ${secondaryLookupType._id}`
    );

    // User ID for the import
    const userId = "681117cb357e50dfa229b2f2";

    // Clear existing section entries first
    console.log("🧹 Clearing existing section entries...");
    await Lookup.deleteMany({
      $or: [
        { lookuptypeId: primaryLookupType._id },
        { lookuptypeId: secondaryLookupType._id },
      ],
    });

    // Process and deduplicate sections
    const uniqueSections = new Map();

    for (let i = 0; i < dataLines.length; i++) {
      const line = dataLines[i].trim();
      if (!line) continue;

      const parts = line.split(",");
      if (parts.length < 2) continue;

      const primaryFlag = parts[0].trim();
      const sectionName = parts.slice(1).join(",").trim(); // Handle commas in section names

      if (!sectionName) continue; // Skip if no section name

      const isPrimary = primaryFlag.toLowerCase() === "yes";
      const key = `${isPrimary ? "PRI" : "SEC"}_${sectionName}`;

      // Only keep the first occurrence of each unique section
      if (!uniqueSections.has(key)) {
        uniqueSections.set(key, { sectionName, isPrimary });
      }
    }

    console.log(`📋 Found ${uniqueSections.size} unique sections to import`);

    // Import each unique section
    let importedCount = 0;
    let skippedCount = 0;
    let primaryCount = 0;
    let secondaryCount = 0;
    let primaryIndex = 1;
    let secondaryIndex = 1;

    for (const [key, section] of uniqueSections) {
      const { sectionName, isPrimary } = section;

      // Generate unique code (max 10 chars) with separate counters
      const prefix = isPrimary ? "PRI" : "SEC";
      const index = isPrimary ? primaryIndex : secondaryIndex;
      const code = `${prefix}-${String(index).padStart(3, "0")}`;

      // Determine lookup type ID
      const lookuptypeId = isPrimary
        ? primaryLookupType._id
        : secondaryLookupType._id;

      // Create new lookup
      const lookup = await Lookup.create({
        code,
        lookupname: sectionName,
        DisplayName: sectionName,
        lookuptypeId: lookuptypeId,
        isdeleted: false,
        isactive: true,
        userid: userId,
      });

      if (isPrimary) {
        primaryCount++;
        primaryIndex++;
      } else {
        secondaryCount++;
        secondaryIndex++;
      }

      if (importedCount % 1000 === 0) {
        console.log(
          `📊 Progress: ${importedCount}/${uniqueSections.size} imported`
        );
      }

      importedCount++;
    }

    console.log(`\n📊 Import Summary:`);
    console.log(`   ✅ Imported: ${importedCount}`);
    console.log(`   📋 Primary Sections: ${primaryCount}`);
    console.log(`   📋 Secondary Sections: ${secondaryCount}`);
    console.log(`   ⏭️  Skipped: ${skippedCount}`);
    console.log(`   📋 Total processed: ${dataLines.length}`);
  } catch (error) {
    console.error("❌ Import error:", error);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await importSections();
    console.log("\n🎉 Sections import completed successfully!");
  } catch (error) {
    console.error("❌ Script failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
    process.exit(0);
  }
};

// Run the script
if (require.main === module) {
  main();
}

module.exports = { importSections };
