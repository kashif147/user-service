require("dotenv").config({ path: ".env.staging" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");

async function getSystemUserEmails() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("❌ MONGO_URI not found in .env.staging");
      return;
    }

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to staging MongoDB");

    // Find SU and ASU roles
    const suRole = await Role.findOne({ code: "SU", isActive: true });
    const asuRole = await Role.findOne({ code: "ASU", isActive: true });

    console.log("\n🔐 SUPER USER (SU) EMAILS:");
    console.log("=".repeat(50));

    if (suRole) {
      const suUsers = await User.find({ roles: suRole._id }).select(
        "userEmail userFullName tenantId"
      );

      if (suUsers.length === 0) {
        console.log("❌ No SU users found");
      } else {
        suUsers.forEach((user, index) => {
          console.log(
            `${index + 1}. ${user.userEmail} (${
              user.userFullName || "N/A"
            }) - Tenant: ${user.tenantId}`
          );
        });
      }
    } else {
      console.log("❌ SU role not found");
    }

    console.log("\n🔧 ASSISTANT SUPER USER (ASU) EMAILS:");
    console.log("=".repeat(50));

    if (asuRole) {
      const asuUsers = await User.find({ roles: asuRole._id }).select(
        "userEmail userFullName tenantId"
      );

      if (asuUsers.length === 0) {
        console.log("❌ No ASU users found");
      } else {
        asuUsers.forEach((user, index) => {
          console.log(
            `${index + 1}. ${user.userEmail} (${
              user.userFullName || "N/A"
            }) - Tenant: ${user.tenantId}`
          );
        });
      }
    } else {
      console.log("❌ ASU role not found");
    }

    // Quick summary
    console.log("\n📊 QUICK SUMMARY:");
    console.log("=".repeat(50));
    console.log(
      `SU Users: ${
        suRole ? await User.countDocuments({ roles: suRole._id }) : 0
      }`
    );
    console.log(
      `ASU Users: ${
        asuRole ? await User.countDocuments({ roles: asuRole._id }) : 0
      }`
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

getSystemUserEmails();
