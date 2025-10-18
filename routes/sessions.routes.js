const express = require("express");
const router = express.Router();
const sessionsController = require("../controllers/sessions.controller");

// POST /sessions - Create internal session from B2C ID token
router.post("/", sessionsController.createSession);

module.exports = router;
