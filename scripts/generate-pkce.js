#!/usr/bin/env node

/**
 * PKCE Code Challenge and Code Verifier Generator
 *
 * This script generates PKCE parameters required for Azure AD authentication
 * using the Authorization Code flow with PKCE.
 */

const crypto = require("crypto");

class PKCEGenerator {
  /**
   * Generate a cryptographically random code verifier
   * @param {number} length - Length of the code verifier (43-128 characters)
   * @returns {string} Code verifier
   */
  static generateCodeVerifier(length = 128) {
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let codeVerifier = "";

    for (let i = 0; i < length; i++) {
      codeVerifier += charset.charAt(
        Math.floor(Math.random() * charset.length)
      );
    }

    return codeVerifier;
  }

  /**
   * Generate code challenge from code verifier using SHA256
   * @param {string} codeVerifier - The code verifier
   * @returns {string} Code challenge (base64url encoded)
   */
  static generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    return this.base64URLEncode(hash);
  }

  /**
   * Base64 URL encode (RFC 4648)
   * @param {Buffer} buffer - Buffer to encode
   * @returns {string} Base64 URL encoded string
   */
  static base64URLEncode(buffer) {
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  /**
   * Generate both code verifier and code challenge
   * @param {number} length - Length of code verifier
   * @returns {Object} Object containing codeVerifier and codeChallenge
   */
  static generatePKCEPair(length = 128) {
    const codeVerifier = this.generateCodeVerifier(length);
    const codeChallenge = this.generateCodeChallenge(codeVerifier);

    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
    };
  }
}

// Example usage and demonstration
function demonstratePKCE() {
  console.log("🔐 PKCE Code Challenge and Code Verifier Generator");
  console.log("=================================================");

  // Generate PKCE parameters
  const pkceParams = PKCEGenerator.generatePKCEPair();

  console.log("\n📋 Generated PKCE Parameters:");
  console.log("Code Verifier:", pkceParams.codeVerifier);
  console.log("Code Challenge:", pkceParams.codeChallenge);
  console.log("Code Challenge Method:", pkceParams.codeChallengeMethod);

  // Show how to use in Azure AD authorization URL
  console.log("\n🌐 Azure AD Authorization URL Example:");
  console.log("======================================");

  const tenantId = "your-tenant-id";
  const clientId = "your-client-id";
  const redirectUri = "http://localhost:3000/auth/azure-crm";
  const scope = "openid profile email offline_access";
  const state = "12345"; // Random state for security

  const authUrl =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${clientId}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent(scope)}&` +
    `state=${state}&` +
    `code_challenge=${pkceParams.codeChallenge}&` +
    `code_challenge_method=${pkceParams.codeChallengeMethod}`;

  console.log(authUrl);

  // Show how to use in Azure AD B2C authorization URL
  console.log("\n🌐 Azure AD B2C Authorization URL Example:");
  console.log("==========================================");

  const tenantName = "your-b2c-tenant";
  const policy = "B2C_1_signup_signin";
  const b2cClientId = "your-b2c-client-id";
  const b2cRedirectUri = "http://localhost:3000/auth/azure-portal";

  const b2cAuthUrl =
    `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${policy}/oauth2/v2.0/authorize?` +
    `client_id=${b2cClientId}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(b2cRedirectUri)}&` +
    `scope=${encodeURIComponent("openid profile offline_access")}&` +
    `state=${state}&` +
    `code_challenge=${pkceParams.codeChallenge}&` +
    `code_challenge_method=${pkceParams.codeChallengeMethod}`;

  console.log(b2cAuthUrl);

  // Show how to use in Postman
  console.log("\n📮 Postman Collection Usage:");
  console.log("============================");
  console.log("1. Generate PKCE parameters using this script");
  console.log("2. Use the code_challenge in your authorization URL");
  console.log("3. Save the code_verifier for the token exchange");
  console.log("4. In your token exchange request, use:");
  console.log(`   - code: (from authorization response)`);
  console.log(`   - code_verifier: ${pkceParams.codeVerifier}`);

  // Show validation
  console.log("\n✅ Validation:");
  console.log("==============");
  const regeneratedChallenge = PKCEGenerator.generateCodeChallenge(
    pkceParams.codeVerifier
  );
  console.log("Original Challenge:", pkceParams.codeChallenge);
  console.log("Regenerated Challenge:", regeneratedChallenge);
  console.log(
    "Match:",
    pkceParams.codeChallenge === regeneratedChallenge ? "✅" : "❌"
  );

  return pkceParams;
}

// Run demonstration if this script is executed directly
if (require.main === module) {
  demonstratePKCE();
}

module.exports = PKCEGenerator;
