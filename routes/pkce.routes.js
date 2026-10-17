const express = require("express");
const router = express.Router();
const pkceController = require("../controllers/pkce.controller");
const { createLoginStartRateLimit } = require("../middlewares/loginStartRateLimit");

// Sign-in start limit (per client IP; runs before the organisation locator is resolved)
const loginStartRateLimit = createLoginStartRateLimit();

// PKCE generation endpoint
router.get("/generate", ...loginStartRateLimit, pkceController.generatePKCE);

// Front-channel logout URLs (Azure AD + B2C) - see getLogoutUrls' own doc comment
router.get("/logout-urls", pkceController.getLogoutUrls);

module.exports = router;
