#!/usr/bin/env node

/**
 * JWT Token Generator for Authorization Bypass
 *
 * This script generates a valid JWT token that can be used
 * as a bypass token for authorization testing.
 */

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret-here";
const EXPIRES_IN = process.env.JWT_EXPIRY || "24h";

// Default payload for bypass token
const defaultPayload = {
  sub: "bypass-user",
  tenantId: "test-tenant",
  email: "bypass@example.com",
  userType: "CRM",
  roles: [{ code: "SU" }],
  permissions: ["*"],
  iat: Math.floor(Date.now() / 1000),
};

// Custom payload options
const customOptions = {
  userId: "bypass-user",
  tenantId: "test-tenant",
  email: "bypass@example.com",
  userType: "CRM",
  roles: ["SU"],
  permissions: ["*"],
};

function generateToken(payload = defaultPayload, options = {}) {
  try {
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: EXPIRES_IN,
      ...options,
    });

    return {
      success: true,
      token,
      payload,
      expiresIn: EXPIRES_IN,
      decoded: jwt.decode(token),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

function generateRandomToken() {
  const randomId = crypto.randomBytes(8).toString("hex");
  const randomTenant = crypto.randomBytes(4).toString("hex");

  const payload = {
    sub: `bypass-user-${randomId}`,
    tenantId: `tenant-${randomTenant}`,
    email: `bypass-${randomId}@example.com`,
    userType: "CRM",
    roles: [{ code: "SU" }],
    permissions: ["*"],
    iat: Math.floor(Date.now() / 1000),
  };

  return generateToken(payload);
}

function printUsage() {
  console.log(`
🔑 JWT Token Generator for Authorization Bypass
==============================================

Usage:
  node generate-bypass-token.js [options]

Options:
  --help, -h          Show this help message
  --random, -r        Generate a token with random values
  --user-id <id>      Set custom user ID (default: bypass-user)
  --tenant-id <id>    Set custom tenant ID (default: test-tenant)
  --email <email>     Set custom email (default: bypass@example.com)
  --user-type <type>  Set custom user type (default: CRM)
  --roles <roles>     Set custom roles (comma-separated, default: SU)
  --permissions <perm> Set custom permissions (comma-separated, default: *)
  --expires <time>    Set expiration time (default: 24h)

Examples:
  # Generate default token
  node generate-bypass-token.js

  # Generate random token
  node generate-bypass-token.js --random

  # Generate custom token
  node generate-bypass-token.js --user-id admin --tenant-id prod-tenant

  # Set environment variables
  JWT_SECRET=your-secret node generate-bypass-token.js

Environment Variables:
  JWT_SECRET          JWT signing secret (required)
  JWT_EXPIRY          Token expiration time (default: 24h)
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;

      case "--random":
      case "-r":
        options.random = true;
        break;

      case "--user-id":
        options.userId = args[++i];
        break;

      case "--tenant-id":
        options.tenantId = args[++i];
        break;

      case "--email":
        options.email = args[++i];
        break;

      case "--user-type":
        options.userType = args[++i];
        break;

      case "--roles":
        options.roles = args[++i].split(",").map((r) => ({ code: r.trim() }));
        break;

      case "--permissions":
        options.permissions = args[++i].split(",").map((p) => p.trim());
        break;

      case "--expires":
        options.expiresIn = args[++i];
        break;

      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

function main() {
  const options = parseArgs();

  if (!JWT_SECRET || JWT_SECRET === "your-jwt-secret-here") {
    console.error("❌ Error: JWT_SECRET environment variable is required");
    console.error("   Set JWT_SECRET=your-secret-key");
    process.exit(1);
  }

  let result;

  if (options.random) {
    console.log("🎲 Generating random bypass token...");
    result = generateRandomToken();
  } else {
    console.log("🔑 Generating custom bypass token...");

    const payload = {
      sub: options.userId || defaultPayload.sub,
      tenantId: options.tenantId || defaultPayload.tenantId,
      email: options.email || defaultPayload.email,
      userType: options.userType || defaultPayload.userType,
      roles: options.roles || defaultPayload.roles,
      permissions: options.permissions || defaultPayload.permissions,
      iat: Math.floor(Date.now() / 1000),
    };

    result = generateToken(payload, { expiresIn: options.expiresIn });
  }

  if (!result.success) {
    console.error(`❌ Error generating token: ${result.error}`);
    process.exit(1);
  }

  console.log("\n✅ Token generated successfully!");
  console.log("=====================================");
  console.log(`🔑 Token: ${result.token}`);
  console.log(`⏰ Expires: ${result.expiresIn}`);
  console.log(`👤 User ID: ${result.payload.sub}`);
  console.log(`🏢 Tenant ID: ${result.payload.tenantId}`);
  console.log(`📧 Email: ${result.payload.email}`);
  console.log(`👥 User Type: ${result.payload.userType}`);
  console.log(
    `🎭 Roles: ${result.payload.roles.map((r) => r.code).join(", ")}`
  );
  console.log(`🔐 Permissions: ${result.payload.permissions.join(", ")}`);

  console.log("\n📋 Environment Variables:");
  console.log("========================");
  console.log(`AUTH_BYPASS_ENABLED=true`);
  console.log(`AUTH_BYPASS_TOKEN=${result.token}`);

  console.log("\n🧪 Test Command:");
  console.log("================");
  console.log(
    `AUTH_BYPASS_ENABLED=true AUTH_BYPASS_TOKEN="${result.token}" node test-bypass.js`
  );

  console.log("\n🌐 cURL Example:");
  console.log("================");
  console.log(`curl -H "Authorization: Bearer ${result.token}" \\`);
  console.log(`     http://localhost:3000/users`);

  console.log("\n⚠️  Security Notes:");
  console.log("==================");
  console.log(
    "• This token bypasses authorization but still requires authentication"
  );
  console.log("• The token must be a valid JWT signed with your JWT_SECRET");
  console.log("• Only use in development/testing environments");
  console.log("• Never commit bypass tokens to version control");
  console.log("• Rotate tokens regularly");
}

// Run the generator
main();
