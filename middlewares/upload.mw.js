const multer = require("multer");

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
]);

const brandingAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files (PNG, JPEG, WebP, SVG, GIF) are allowed"));
  },
}).single("file");

const brandingAssetUploadMw = (req, res, next) => {
  brandingAssetUpload(req, res, (err) => {
    if (err) {
      err.status = err.status || 400;
      return next(err);
    }
    next();
  });
};

module.exports = {
  brandingAssetUpload,
  brandingAssetUploadMw,
  ALLOWED_IMAGE_TYPES,
};
