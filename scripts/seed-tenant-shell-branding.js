/**
 * Persist Project Shell default colours onto every tenant's branding subdocument.
 * Run: NODE_ENV=staging node scripts/seed-tenant-shell-branding.js
 */

require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const mongoose = require("mongoose");
const Tenant = require("../models/tenant.model");
const { SHELL_BRANDING } = require("../constants/shellBranding");
const { PLACEHOLDER_LOGOS } = require("../constants/tenantBrandingPlaceholders");

const MONGO_URI =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

async function main() {
  if (!MONGO_URI) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const { secondaryBackgroundColor, ...brandingColors } = SHELL_BRANDING;

  const result = await Tenant.updateMany(
    {},
    {
      $set: {
        "branding.primaryColor": brandingColors.primaryColor,
        "branding.secondaryColor": brandingColors.secondaryColor,
        "branding.accentColor": brandingColors.accentColor,
        "branding.secondaryBackgroundColor": secondaryBackgroundColor,
        "branding.portalTitle": brandingColors.portalTitle,
        "branding.logoUrl": PLACEHOLDER_LOGOS.logoUrl,
        "branding.logoDarkUrl": PLACEHOLDER_LOGOS.logoDarkUrl,
        "branding.faviconUrl": PLACEHOLDER_LOGOS.faviconUrl,
        "branding.letterHeaderUrl": PLACEHOLDER_LOGOS.letterHeaderUrl,
        "branding.letterFooterUrl": PLACEHOLDER_LOGOS.letterFooterUrl,
      },
    }
  );

  console.log(
    `Updated ${result.modifiedCount} tenant(s) (matched ${result.matchedCount}) with shell branding colours and default assets:`,
    { ...SHELL_BRANDING, assets: PLACEHOLDER_LOGOS }
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
