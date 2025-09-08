const express = require("express");
const router = express.Router();

router.use("/auth", require("./auth.routes"));
router.use("/token", require("./token.routes"));
router.use("/pkce", require("./pkce.routes"));

// Role management API routes (for ProjectShell-1 to consume)
router.use("/api", require("./role.routes"));

module.exports = router;
