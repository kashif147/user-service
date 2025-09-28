const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "staging"}`,
});

const ProductType = require("../models/productType.model");
const Product = require("../models/product.model");
const Pricing = require("../models/pricing.model");

async function connectToDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}

async function verifyProductManagementData() {
  try {
    console.log("🔍 Verifying Product Management Data...");

    await connectToDatabase();

    // Get all product types
    const productTypes = await ProductType.find({ isDeleted: false })
      .populate("createdBy", "firstName lastName email")
      .sort({ code: 1 });

    console.log(`\n📋 Product Types (${productTypes.length}):`);
    console.log("=".repeat(80));

    for (const productType of productTypes) {
      console.log(`\n🏷️  ${productType.name} (${productType.code})`);
      console.log(`   Description: ${productType.description}`);
      console.log(`   Status: ${productType.status}`);
      console.log(
        `   Created: ${productType.createdAt.toISOString().split("T")[0]}`
      );
      console.log(
        `   Created By: ${
          productType.createdBy
            ? productType.createdBy.firstName +
              " " +
              productType.createdBy.lastName
            : "N/A"
        }`
      );

      // Get products for this product type
      const products = await Product.find({
        productTypeId: productType._id,
        isDeleted: false,
      }).sort({ code: 1 });

      console.log(`   Products (${products.length}):`);

      for (const product of products) {
        // Get current pricing for this product
        const currentPricing = await Pricing.findOne({
          productId: product._id,
          isActive: true,
          isDeleted: false,
          effectiveFrom: { $lte: new Date() },
          $or: [{ effectiveTo: { $gte: new Date() } }, { effectiveTo: null }],
        }).sort({ effectiveFrom: -1 });

        const priceDisplay = currentPricing
          ? `${currentPricing.currency} ${currentPricing.price}`
          : "No pricing";

        console.log(
          `     • ${product.name} (${product.code}) - ${priceDisplay}`
        );
      }
    }

    // Summary statistics
    const totalProducts = await Product.countDocuments({ isDeleted: false });
    const totalPricing = await Pricing.countDocuments({ isDeleted: false });

    console.log("\n" + "=".repeat(80));
    console.log("📊 Summary Statistics:");
    console.log(`   Product Types: ${productTypes.length}`);
    console.log(`   Products: ${totalProducts}`);
    console.log(`   Pricing Records: ${totalPricing}`);

    // Check for products without pricing
    const productsWithoutPricing = await Product.aggregate([
      { $match: { isDeleted: false } },
      {
        $lookup: {
          from: "pricings",
          localField: "_id",
          foreignField: "productId",
          as: "pricing",
        },
      },
      { $match: { pricing: { $size: 0 } } },
    ]);

    if (productsWithoutPricing.length > 0) {
      console.log(
        `\n⚠️  Products without pricing: ${productsWithoutPricing.length}`
      );
      productsWithoutPricing.forEach((product) => {
        console.log(`   • ${product.name} (${product.code})`);
      });
    } else {
      console.log("\n✅ All products have pricing records");
    }

    // Check for overlapping pricing periods
    const overlappingPricing = await Pricing.aggregate([
      { $match: { isDeleted: false } },
      {
        $lookup: {
          from: "pricings",
          let: {
            productId: "$productId",
            effectiveFrom: "$effectiveFrom",
            effectiveTo: "$effectiveTo",
            currentId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$productId"] },
                    { $ne: ["$_id", "$$currentId"] },
                    { $eq: ["$isDeleted", false] },
                    {
                      $or: [
                        {
                          $and: [
                            { $lte: ["$effectiveFrom", "$$effectiveTo"] },
                            { $gte: ["$effectiveTo", "$$effectiveFrom"] },
                          ],
                        },
                        {
                          $and: [
                            { $lte: ["$effectiveFrom", "$$effectiveTo"] },
                            { $eq: ["$effectiveTo", null] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: "overlaps",
        },
      },
      { $match: { overlaps: { $ne: [] } } },
    ]);

    if (overlappingPricing.length > 0) {
      console.log(
        `\n⚠️  Overlapping pricing periods found: ${overlappingPricing.length}`
      );
    } else {
      console.log("\n✅ No overlapping pricing periods found");
    }

    console.log("\n🎉 Verification completed successfully!");
  } catch (error) {
    console.error("❌ Verification failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// Run the verification
if (require.main === module) {
  verifyProductManagementData();
}

module.exports = { verifyProductManagementData };
