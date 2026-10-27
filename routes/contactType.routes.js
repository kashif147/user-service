const express = require("express");
const router = express.Router();
const contactTypeController = require("../controllers/contactType.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");

/**
 * Contact Type API Routes
 *
 * All routes require authentication and appropriate permissions
 * based on the policy adapter middleware
 */

// Get all contact types
router.get(
  "/contact-types",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactTypeController.getAllContactTypes
);

// Search contact types
router.get(
  "/contact-types/search",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactTypeController.searchContactTypes
);

// Get single contact type by ID
router.get(
  "/contact-types/:id",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactTypeController.getContactTypeById
);

// Create new contact type
// Phase A / A-5 review: contact types are tenant-owned in the target design but still stored globally
// (no tenantId) until Phase E - writes are frozen (423) until the cutover. Reads are unchanged.
router.post(
  "/contact-types",
  freezeGlobalWrites("contactType"),
  defaultPolicyAdapter.middleware("contact", "write"),
  contactTypeController.createContactType
);

// Update contact type
router.put(
  "/contact-types/:id",
  freezeGlobalWrites("contactType"),
  defaultPolicyAdapter.middleware("contact", "write"),
  contactTypeController.updateContactType
);

// Delete contact type
router.delete(
  "/contact-types/:id",
  freezeGlobalWrites("contactType"),
  defaultPolicyAdapter.middleware("contact", "delete"),
  contactTypeController.deleteContactType
);

module.exports = router;
