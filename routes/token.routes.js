const express = require("express");
const router = express.Router();
const tokenController = require("../controllers/token.controller");

// Token inspection endpoints (for testing)
router.post("/decode-token", tokenController.decodeToken);
router.get("/validate-jwt", tokenController.validateInternalJWT);

module.exports = router;
