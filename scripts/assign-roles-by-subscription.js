#!/usr/bin/env node

/**
 * Script to assign MEMBER or NON-MEMBER roles to portal users based on their subscription status
 * 
 * Logic:
 * - If user has no profile → NON-MEMBER
 * - If user has profile with active subscription → MEMBER
 * - If user has profile but no active subscription → NON-MEMBER
 * 
 * Usage: NODE_ENV=staging node scripts/assign-roles-by-subscription.js
 */

require("dotenv").config({ path: ".env.staging" });

const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");

// Normalize email helper
function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

// Get MongoDB URI from environment or construct from components
function getMongoUri(serviceName = "user-service", baseUri = null) {
  // If baseUri provided, replace database name
  if (baseUri) {
    const dbName = process.env[`${serviceName.toUpperCase().replace("-", "_")}_MONGO_DB`] || 
                   `${serviceName}-staging`;
    // Replace database name in URI
    return baseUri.replace(/\/[^\/\?]+(\?|$)/, `/${dbName}$1`);
  }

  // Try service-specific URI
  const serviceUri = process.env[`${serviceName.toUpperCase().replace("-", "_")}_MONGO_URI`];
  if (serviceUri) {
    return serviceUri;
  }

  // Try direct MONGO_URI and modify database name
  if (process.env.MONGO_URI) {
    const dbName = process.env[`${serviceName.toUpperCase().replace("-", "_")}_MONGO_DB`] || 
                   `${serviceName}-staging`;
    return process.env.MONGO_URI.replace(/\/[^\/\?]+(\?|$)/, `/${dbName}$1`);
  }

  // Construct from components
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  const cluster = process.env.MONGO_CLUSTER || "clusterprojectshell.tptnh8w.mongodb.net";
  const dbName = process.env[`${serviceName.toUpperCase().replace("-", "_")}_MONGO_DB`] || 
                 process.env.MONGO_DB || 
                 `${serviceName}-staging`;

  if (user && pass) {
    return `mongodb+srv://${user}:${pass}@${cluster}/${dbName}?retryWrites=true&w=majority&appName=ClusterProjectShell`;
  }

  throw new Error(`Cannot construct MongoDB URI for ${serviceName}. Please set MONGO_URI or MONGO_USER/MONGO_PASS`);
}

// Connect to multiple databases
async function connectToDatabases() {
  const connections = {};

  try {
    // User Service Database
    const userServiceUri = getMongoUri("user-service");
    console.log("🔗 Connecting to User Service database...");
    connections.userService = await mongoose.createConnection(userServiceUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });
    console.log(`✅ Connected to User Service: ${connections.userService.name}`);

    // Profile Service Database
    // Try to get from profile-service .env.staging if exists
    const profileServiceEnvPath = path.join(__dirname, "..", "..", "profile-service", ".env.staging");
    let profileServiceUri = process.env.PROFILE_SERVICE_MONGO_URI;
    
    if (!profileServiceUri && fs.existsSync(profileServiceEnvPath)) {
      const profileEnv = require("dotenv").config({ path: profileServiceEnvPath }).parsed;
      profileServiceUri = profileEnv?.MONGO_URI || getMongoUri("profile-service", userServiceUri);
    } else {
      profileServiceUri = getMongoUri("profile-service", userServiceUri);
    }

    console.log("🔗 Connecting to Profile Service database...");
    connections.profileService = await mongoose.createConnection(profileServiceUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });
    console.log(`✅ Connected to Profile Service: ${connections.profileService.name}`);

    // Subscription Service Database
    const subscriptionServiceEnvPath = path.join(__dirname, "..", "..", "subscription-service", ".env.staging");
    let subscriptionServiceUri = process.env.SUBSCRIPTION_SERVICE_MONGO_URI;
    
    if (!subscriptionServiceUri && fs.existsSync(subscriptionServiceEnvPath)) {
      const subscriptionEnv = require("dotenv").config({ path: subscriptionServiceEnvPath }).parsed;
      subscriptionServiceUri = subscriptionEnv?.MONGO_URI || getMongoUri("subscription-service", userServiceUri);
    } else {
      subscriptionServiceUri = getMongoUri("subscription-service", userServiceUri);
    }

    console.log("🔗 Connecting to Subscription Service database...");
    connections.subscriptionService = await mongoose.createConnection(subscriptionServiceUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });
    console.log(`✅ Connected to Subscription Service: ${connections.subscriptionService.name}`);

    return connections;
  } catch (error) {
    console.error("❌ Database connection error:", error.message);
    // Close any opened connections
    for (const conn of Object.values(connections)) {
      if (conn && conn.readyState === 1) {
        await conn.close();
      }
    }
    throw error;
  }
}

// Load models for each database connection
function loadModels(connections) {
  // User Service Models
  const UserSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    userEmail: { type: String, default: null },
    userType: { type: String, enum: ["PORTAL", "CRM"], default: "PORTAL" },
    roles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Role" }],
    isActive: { type: Boolean, default: true },
  }, { collection: "users", strict: false });

  const RoleSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  }, { collection: "roles", strict: false });

  const User = connections.userService.models.User || 
    connections.userService.model("User", UserSchema);
  const Role = connections.userService.models.Role || 
    connections.userService.model("Role", RoleSchema);

  // Profile Service Model
  const ProfileSchema = new mongoose.Schema({
    tenantId: { type: String, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users" },
    normalizedEmail: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    currentSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "subscriptionDetails" },
  }, { collection: "profiles", strict: false });

  const Profile = connections.profileService.models.Profile || 
    connections.profileService.model("Profile", ProfileSchema);

  // Subscription Service Model
  const SubscriptionSchema = new mongoose.Schema({
    tenantId: { type: String, index: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: "profiles" },
    subscriptionStatus: { type: String },
    isCurrent: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
  }, { collection: "subscriptions", strict: false });

  const Subscription = connections.subscriptionService.models.subscriptionDetails || 
    connections.subscriptionService.model("subscriptionDetails", SubscriptionSchema);

  return { User, Role, Profile, Subscription };
}

