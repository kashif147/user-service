require("dotenv").config({ path: ".env.staging" });
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");

async function getUsersWithSystemRoles() {
  try {
    // Connect to staging database
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

    if (!suRole) {
      console.log("❌ SU role not found in staging");
    } else {
      console.log(`✅ Found SU role: ${suRole.name} (${suRole.code})`);
    }

    if (!asuRole) {
      console.log("❌ ASU role not found in staging");
    } else {
      console.log(`✅ Found ASU role: ${asuRole.name} (${asuRole.code})`);
    }

    console.log("\n" + "=".repeat(80));
    console.log("SUPER USER (SU) ROLE HOLDERS");
    console.log("=".repeat(80));

    if (suRole) {
      const suUsers = await User.find({ roles: suRole._id })
        .populate("roles")
        .select("userEmail userFullName userType tenantId createdAt");

      if (suUsers.length === 0) {
        console.log("❌ No users found with SU role");
      } else {
        console.log(`📊 Found ${suUsers.length} users with SU role:\n`);

        suUsers.forEach((user, index) => {
          console.log(`${index + 1}. Email: ${user.userEmail}`);
          console.log(`   Name: ${user.userFullName || "N/A"}`);
          console.log(`   Type: ${user.userType}`);
          console.log(`   Tenant: ${user.tenantId}`);
          console.log(`   Created: ${user.createdAt}`);
          console.log(`   Roles: ${user.roles.map((r) => r.code).join(", ")}`);
          console.log("");
        });
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log("ASSISTANT SUPER USER (ASU) ROLE HOLDERS");
    console.log("=".repeat(80));

    if (asuRole) {
      const asuUsers = await User.find({ roles: asuRole._id })
        .populate("roles")
        .select("userEmail userFullName userType tenantId createdAt");

      if (asuUsers.length === 0) {
        console.log("❌ No users found with ASU role");
      } else {
        console.log(`📊 Found ${asuUsers.length} users with ASU role:\n`);

        asuUsers.forEach((user, index) => {
          console.log(`${index + 1}. Email: ${user.userEmail}`);
          console.log(`   Name: ${user.userFullName || "N/A"}`);
          console.log(`   Type: ${user.userType}`);
          console.log(`   Tenant: ${user.tenantId}`);
          console.log(`   Created: ${user.createdAt}`);
          console.log(`   Roles: ${user.roles.map((r) => r.code).join(", ")}`);
          console.log("");
        });
      }
    }

    // Summary by tenant
    console.log("\n" + "=".repeat(80));
    console.log("SUMMARY BY TENANT");
    console.log("=".repeat(80));

    const allSystemUsers = await User.find({
      roles: { $in: [suRole?._id, asuRole?._id].filter(Boolean) },
    })
      .populate("roles")
      .select("userEmail userFullName userType tenantId roles");

    const tenantSummary = {};
    allSystemUsers.forEach((user) => {
      if (!tenantSummary[user.tenantId]) {
        tenantSummary[user.tenantId] = { SU: [], ASU: [] };
      }

      const hasSU = user.roles.some((r) => r.code === "SU");
      const hasASU = user.roles.some((r) => r.code === "ASU");

      if (hasSU) tenantSummary[user.tenantId].SU.push(user.userEmail);
      if (hasASU) tenantSummary[user.tenantId].ASU.push(user.userEmail);
    });

    Object.keys(tenantSummary).forEach((tenantId) => {
      console.log(`\n🏢 Tenant: ${tenantId}`);
      console.log(`   SU Users: ${tenantSummary[tenantId].SU.length}`);
      tenantSummary[tenantId].SU.forEach((email) =>
        console.log(`     - ${email}`)
      );
      console.log(`   ASU Users: ${tenantSummary[tenantId].ASU.length}`);
      tenantSummary[tenantId].ASU.forEach((email) =>
        console.log(`     - ${email}`)
      );
    });
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

// Run the script
getUsersWithSystemRoles();
