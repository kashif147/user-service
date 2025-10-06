const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function fixObjectIdReferences() {
  try {
    console.log("Connecting to MongoDB...");
    console.log("URI:", MONGODB_URI ? "Found" : "Missing");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const db = mongoose.connection.db;

    // Fix Pricing collection - productId
    console.log("\n--- Fixing Pricing.productId ---");
    const pricingCollection = db.collection("pricings");
    const pricingDocs = await pricingCollection
      .find({ productId: { $type: "string" } })
      .toArray();

    console.log(
      `Found ${pricingDocs.length} pricing documents with string productId`
    );

    for (const doc of pricingDocs) {
      await pricingCollection.updateOne(
        { _id: doc._id },
        { $set: { productId: new mongoose.Types.ObjectId(doc.productId) } }
      );
      console.log(`Fixed productId for pricing: ${doc._id}`);
    }

    // Fix Pricing collection - createdBy
    console.log("\n--- Fixing Pricing.createdBy ---");
    const pricingCreatedBy = await pricingCollection
      .find({ createdBy: { $type: "string" } })
      .toArray();

    console.log(
      `Found ${pricingCreatedBy.length} pricing documents with string createdBy`
    );

    for (const doc of pricingCreatedBy) {
      await pricingCollection.updateOne(
        { _id: doc._id },
        { $set: { createdBy: new mongoose.Types.ObjectId(doc.createdBy) } }
      );
      console.log(`Fixed createdBy for pricing: ${doc._id}`);
    }

    // Fix Pricing collection - updatedBy
    console.log("\n--- Fixing Pricing.updatedBy ---");
    const pricingUpdatedBy = await pricingCollection
      .find({ updatedBy: { $type: "string", $ne: null } })
      .toArray();

    console.log(
      `Found ${pricingUpdatedBy.length} pricing documents with string updatedBy`
    );

    for (const doc of pricingUpdatedBy) {
      if (doc.updatedBy) {
        await pricingCollection.updateOne(
          { _id: doc._id },
          { $set: { updatedBy: new mongoose.Types.ObjectId(doc.updatedBy) } }
        );
        console.log(`Fixed updatedBy for pricing: ${doc._id}`);
      }
    }

    // Fix Product collection - productTypeId
    console.log("\n--- Fixing Product.productTypeId ---");
    const productCollection = db.collection("products");
    const productDocs = await productCollection
      .find({ productTypeId: { $type: "string" } })
      .toArray();

    console.log(
      `Found ${productDocs.length} product documents with string productTypeId`
    );

    for (const doc of productDocs) {
      await productCollection.updateOne(
        { _id: doc._id },
        {
          $set: {
            productTypeId: new mongoose.Types.ObjectId(doc.productTypeId),
          },
        }
      );
      console.log(`Fixed productTypeId for product: ${doc._id}`);
    }

    // Fix Product collection - createdBy
    console.log("\n--- Fixing Product.createdBy ---");
    const productCreatedBy = await productCollection
      .find({ createdBy: { $type: "string" } })
      .toArray();

    console.log(
      `Found ${productCreatedBy.length} product documents with string createdBy`
    );

    for (const doc of productCreatedBy) {
      await productCollection.updateOne(
        { _id: doc._id },
        { $set: { createdBy: new mongoose.Types.ObjectId(doc.createdBy) } }
      );
      console.log(`Fixed createdBy for product: ${doc._id}`);
    }

    // Fix Product collection - updatedBy
    console.log("\n--- Fixing Product.updatedBy ---");
    const productUpdatedBy = await productCollection
      .find({ updatedBy: { $type: "string", $ne: null } })
      .toArray();

    console.log(
      `Found ${productUpdatedBy.length} product documents with string updatedBy`
    );

    for (const doc of productUpdatedBy) {
      if (doc.updatedBy) {
        await productCollection.updateOne(
          { _id: doc._id },
          { $set: { updatedBy: new mongoose.Types.ObjectId(doc.updatedBy) } }
        );
        console.log(`Fixed updatedBy for product: ${doc._id}`);
      }
    }

    // Fix ProductType collection - createdBy
    console.log("\n--- Fixing ProductType.createdBy ---");
    const productTypeCollection = db.collection("producttypes");
    const productTypeCreatedBy = await productTypeCollection
      .find({ createdBy: { $type: "string" } })
      .toArray();

    console.log(
      `Found ${productTypeCreatedBy.length} productType documents with string createdBy`
    );

    for (const doc of productTypeCreatedBy) {
      await productTypeCollection.updateOne(
        { _id: doc._id },
        { $set: { createdBy: new mongoose.Types.ObjectId(doc.createdBy) } }
      );
      console.log(`Fixed createdBy for productType: ${doc._id}`);
    }

    // Fix ProductType collection - updatedBy
    console.log("\n--- Fixing ProductType.updatedBy ---");
    const productTypeUpdatedBy = await productTypeCollection
      .find({ updatedBy: { $type: "string", $ne: null } })
      .toArray();

    console.log(
      `Found ${productTypeUpdatedBy.length} productType documents with string updatedBy`
    );

    for (const doc of productTypeUpdatedBy) {
      if (doc.updatedBy) {
        await productTypeCollection.updateOne(
          { _id: doc._id },
          { $set: { updatedBy: new mongoose.Types.ObjectId(doc.updatedBy) } }
        );
        console.log(`Fixed updatedBy for productType: ${doc._id}`);
      }
    }

    console.log("\n✅ All ObjectId references fixed successfully!");

    // Verify
    console.log("\n--- Verification ---");
    const pricingStringCount = await pricingCollection.countDocuments({
      productId: { $type: "string" },
    });
    const productStringCount = await productCollection.countDocuments({
      productTypeId: { $type: "string" },
    });

    console.log(
      `Remaining pricing docs with string productId: ${pricingStringCount}`
    );
    console.log(
      `Remaining product docs with string productTypeId: ${productStringCount}`
    );
  } catch (error) {
    console.error("Error fixing ObjectId references:", error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log("\nDisconnected from MongoDB");
  }
}

fixObjectIdReferences();
