const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// User registration and login endpoints (no auth required)
router.post("/users/register", UserController.handleRegistration);
router.post("/users/login", UserController.handleLogin);

// Public user endpoints (no auth required)
router.get("/users/by-email/:email", UserController.getUserByEmail);

// Protected user management endpoints (require authentication)
router.use(authenticate);
router.use(requireTenant);

module.exports = router;
