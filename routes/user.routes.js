const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// User registration and login endpoints (no auth required)
router.post(
  "/users/register",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.handleRegistration
);
router.post("/users/login", UserController.handleLogin);

// Protected user management endpoints (require authentication)
router.use(authenticate);
router.use(requireTenant);

router.get(
  "/users/by-email/:email",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserByEmail
);

module.exports = router;
