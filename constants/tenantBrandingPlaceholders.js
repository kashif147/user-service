/**
 * Default branding asset paths (match frontend public/branding SVGs).
 * Set BRANDING_ASSETS_BASE_URL for absolute URLs in emails (e.g. https://your-portal.com).
 */
const ASSET_BASE = (process.env.BRANDING_ASSETS_BASE_URL || "").replace(
  /\/$/,
  ""
);

const asset = (file) =>
  ASSET_BASE ? `${ASSET_BASE}/branding/${file}` : `/branding/${file}`;

const PLACEHOLDER_LOGOS = {
  logoUrl: asset("logo.svg"),
  logoDarkUrl: asset("logo-dark.svg"),
  faviconUrl: asset("favicon.svg"),
  letterHeaderUrl: asset("letter-header.svg"),
  letterFooterUrl: asset("letter-footer.svg"),
};

const applyBrandingPlaceholders = (branding = {}) => ({
  ...PLACEHOLDER_LOGOS,
  ...branding,
  logoUrl: branding.logoUrl || PLACEHOLDER_LOGOS.logoUrl,
  logoDarkUrl: branding.logoDarkUrl || PLACEHOLDER_LOGOS.logoDarkUrl,
  faviconUrl: branding.faviconUrl || PLACEHOLDER_LOGOS.faviconUrl,
  letterHeaderUrl: branding.letterHeaderUrl || PLACEHOLDER_LOGOS.letterHeaderUrl,
  letterFooterUrl: branding.letterFooterUrl || PLACEHOLDER_LOGOS.letterFooterUrl,
});

module.exports = {
  PLACEHOLDER_LOGOS,
  applyBrandingPlaceholders,
  asset,
};
