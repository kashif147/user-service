require("dotenv").config({ path: ".env.staging" });
const mongoose = require("mongoose");
const User = require("../models/user");
const Role = require("../models/role");

// Configuration
const TARGET_EMAILS = [
  // Add email addresses here that should have ASU role
  // "admin@example.com",
  // "manager@example.com"
];

async function assignASURoleToUsers() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("❌ MONGO_URI not found in .env.staging");
      return;
    }

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to staging MongoDB");

    // Find ASU role
    const asuRole = await Role.findOne({ code: "ASU", isActive: true });
    if (!asuRole) {
      console.log("❌ ASU role not found. Please initialize roles first.");
      return;
    }

    console.log(`✅ Found ASU role: ${asuRole.name} (${asuRole.code})`);

    if (TARGET_EMAILS.length === 0) {
      console.log(
        "❌ No target emails configured. Please add emails to TARGET_EMAILS array."
      );
      return;
    }

    console.log(`\n🎯 Processing ${TARGET_EMAILS.length} target emails...`);

    let processed = 0;
    let errors = 0;
    let notFound = 0;
    let alreadyHadRole = 0;

    for (const email of TARGET_EMAILS) {
      try {
        // Find user by email
        const user = await User.findOne({ userEmail: email });

        if (!user) {
          console.log(`❌ User not found: ${email}`);
          notFound++;
          continue;
        }

        // Check if user already has ASU role
        const hasASURole = user.roles.some(
          (roleId) => roleId.toString() === asuRole._id.toString()
        );

        if (hasASURole) {
          console.log(`⏭️  ${email} already has ASU role`);
          alreadyHadRole++;
          continue;
        }

        // Add ASU role to user's roles
        user.roles.push(asuRole._id);
        await user.save();

        console.log(
          `✅ Assigned ASU role to ${email} (${user.userFullName || "N/A"})`
        );
        processed++;
      } catch (error) {
        console.log(
          `❌ Failed to assign ASU role to ${email}: ${error.message}`
        );
        errors++;
      }
    }

    console.log(`\n📊 ASU Role Assignment Summary:`);
    console.log(`✅ Successfully assigned: ${processed} users`);
    console.log(`⏭️  Already had ASU role: ${alreadyHadRole} users`);
    console.log(`❌ User not found: ${notFound} users`);
    console.log(`❌ Errors: ${errors} users`);

    // Show current ASU users
    console.log(`\n🔧 Current ASU Users:`);
    const asuUsers = await User.find({ roles: asuRole._id }).select(
      "userEmail userFullName tenantId"
    );

    asuUsers.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.userEmail} (${
          user.userFullName || "N/A"
        }) - Tenant: ${user.tenantId}`
      );
    });
  } catch (error) {
    console.error("❌ Script error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

assignASURoleToUsers();
