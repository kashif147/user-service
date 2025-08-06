const express = require("express");
const router = express.Router();
const b2cUsersController = require("../controllers/b2c.users.controller");
router.post("/microsoft", b2cUsersController.handleMicrosoftCallback);

module.exports = router;
