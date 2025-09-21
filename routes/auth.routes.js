const express = require("express");
const router = express.Router();
const b2cUsersController = require("../controllers/b2c.users.controller");
const azureADController = require("../controllers/azure.ad.controller");
const userController = require("../controllers/user.controller");
const authController = require("../controllers/auth.controller");
const { authenticate } = require("../middlewares/auth");

// Azure AD routes - handle both GET (redirect) and POST (callback)
router.get("/azure-crm", azureADController.handleAzureADRedirect);
router.post("/azure-crm", azureADController.handleAzureADCallback);

// Azure B2C routes - handle both GET (redirect) and POST (callback)
router.get("/azure-portal", b2cUsersController.handleMicrosoftRedirect);
router.post("/azure-portal", b2cUsersController.handleMicrosoftCallback);

router.post("/general-crm/register", userController.handleRegistration);
router.post("/general-crm/login", userController.handleLogin);

// Token refresh endpoint
router.post("/refresh", authController.refreshToken);

// Logout endpoint (requires authentication)
router.post("/logout", authenticate, authController.logout);

// Token revocation endpoints
router.post("/revoke", authController.revokeToken);
router.post("/revoke-all", authController.revokeAllTokens);

module.exports = router;
