const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "staging"}`,
});

const ProductType = require("../models/productType.model");
const Product = require("../models/product.model");
const Pricing = require("../models/pricing.model");
const User = require("../models/user.model");

// Sample data for seeding
const sampleProductTypes = [
  {
    name: "Membership",
    code: "MEM",
    description: "Annual membership fees for different member categories",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Continuing Professional Development",
    code: "CPD",
    description: "Professional development courses and training programs",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Professional Events",
    code: "EVENTS",
    description: "Conferences, seminars, and networking events",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Professional Insurance",
    code: "INS",
    description: "Professional indemnity and liability insurance",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
];

const sampleProducts = [
  // Membership Products
  {
    name: "General (all grades)",
    code: "MEM-GEN",
    description: "Standard membership for all nursing grades",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Postgraduate Student",
    code: "MEM-PG",
    description: "Membership for postgraduate students",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Private nursing home",
    code: "MEM-PNH",
    description: "Membership for private nursing home staff",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Short-term/Relief (under 12 hrs/wk average)",
    code: "MEM-STR",
    description: "Membership for short-term and relief staff",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Affiliate members (non-practicing)",
    code: "MEM-AFF",
    description: "Membership for non-practicing affiliates",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Lecturing (employed in universities and IT institutes)",
    code: "MEM-LEC",
    description: "Membership for academic staff",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Associate (not currently employed as a nurse/midwife)",
    code: "MEM-ASS",
    description: "Associate membership for non-employed nurses",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Retired Associate",
    code: "MEM-RET",
    description: "Membership for retired nurses",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Undergraduate Student",
    code: "MEM-UG",
    description: "Membership for undergraduate students",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  // CPD Products
  {
    name: "Advanced Clinical Practice Course",
    code: "CPD-ACP",
    description: "Advanced clinical practice certification course",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Leadership in Healthcare",
    code: "CPD-LH",
    description: "Healthcare leadership development program",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Evidence-Based Practice Workshop",
    code: "CPD-EBP",
    description: "Workshop on evidence-based practice methodologies",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  // Events Products
  {
    name: "Annual Conference 2025",
    code: "EVENTS-CONF-2025",
    description: "Annual nursing and midwifery conference",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Regional Seminar Series",
    code: "EVENTS-SEM",
    description: "Regional professional development seminars",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Networking Evening",
    code: "EVENTS-NET",
    description: "Professional networking and social event",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  // Insurance Products
  {
    name: "Professional Indemnity Insurance",
    code: "INS-PI",
    description: "Professional indemnity insurance coverage",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
  {
    name: "Public Liability Insurance",
    code: "INS-PL",
    description: "Public liability insurance coverage",
    status: "Active",
    isActive: true,
    isDeleted: false,
  },
];

const samplePricing = [
  // Membership Pricing
  {
    currency: "EUR",
    price: 299,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // General
  {
    currency: "EUR",
    price: 228,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Postgraduate
  {
    currency: "EUR",
    price: 116,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Private nursing home
  {
    currency: "EUR",
    price: 75,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Short-term/Relief
  {
    currency: "EUR",
    price: 25,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Affiliate
  {
    currency: "EUR",
    price: 150,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Lecturing
  {
    currency: "EUR",
    price: 50,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Associate
  {
    currency: "EUR",
    price: 25,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Retired
  {
    currency: "EUR",
    price: 0,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Undergraduate (free)

  // CPD Pricing
  {
    currency: "EUR",
    price: 450,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Advanced Clinical Practice
  {
    currency: "EUR",
    price: 350,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Leadership
  {
    currency: "EUR",
    price: 200,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Evidence-Based Practice

  // Events Pricing
  {
    currency: "EUR",
    price: 180,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Annual Conference
  {
    currency: "EUR",
    price: 80,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Regional Seminar
  {
    currency: "EUR",
    price: 40,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Networking Evening

  // Insurance Pricing
  {
    currency: "EUR",
    price: 120,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Professional Indemnity
  {
    currency: "EUR",
    price: 80,
    effectiveFrom: "2025-01-01",
    effectiveTo: "2025-12-31",
  }, // Public Liability
];

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

async function getSystemUser() {
  try {
    // Try to find a system user or create one
    let systemUser = await User.findOne({
      email: "system@user-service.com",
      userType: "SYSTEM",
    });

    if (!systemUser) {
      // Create a system user for seeding
      systemUser = await User.create({
        email: "system@user-service.com",
        firstName: "System",
        lastName: "User",
        userType: "SYSTEM",
        tenantId: "system-tenant",
        isActive: true,
        isDeleted: false,
      });
      console.log("✅ Created system user for seeding");
    }

    return systemUser;
  } catch (error) {
    console.error("❌ Error getting system user:", error);
    throw error;
  }
}

async function seedProductTypes(systemUser, tenantId) {
  console.log("🌱 Seeding Product Types...");

  const createdProductTypes = [];

  for (const productTypeData of sampleProductTypes) {
    try {
      // Check if product type already exists
      const existingProductType = await ProductType.findOne({
        code: productTypeData.code,
        tenantId,
        isDeleted: false,
      });

      if (existingProductType) {
        console.log(
          `⏭️  Product Type ${productTypeData.code} already exists, skipping`
        );
        createdProductTypes.push(existingProductType);
        continue;
      }

      const productType = await ProductType.create({
        ...productTypeData,
        createdBy: systemUser._id,
        tenantId,
      });

      createdProductTypes.push(productType);
      console.log(
        `✅ Created Product Type: ${productType.name} (${productType.code})`
      );
    } catch (error) {
      console.error(
        `❌ Error creating Product Type ${productTypeData.code}:`,
        error.message
      );
    }
  }

  return createdProductTypes;
}

async function seedProducts(productTypes, systemUser, tenantId) {
  console.log("🌱 Seeding Products...");

  const createdProducts = [];
  let productIndex = 0;

  for (const productType of productTypes) {
    const productsForType = sampleProducts.slice(
      productIndex,
      productIndex + getProductCountForType(productType.code)
    );

    for (const productData of productsForType) {
      try {
        // Check if product already exists
        const existingProduct = await Product.findOne({
          code: productData.code,
          tenantId,
          isDeleted: false,
        });

        if (existingProduct) {
          console.log(
            `⏭️  Product ${productData.code} already exists, skipping`
          );
          createdProducts.push(existingProduct);
          continue;
        }

        const product = await Product.create({
          ...productData,
          productTypeId: productType._id,
          createdBy: systemUser._id,
          tenantId,
        });

        createdProducts.push(product);
        console.log(`✅ Created Product: ${product.name} (${product.code})`);
      } catch (error) {
        console.error(
          `❌ Error creating Product ${productData.code}:`,
          error.message
        );
      }
    }

    productIndex += getProductCountForType(productType.code);
  }

  return createdProducts;
}

function getProductCountForType(productTypeCode) {
  const counts = {
    MEM: 9, // Membership products
    CPD: 3, // CPD products
    EVENTS: 3, // Events products
    INS: 2, // Insurance products
  };
  return counts[productTypeCode] || 0;
}

async function seedPricing(products, systemUser, tenantId) {
  console.log("🌱 Seeding Pricing...");

  for (let i = 0; i < products.length && i < samplePricing.length; i++) {
    const product = products[i];
    const pricingData = samplePricing[i];

    try {
      // Check if pricing already exists for this product
      const existingPricing = await Pricing.findOne({
        productId: product._id,
        tenantId,
        isDeleted: false,
      });

      if (existingPricing) {
        console.log(
          `⏭️  Pricing for Product ${product.code} already exists, skipping`
        );
        continue;
      }

      const pricing = await Pricing.create({
        ...pricingData,
        productId: product._id,
        effectiveFrom: new Date(pricingData.effectiveFrom),
        effectiveTo: new Date(pricingData.effectiveTo),
        status: "Active",
        isActive: true,
        isDeleted: false,
        createdBy: systemUser._id,
        tenantId,
      });

      console.log(
        `✅ Created Pricing: ${pricing.currency} ${pricing.price} for ${product.name}`
      );
    } catch (error) {
      console.error(
        `❌ Error creating Pricing for Product ${product.code}:`,
        error.message
      );
    }
  }
}

async function seedProductManagement() {
  try {
    console.log("🚀 Starting Product Management Data Seeding...");

    await connectToDatabase();

    // Get system user
    const systemUser = await getSystemUser();
    const tenantId = systemUser.tenantId || "system-tenant";

    console.log(`📋 Using Tenant ID: ${tenantId}`);
    console.log(`👤 Using System User: ${systemUser.email}`);

    // Seed Product Types
    const productTypes = await seedProductTypes(systemUser, tenantId);
    console.log(`✅ Seeded ${productTypes.length} Product Types`);

    // Seed Products
    const products = await seedProducts(productTypes, systemUser, tenantId);
    console.log(`✅ Seeded ${products.length} Products`);

    // Seed Pricing
    await seedPricing(products, systemUser, tenantId);
    console.log(`✅ Seeded Pricing for ${products.length} Products`);

    console.log("🎉 Product Management Data Seeding Completed Successfully!");

    // Summary
    console.log("\n📊 Seeding Summary:");
    console.log(`- Product Types: ${productTypes.length}`);
    console.log(`- Products: ${products.length}`);
    console.log(`- Pricing Records: ${products.length}`);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// Run the seeding
if (require.main === module) {
  seedProductManagement();
}

module.exports = { seedProductManagement };
