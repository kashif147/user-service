const express = require("express");
const router = express.Router();
const b2cUsersController = require("../controllers/b2c.users.controller");
const azureADController = require("../controllers/azure.ad.controller");
const userController = require("../controllers/user.controller");

router.post("/azure-portal", b2cUsersController.handleMicrosoftCallback);
router.post("/azure-crm", azureADController.handleAzureADCallback);
router.post("/general-crm/register", userController.handleRegistration);
router.post("/general-crm/login", userController.handleLogin);

module.exports = router;
