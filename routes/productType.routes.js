const express = require("express");
const router = express.Router();
const productTypeController = require("../controllers/productType.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const {
  authenticate,
  tenantContextWarn,
  requireTenant,
} = require("../middlewares/auth");

// Phase 1C: establish trusted authenticated tenant context explicitly at the
// router level (authenticate -> tenantContextWarn (WARN) -> requireTenant)
// instead of relying on an earlier sibling router mounted at /api having run
// first. tenantContextWarn stays in WARN mode (non-blocking) — unchanged.
router.use(authenticate, tenantContextWarn, requireTenant);

// Get all product types with products and pricing
router.get(
  "/product-types/with-products",
  defaultPolicyAdapter.middleware("product-type", "read"),
  productTypeController.getAllProductTypesWithProducts
);

// Product Type CRUD operations
router
  .route("/product-types")
  .get(
    defaultPolicyAdapter.middleware("product-type", "read"),
    productTypeController.getAllProductTypes
  )
  .post(
    defaultPolicyAdapter.middleware("product-type", "write"),
    productTypeController.createProductType
  );

router
  .route("/product-types/:id")
  .get(
    defaultPolicyAdapter.middleware("product-type", "read"),
    productTypeController.getProductType
  )
  .put(
    defaultPolicyAdapter.middleware("product-type", "write"),
    productTypeController.updateProductType
  )
  .delete(
    defaultPolicyAdapter.middleware("product-type", "delete"),
    productTypeController.deleteProductType
  );

module.exports = router;
