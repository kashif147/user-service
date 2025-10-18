require("dotenv").config({
  path: `.env.${process.env.NODE_ENV || "development"}`,
});

module.exports = {
  // Azure B2C Configuration
  tenantName: process.env.B2C_TENANT_NAME || "your_tenant_name_here",
  tenantId: process.env.B2C_TENANT_ID || "your_tenant_id_here",
  clientId: process.env.B2C_CLIENT_ID || "your_b2c_client_id_here",
  clientSecret: process.env.B2C_CLIENT_SECRET || "your_b2c_client_secret_here",

  // Allowed B2C Policies
  allowedPolicies: process.env.ALLOWED_B2C_POLICIES
    ? process.env.ALLOWED_B2C_POLICIES.split(",")
    : ["B2C_1_signin", "B2C_1_signup"],

  // JWKS URL for token validation
  get jwksUrl() {
    return `https://${this.tenantName}.b2clogin.com/${this.tenantName}.onmicrosoft.com/B2C_1_signin/discovery/v2.0/keys`;
  },

  // JWT Configuration for internal tokens
  jwtSecret: process.env.JWT_SECRET || "your_jwt_secret_here",
  jwtExpiry: process.env.JWT_EXPIRY || "30d",
};
