/**
 * Set default membership branding asset paths on all tenants (replaces picsum placeholders).
 * Run: NODE_ENV=staging node scripts/seed-tenant-default-branding-assets.js
 */

require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const mongoose = require("mongoose");
const Tenant = require("../models/tenant.model");
const { PLACEHOLDER_LOGOS } = require("../constants/tenantBrandingPlaceholders");

const MONGO_URI =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

async function main() {
  if (!MONGO_URI) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const result = await Tenant.updateMany(
    {},
    {
      $set: {
        "branding.logoUrl": PLACEHOLDER_LOGOS.logoUrl,
        "branding.logoDarkUrl": PLACEHOLDER_LOGOS.logoDarkUrl,
        "branding.faviconUrl": PLACEHOLDER_LOGOS.faviconUrl,
        "branding.letterHeaderUrl": PLACEHOLDER_LOGOS.letterHeaderUrl,
        "branding.letterFooterUrl": PLACEHOLDER_LOGOS.letterFooterUrl,
      },
    }
  );

  console.log(
    `Set default branding assets on ${result.modifiedCount} tenant(s):`,
    PLACEHOLDER_LOGOS
  );
  console.log(
    "Tip: set BRANDING_ASSETS_BASE_URL in .env for absolute URLs in emails (e.g. your portal origin)."
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
