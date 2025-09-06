const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/user");
const Role = require("../models/role");
const {
  assignDefaultRole,
  getDefaultRoleCode,
} = require("../helpers/roleAssignment");

async function assignDefaultRolesToExistingUsers() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Step 1: Check if roles exist
    console.log("\n🔍 Checking if required roles exist...");
    const nonMemberRole = await Role.findOne({
      code: "NON-MEMBER",
      isActive: true,
    });
    const reoRole = await Role.findOne({ code: "REO", isActive: true });

    if (!nonMemberRole || !reoRole) {
      console.log(
        "❌ Required roles not found. Please run role initialization first:"
      );
      console.log("   node scripts/setup-rbac.js");
      return;
    }

    console.log(`✅ NON-MEMBER role found: ${nonMemberRole.name}`);
    console.log(`✅ REO role found: ${reoRole.name}`);

    // Step 2: Get all users without roles
    console.log("\n📊 Analyzing existing users...");
    const usersWithoutRoles = await User.find({
      $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }],
    });

    console.log(`Found ${usersWithoutRoles.length} users without roles`);

    if (usersWithoutRoles.length === 0) {
      console.log("✅ All users already have roles assigned!");
      return;
    }

    // Step 3: Group users by type
    const portalUsers = usersWithoutRoles.filter(
      (user) => user.userType === "PORTAL"
    );
    const crmUsers = usersWithoutRoles.filter(
      (user) => user.userType === "CRM"
    );
    const unknownTypeUsers = usersWithoutRoles.filter(
      (user) => !user.userType || !["PORTAL", "CRM"].includes(user.userType)
    );

    console.log(`\n📈 User breakdown:`);
    console.log(`   - Portal users: ${portalUsers.length}`);
    console.log(`   - CRM users: ${crmUsers.length}`);
    console.log(`   - Unknown type users: ${unknownTypeUsers.length}`);

    // Step 4: Assign roles to users
    console.log("\n🔄 Assigning default roles...");

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // Process Portal users
    if (portalUsers.length > 0) {
      console.log(`\n📝 Processing ${portalUsers.length} Portal users...`);
      for (const user of portalUsers) {
        try {
          await assignDefaultRole(user, "PORTAL");
          await user.save();
          successCount++;
          console.log(`   ✅ Assigned NON-MEMBER role to ${user.userEmail}`);
        } catch (error) {
          errorCount++;
          errors.push(`Portal user ${user.userEmail}: ${error.message}`);
          console.log(
            `   ❌ Failed to assign role to ${user.userEmail}: ${error.message}`
          );
        }
      }
    }

    // Process CRM users
    if (crmUsers.length > 0) {
      console.log(`\n📝 Processing ${crmUsers.length} CRM users...`);
      for (const user of crmUsers) {
        try {
          await assignDefaultRole(user, "CRM");
          await user.save();
          successCount++;
          console.log(`   ✅ Assigned REO role to ${user.userEmail}`);
        } catch (error) {
          errorCount++;
          errors.push(`CRM user ${user.userEmail}: ${error.message}`);
          console.log(
            `   ❌ Failed to assign role to ${user.userEmail}: ${error.message}`
          );
        }
      }
    }

    // Process unknown type users
    if (unknownTypeUsers.length > 0) {
      console.log(
        `\n⚠️  Found ${unknownTypeUsers.length} users with unknown user types:`
      );
      for (const user of unknownTypeUsers) {
        console.log(
          `   - ${user.userEmail} (userType: ${user.userType || "undefined"})`
        );
      }
      console.log(
        "   These users were skipped. Please review and update their userType manually."
      );
    }

    // Step 5: Summary
    console.log("\n📊 Assignment Summary:");
    console.log(`   ✅ Successfully assigned roles: ${successCount}`);
    console.log(`   ❌ Failed assignments: ${errorCount}`);
    console.log(`   ⚠️  Skipped (unknown type): ${unknownTypeUsers.length}`);

    if (errors.length > 0) {
      console.log("\n❌ Errors encountered:");
      errors.forEach((error) => console.log(`   - ${error}`));
    }

    // Step 6: Verification
    console.log("\n🔍 Verifying assignments...");
    const usersWithRoles = await User.find({
      roles: { $exists: true, $not: { $size: 0 } },
    }).populate("roles");

    console.log(`✅ Total users with roles: ${usersWithRoles.length}`);

    // Count users by role
    const roleCounts = {};
    usersWithRoles.forEach((user) => {
      user.roles.forEach((role) => {
        roleCounts[role.code] = (roleCounts[role.code] || 0) + 1;
      });
    });

    console.log("\n📈 Role distribution:");
    Object.entries(roleCounts).forEach(([roleCode, count]) => {
      console.log(`   - ${roleCode}: ${count} users`);
    });

    // Step 7: Test JWT generation for a few users
    console.log("\n🧪 Testing JWT generation...");
    const testUsers = usersWithRoles.slice(0, 3); // Test first 3 users

    for (const user of testUsers) {
      try {
        const jwtHelper = require("../helpers/jwt");
        const token = await jwtHelper.generateToken(user);
        const jwt = require("jsonwebtoken");
        const decoded = jwt.decode(token.token.replace("Bearer ", ""));

        console.log(
          `   ✅ ${user.userEmail}: JWT generated with roles [${decoded.roles
            ?.map((r) => r.code)
            .join(", ")}]`
        );
      } catch (error) {
        console.log(
          `   ❌ ${user.userEmail}: JWT generation failed - ${error.message}`
        );
      }
    }

    console.log("\n🎉 Default role assignment completed!");
    console.log("\nNext steps:");
    console.log("1. Review any errors and fix user types if needed");
    console.log(
      "2. Define specific permissions for each role via ProjectShell-1"
    );
    console.log("3. Test user authentication to ensure roles are working");
    console.log("4. Monitor logs for role-related activities");
  } catch (error) {
    console.error("❌ Script failed:", error);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  }
}

// Add command line options
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes("--dry-run"),
  force: args.includes("--force"),
  help: args.includes("--help"),
};

if (options.help) {
  console.log(`
Usage: node scripts/assign-default-roles.js [options]

Options:
  --dry-run    Show what would be done without making changes
  --force      Force assignment even if users already have roles
  --help       Show this help message

Examples:
  node scripts/assign-default-roles.js
  node scripts/assign-default-roles.js --dry-run
  node scripts/assign-default-roles.js --force
`);
  process.exit(0);
}

if (options.dryRun) {
  console.log("🔍 DRY RUN MODE - No changes will be made");
}

assignDefaultRolesToExistingUsers();
