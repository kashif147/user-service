const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { ensureAuthenticated } = require("../middlewares/auth.mw");
router.post("/microsoft", authController.handleMicrosoftCallback);

module.exports = router;
