const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// Apply tenant enforcement to all routes (authentication is applied globally)
router.use(requireTenant);

// User registration and login endpoints
router.post(
  "/users/register",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.handleRegistration
);
router.post("/users/login", UserController.handleLogin);

module.exports = router;
