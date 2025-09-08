const express = require("express");
const router = express.Router();
const tokenController = require("../controllers/token.controller");

// Token inspection endpoints (for testing)
router.post("/decode-token", tokenController.decodeToken);
router.get("/validate-jwt", tokenController.validateInternalJWT);

// External service integration endpoints
router.get("/validate", tokenController.validateTokenForService);
router.post("/generate-test", tokenController.generateTestToken);

module.exports = router;
