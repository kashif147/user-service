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

// Get all countries (must come first to avoid conflict with /:id)
router.get(
  "/countries",
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getAllCountries
);

// Search countries
router.get(
  "/countries/search",
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.searchCountries
);

// Get country by code
router.get(
  "/countries/code/:code",
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getCountryByCode
);

// Get single country by ID (must come last)
router.get(
  "/countries/:id",
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getCountryById
);

// Create new country (requires write permission)
router.post(
  "/countries",
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.createCountry
);

// Update country (requires write permission)
router.put(
  "/countries/:id",
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.updateCountry
);

// Delete country (requires delete permission)
router.delete(
  "/countries/:id",
  defaultPolicyAdapter.middleware("lookup", "delete"),
  countryController.deleteCountry
);

module.exports = router;
