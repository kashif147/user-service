const express = require("express");
const router = express.Router();
const pkceController = require("../controllers/pkce.controller");

// PKCE generation endpoint
router.get("/generate", pkceController.generatePKCE);

// Front-channel logout URLs (Azure AD + B2C) - see getLogoutUrls' own doc comment
router.get("/logout-urls", pkceController.getLogoutUrls);

module.exports = router;
