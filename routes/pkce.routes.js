const express = require("express");
const router = express.Router();
const pkceController = require("../controllers/pkce.controller");

// PKCE generation endpoint
router.get("/generate", pkceController.generatePKCE);

module.exports = router;
