/** Stable placeholder branding URLs when tenant has no uploaded assets yet. */
const PLACEHOLDER_LOGOS = {
  logoUrl: "https://picsum.photos/seed/projectshell-logo/240/80",
  logoDarkUrl: "https://picsum.photos/seed/projectshell-logo-dark/240/80",
  faviconUrl: "https://picsum.photos/seed/projectshell-favicon/64/64",
  letterHeaderUrl: "https://picsum.photos/seed/projectshell-letter-header/800/120",
  letterFooterUrl: "https://picsum.photos/seed/projectshell-letter-footer/800/80",
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
};
