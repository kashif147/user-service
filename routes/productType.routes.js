const express = require("express");
const router = express.Router();
const productTypeController = require("../controllers/productType.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

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
