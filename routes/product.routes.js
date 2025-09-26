const express = require("express");
const router = express.Router();
const productController = require("../controllers/product.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

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
