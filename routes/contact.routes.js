const express = require("express");
const router = express.Router();
const contactController = require("../controllers/contact.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");

/**
 * Contact API Routes
 *
 * All routes require authentication and appropriate permissions
 * based on the policy adapter middleware
 */

// Get all contacts
router.get(
  "/contacts",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactController.getAllContacts
);

// Search contacts
router.get(
  "/contacts/search",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactController.searchContacts
);

// Get single contact by ID
router.get(
  "/contacts/:id",
  defaultPolicyAdapter.middleware("contact", "read"),
  contactController.getContactById
);

// Create new contact
// Phase A / A-5 review: contacts are business data with no tenantId yet (shared by every tenant) -
// writes are frozen (423) until their tenancy migration. Reads are unchanged.
router.post(
  "/contacts",
  freezeGlobalWrites("contact"),
  defaultPolicyAdapter.middleware("contact", "write"),
  contactController.createContact
);

// Update contact
router.put(
  "/contacts/:id",
  freezeGlobalWrites("contact"),
  defaultPolicyAdapter.middleware("contact", "write"),
  contactController.updateContact
);

// Delete contact
router.delete(
  "/contacts/:id",
  freezeGlobalWrites("contact"),
  defaultPolicyAdapter.middleware("contact", "delete"),
  contactController.deleteContact
);

module.exports = router;
