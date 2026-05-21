const crypto = require("crypto");
const azureBlob = require("../services/azure.blob.service");
const { AppError } = require("../errors/AppError");
const {
  PLACEHOLDER_LOGOS,
} = require("../constants/tenantBrandingPlaceholders");

const ASSET_FIELD_MAP = {
  logo: "logoUrl",
  logoDark: "logoDarkUrl",
  favicon: "faviconUrl",
  letterHeader: "letterHeaderUrl",
  letterFooter: "letterFooterUrl",
};

const sanitizeFilename = (name) =>
  (name || "asset")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || "asset";

module.exports.uploadBrandingAsset = async (req, res, next) => {
  try {
    const assetType = (req.body.assetType || req.query.assetType || "")
      .trim();
    const brandingField = ASSET_FIELD_MAP[assetType];

    if (!brandingField) {
      return next(
        AppError.badRequest(
          "Invalid assetType. Use: logo, logoDark, favicon, letterHeader, letterFooter"
        )
      );
    }

    if (!req.file?.buffer) {
      return next(AppError.badRequest("Image file is required"));
    }

    const tenantKey = req.params.id || "draft";
    const ext =
      req.file.originalname?.split(".").pop()?.toLowerCase() || "png";
    const safeExt = ["png", "jpg", "jpeg", "webp", "svg", "gif"].includes(ext)
      ? ext
      : "png";
    const blobPath = `tenant-branding/${tenantKey}/${assetType}-${crypto.randomUUID()}.${safeExt}`;

    if (!azureBlob.isConfigured) {
      return next(
        AppError.internalServerError(
          "Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
        )
      );
    }

    const url = await azureBlob.uploadToBlob(
      blobPath,
      req.file.buffer,
      req.file.mimetype,
      sanitizeFilename(req.file.originalname)
    );

    res.status(200).json({
      status: "success",
      data: {
        assetType,
        brandingField,
        url,
        blobPath,
      },
    });
  } catch (error) {
    return next(
      AppError.internalServerError(
        error.message || "Failed to upload branding asset"
      )
    );
  }
};

module.exports.getBrandingPlaceholders = (_req, res) => {
  res.status(200).json({
    status: "success",
    data: PLACEHOLDER_LOGOS,
  });
};
