const mongoose = require("mongoose");
require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

const User = require("./models/user");
const Role = require("./models/role");

async function assignSuperUserRole() {
  try {
    // Connection options for better Atlas connectivity
    const options = {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    };

    await mongoose.connect(process.env.MONGO_URI, options);
    console.log("Connected to MongoDB");

    // Get the Super User role
    const superUserRole = await Role.findOne({ code: "SU" });
    if (!superUserRole) {
      console.log("❌ Super User role not found");
      return;
    }
    console.log("✅ Found Super User role:", superUserRole.name);

    // Users to assign Super User role
    const userEmails = [
      "shahab@creativelab147outlook.onmicrosoft.com",
      "kashif@creativelab147outlook.onmicrosoft.com",
    ];

    for (const email of userEmails) {
      const user = await User.findOne({ userEmail: email });
      if (user) {
        console.log(`\n👤 Processing user: ${email}`);
        console.log(`   Current roles: ${user.roles.length}`);

        // Check if user already has Super User role
        if (!user.roles.includes(superUserRole._id)) {
          user.roles.push(superUserRole._id);
          await user.save();
          console.log(`   ✅ Added Super User role to ${email}`);
        } else {
          console.log(`   ℹ️  User already has Super User role`);
        }
      } else {
        console.log(`❌ User not found: ${email}`);
      }
    }

    // Verify the assignments
    console.log("\n🔍 Verifying assignments...");
    for (const email of userEmails) {
      const user = await User.findOne({ userEmail: email }).populate("roles");
      if (user) {
        const roleCodes = user.roles.map((role) => role.code);
        console.log(`   ${email}: [${roleCodes.join(", ")}]`);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  }
}

assignSuperUserRole();
