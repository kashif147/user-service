const express = require("express");
const router = express.Router();
const b2cUsersController = require("../controllers/b2c.users.controller");
const azureADController = require("../controllers/azure.ad.controller");

router.post("/azure-portal", b2cUsersController.handleMicrosoftCallback);
router.post("/azure-crm", azureADController.handleAzureADCallback);
// router.post("/general", azureADController.handleAzureADB2CCallback);
module.exports = router;
