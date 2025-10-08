const express = require("express");
const router = express.Router();
const contactController = require("../controllers/contact.controller");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

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
router.post(
  "/contacts",
  defaultPolicyAdapter.middleware("contact", "write"),
  contactController.createContact
);

// Update contact
router.put(
  "/contacts/:id",
  defaultPolicyAdapter.middleware("contact", "write"),
  contactController.updateContact
);

// Delete contact
router.delete(
  "/contacts/:id",
  defaultPolicyAdapter.middleware("contact", "delete"),
  contactController.deleteContact
);

module.exports = router;