// Check if user has active subscription
async function hasActiveSubscription(user, Profile, Subscription, tenantId) {
  try {
    // First, try to find profile by userId
    let profile = await Profile.findOne({
      tenantId: tenantId,
      userId: user._id,
    });

    // If not found by userId, try by normalized email
    if (!profile && user.userEmail) {
      const normalizedEmail = normalizeEmail(user.userEmail);
      profile = await Profile.findOne({
        tenantId: tenantId,
        normalizedEmail: normalizedEmail,
      });
    }

    // No profile means no subscription
    if (!profile) {
      return false;
    }

    // Profile exists but is not active
    if (!profile.isActive) {
      return false;
    }

    // Check if profile has currentSubscriptionId
    if (!profile.currentSubscriptionId) {
      return false;
    }

    // Check if the subscription is active
    const subscription = await Subscription.findOne({
      _id: profile.currentSubscriptionId,
      tenantId: tenantId,
      isCurrent: true,
      subscriptionStatus: "Active",
      deleted: { $ne: true },
    });

    return !!subscription;
  } catch (error) {
    console.error(`Error checking subscription for user ${user.userEmail}:`, error.message);
    return false;
  }
}

// Main function
async function assignRolesBySubscription() {
  let connections = null;

  try {
    // Connect to databases
    connections = await connectToDatabases();
    const { User, Role, Profile, Subscription } = loadModels(connections);

    // Get all PORTAL users
    console.log("\n📊 Fetching all PORTAL users...");
    const portalUsers = await User.find({
      userType: "PORTAL",
      isActive: true,
    }).populate("roles");

    console.log(`✅ Found ${portalUsers.length} PORTAL users`);

    if (portalUsers.length === 0) {
      console.log("✅ No PORTAL users found. Exiting.");
      return;
    }

    // Get MEMBER and NON-MEMBER roles for each tenant
    const tenantRoles = new Map();

    // Process each user
    let processed = 0;
    let memberAssigned = 0;
    let nonMemberAssigned = 0;
    let unchanged = 0;
    let errors = 0;

    console.log("\n🔄 Processing users...\n");

    for (const user of portalUsers) {
      try {
        const tenantId = user.tenantId;

        // Get roles for this tenant if not already cached
        if (!tenantRoles.has(tenantId)) {
          const memberRole = await Role.findOne({
            tenantId: tenantId,
            code: "MEMBER",
            isActive: true,
          });

          const nonMemberRole = await Role.findOne({
            tenantId: tenantId,
            code: "NON-MEMBER",
            isActive: true,
          });

          tenantRoles.set(tenantId, { memberRole, nonMemberRole });

          if (!memberRole) {
            console.warn(`⚠️  MEMBER role not found for tenant ${tenantId}`);
          }
          if (!nonMemberRole) {
            console.warn(`⚠️  NON-MEMBER role not found for tenant ${tenantId}`);
          }
        }

        const { memberRole, nonMemberRole } = tenantRoles.get(tenantId);

        if (!memberRole || !nonMemberRole) {
          console.log(`⚠️  Skipping ${user.userEmail || user._id}: Missing roles for tenant ${tenantId}`);
          errors++;
          continue;
        }

        // Check if user has active subscription
        const hasActive = await hasActiveSubscription(user, Profile, Subscription, tenantId);

        // Determine target role
        const targetRole = hasActive ? memberRole : nonMemberRole;
        const targetRoleCode = hasActive ? "MEMBER" : "NON-MEMBER";

        // Check current role
        const currentRoleIds = user.roles.map(r => r._id || r);
        const currentRoleCode = currentRoleIds.length > 0 && 
          currentRoleIds[0].toString() === targetRole._id.toString() 
          ? targetRoleCode 
          : null;

        // Update if needed
        if (currentRoleCode !== targetRoleCode) {
          user.roles = [targetRole._id];
          await user.save();

          if (hasActive) {
            memberAssigned++;
            console.log(`✅ ${user.userEmail || user._id}: Assigned MEMBER (has active subscription)`);
          } else {
            nonMemberAssigned++;
            console.log(`✅ ${user.userEmail || user._id}: Assigned NON-MEMBER (no profile or inactive subscription)`);
          }
        } else {
          unchanged++;
          console.log(`⏭️  ${user.userEmail || user._id}: Already has ${targetRoleCode} role`);
        }

        processed++;
      } catch (error) {
        console.error(`❌ Error processing user ${user.userEmail || user._id}:`, error.message);
        errors++;
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total PORTAL users: ${portalUsers.length}`);
    console.log(`Processed: ${processed}`);
    console.log(`MEMBER assigned: ${memberAssigned}`);
    console.log(`NON-MEMBER assigned: ${nonMemberAssigned}`);
    console.log(`Unchanged: ${unchanged}`);
    console.log(`Errors: ${errors}`);
    console.log("=".repeat(60));

  } catch (error) {
    console.error("❌ Script error:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Close all connections
    if (connections) {
      console.log("\n🔌 Closing database connections...");
      for (const [name, conn] of Object.entries(connections)) {
        if (conn && conn.readyState === 1) {
          await conn.close();
          console.log(`✅ Closed ${name} connection`);
        }
      }
    }
  }
}

// Run the script
assignRolesBySubscription()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error.message);
    process.exit(1);
  });

