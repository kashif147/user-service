const express = require("express");
const router = express.Router();
const pricingController = require("../controllers/pricing.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

// Pricing CRUD operations
router
  .route("/pricing")
  .get(
    defaultPolicyAdapter.middleware("pricing", "read"),
    pricingController.getAllPricing
  )
  .post(
    defaultPolicyAdapter.middleware("pricing", "write"),
    pricingController.createPricing
  );

// Get pricing by product
router
  .route("/pricing/by-product/:productId")
  .get(
    defaultPolicyAdapter.middleware("pricing", "read"),
    pricingController.getPricingByProduct
  );

// Get current pricing for a product
router
  .route("/pricing/current/:productId")
  .get(
    defaultPolicyAdapter.middleware("pricing", "read"),
    pricingController.getCurrentPricing
  );

router
  .route("/pricing/:id")
  .get(
    defaultPolicyAdapter.middleware("pricing", "read"),
    pricingController.getPricing
  )
  .put(
    defaultPolicyAdapter.middleware("pricing", "write"),
    pricingController.updatePricing
  )
  .delete(
    defaultPolicyAdapter.middleware("pricing", "delete"),
    pricingController.deletePricing
  );

module.exports = router;
