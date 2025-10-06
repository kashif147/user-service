const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.staging`,
});

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

function parseDate(dateStr) {
  if (!dateStr || dateStr instanceof Date) return dateStr;

  // Handle formats like "1/1/25" or "31/12/2025"
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    let day = parseInt(parts[0]);
    let month = parseInt(parts[1]) - 1; // Month is 0-indexed
    let year = parseInt(parts[2]);

    // Handle 2-digit years
    if (year < 100) {
      year = year + 2000;
    }

    return new Date(year, month, day);
  }

  // Try standard date parsing
  return new Date(dateStr);
}

async function fixPricingDates() {
  try {
    console.log("Connecting to Staging MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to Staging MongoDB\n");

    const db = mongoose.connection.db;
    const pricingCollection = db.collection("pricings");

    // Find all pricing documents
    const pricingDocs = await pricingCollection.find({}).toArray();
    console.log(`Found ${pricingDocs.length} pricing documents\n`);

    let fixed = 0;

    for (const doc of pricingDocs) {
      const updates = {};
      let needsUpdate = false;

      // Fix effectiveFrom if it's a string
      if (doc.effectiveFrom && typeof doc.effectiveFrom === "string") {
        updates.effectiveFrom = parseDate(doc.effectiveFrom);
        needsUpdate = true;
        console.log(
          `${doc._id}: effectiveFrom "${doc.effectiveFrom}" -> ${updates.effectiveFrom}`
        );
      }

      // Fix effectiveTo if it's a string
      if (doc.effectiveTo && typeof doc.effectiveTo === "string") {
        updates.effectiveTo = parseDate(doc.effectiveTo);
        needsUpdate = true;
        console.log(
          `${doc._id}: effectiveTo "${doc.effectiveTo}" -> ${updates.effectiveTo}`
        );
      }

      if (needsUpdate) {
        await pricingCollection.updateOne({ _id: doc._id }, { $set: updates });
        fixed++;
        console.log(`✅ Fixed pricing ${doc._id}\n`);
      }
    }

    console.log(`\n✅ Fixed ${fixed} pricing documents`);

    // Verify
    console.log("\n--- Verification ---");
    const stringDates = await pricingCollection.countDocuments({
      $or: [
        { effectiveFrom: { $type: "string" } },
        { effectiveTo: { $type: "string" } },
      ],
    });
    console.log(`Remaining pricing docs with string dates: ${stringDates}`);
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await mongoose.connection.close();
    console.log("\n✅ Disconnected from MongoDB");
  }
}

fixPricingDates();
