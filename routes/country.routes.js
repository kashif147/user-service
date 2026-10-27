const express = require("express");
const router = express.Router();
const countryController = require("../controllers/country.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");

/**
 * Country API Routes
 *
 * All routes require authentication and appropriate permissions
 * based on the policy adapter middleware
 */

// Get all countries (must come first to avoid conflict with /:id)
router.get(
  "/countries",
  requireTrustedTenant,
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getAllCountries
);

// Search countries
router.get(
  "/countries/search",
  requireTrustedTenant,
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.searchCountries
);

// Get country by code
router.get(
  "/countries/code/:code",
  requireTrustedTenant,
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getCountryByCode
);

// Get single country by ID (must come last)
router.get(
  "/countries/:id",
  requireTrustedTenant,
  defaultPolicyAdapter.middleware("lookup", "read"),
  countryController.getCountryById
);

// Create new country (requires write permission)
// Phase A / A-5 review: countries are tenant-owned in the target design but still stored globally
// (no tenantId) until Phase E - every write would change all tenants' data, so writes are frozen (423).
router.post(
  "/countries",
  freezeGlobalWrites("country"),
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.createCountry
);

// Update country (requires write permission)
router.put(
  "/countries/:id",
  freezeGlobalWrites("country"),
  defaultPolicyAdapter.middleware("lookup", "write"),
  countryController.updateCountry
);

// Delete country (requires delete permission)
router.delete(
  "/countries/:id",
  freezeGlobalWrites("country"),
  defaultPolicyAdapter.middleware("lookup", "delete"),
  countryController.deleteCountry
);

module.exports = router;
