const express = require("express");
const router = express.Router();
const productController = require("../controllers/product.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");
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

// Product CRUD operations
router
  .route("/products")
  .get(
    defaultPolicyAdapter.middleware("product", "read"),
    productController.getAllProducts
  )
  .post(
    defaultPolicyAdapter.middleware("product", "write"),
    productController.createProduct
  );

// Get products by product type (drill-down functionality)
router
  .route("/products/by-type/:productTypeId")
  .get(
    defaultPolicyAdapter.middleware("product", "read"),
    productController.getProductsByType
  );

// Phase A / A10: products of a product type by the type's stable code (e.g. MEM), optionally one
// product by its code (?productCode=4080). Tenant from the trusted context only; a placeholder or
// malformed tenant is 400 TENANT_REQUIRED (requireTrustedTenant), same as the lookup by-code route.
router
  .route("/products/by-type-code/:typeCode")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("product", "read"),
    productController.getProductsByTypeCode
  );

router
  .route("/products/:id")
  .get(
    defaultPolicyAdapter.middleware("product", "read"),
    productController.getProduct
  )
  .put(
    defaultPolicyAdapter.middleware("product", "write"),
    productController.updateProduct
  )
  .delete(
    defaultPolicyAdapter.middleware("product", "delete"),
    productController.deleteProduct
  );

module.exports = router;
