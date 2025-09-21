#!/usr/bin/env node

require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const mongoose = require("mongoose");
const User = require("./models/user.model");
const Role = require("./models/role.model");

async function verify() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const user = await User.findOne({
      userEmail: "fazalazim238@gmail.com",
      tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453",
    }).populate("roles");

    if (user) {
      console.log("User:", user.userEmail);
      console.log("Roles:", user.roles.map((r) => r.code).join(", "));
    } else {
      console.log("User not found");
    }

    const memberRole = await Role.findOne({
      code: "MEMBER",
      tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453",
    });
    const nonMemberRole = await Role.findOne({
      code: "NON-MEMBER",
      tenantId: "39866a06-30bc-4a89-80c6-9dd9357dd453",
    });

    console.log("MEMBER role exists:", !!memberRole);
    console.log("NON-MEMBER role exists:", !!nonMemberRole);

    if (memberRole) {
      console.log(
        "MEMBER role permissions:",
        memberRole.permissions.join(", ")
      );
    }
    if (nonMemberRole) {
      console.log(
        "NON-MEMBER role permissions:",
        nonMemberRole.permissions.join(", ")
      );
    }

    await mongoose.disconnect();
    console.log("✅ Disconnected");
  } catch (error) {
    console.error("Error:", error.message);
  }
}

verify();
