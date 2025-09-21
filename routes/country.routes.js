const express = require("express");
const router = express.Router();
const countryController = require("../controllers/country.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

/**
 * Country API Routes
 *
 * All routes require authentication and appropriate permissions
 * based on the policy adapter middleware
 */

// Apply authentication to all routes
router.use(defaultPolicyAdapter.middleware("lookup", "read"));

// Get all countries
router.get("/", countryController.getAllCountries);

// Search countries
router.get("/search", countryController.searchCountries);

// Get country by code
router.get("/code/:code", countryController.getCountryByCode);

// Get single country by ID
router.get("/:id", countryController.getCountryById);

// Create new country (requires write permission)
router.post(
  "/",
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.createCountry
);

// Update country (requires write permission)
router.put(
  "/:id",
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.updateCountry
);

// Delete country (requires delete permission)
router.delete(
  "/:id",
  defaultPolicyAdapter.middleware("lookup", "delete"),
  countryController.deleteCountry
);

module.exports = router;
