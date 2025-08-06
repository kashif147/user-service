const express = require("express");
const router = express.Router();
// const { getAllEvents } = require("message-bus");

router.use("/auth", require("./auth.routes"));

// router.get("/events", (req, res) => {
//   const events = getAllEvents();
//   res.json({ events });
// });

module.exports = router;
