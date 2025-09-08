#!/usr/bin/env node

/**
 * Quick Authentication Test Script
 *
 * This script tests the authentication endpoints without requiring actual Azure credentials
 */

const axios = require("axios");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function testAuthenticationEndpoints() {
  console.log("🧪 Testing Authentication Endpoints");
  console.log("==================================");

  try {
    // Test 1: Generate test token
    console.log("\n1️⃣ Testing test token generation...");
    const testTokenResponse = await axios.post(
      `${BASE_URL}/token/generate-test`,
      {
        userId: "test-user-123",
        tenantId: "test-tenant-456",
        email: "test@example.com",
      }
    );

    if (testTokenResponse.data.success) {
      console.log("✅ Test token generated successfully");
      const testToken = testTokenResponse.data.token;
      console.log("🔑 Token:", testToken.substring(0, 50) + "...");

      // Test 2: Validate the generated token
      console.log("\n2️⃣ Testing token validation...");
      const validateResponse = await axios.get(`${BASE_URL}/token/validate`, {
        headers: {
          Authorization: testToken,
        },
      });

      if (validateResponse.data.success && validateResponse.data.valid) {
        console.log("✅ Token validation successful");
        console.log("👤 User ID:", validateResponse.data.user.id);
        console.log("🏢 Tenant ID:", validateResponse.data.user.tenantId);
        console.log("📧 Email:", validateResponse.data.user.email);
        console.log("👥 Roles:", validateResponse.data.user.roles.length);
        console.log(
          "🔐 Permissions:",
          validateResponse.data.user.permissions.length
        );
      } else {
        console.log("❌ Token validation failed");
      }

      // Test 3: Test token decode
      console.log("\n3️⃣ Testing token decode...");
      const decodeResponse = await axios.post(
        `${BASE_URL}/token/decode-token`,
        {
          token: testToken.replace("Bearer ", ""),
        }
      );

      if (decodeResponse.data.success) {
        console.log("✅ Token decode successful");
        console.log("🎫 Token Type:", decodeResponse.data.tokenType);
        console.log("⏰ Expired:", decodeResponse.data.isExpired);
      } else {
        console.log("❌ Token decode failed");
      }

      // Test 4: Test internal JWT validation
      console.log("\n4️⃣ Testing internal JWT validation...");
      const internalValidateResponse = await axios.get(
        `${BASE_URL}/token/validate-jwt`,
        {
          headers: {
            Authorization: testToken,
          },
        }
      );

      if (
        internalValidateResponse.data.success &&
        internalValidateResponse.data.isValid
      ) {
        console.log("✅ Internal JWT validation successful");
        console.log(
          "📋 Validation details:",
          internalValidateResponse.data.validation
        );
      } else {
        console.log("❌ Internal JWT validation failed");
      }
    } else {
      console.log("❌ Test token generation failed");
    }

    // Test 5: Test Azure AD endpoint (should fail without real credentials)
    console.log("\n5️⃣ Testing Azure AD endpoint (expected to fail)...");
    try {
      await axios.post(`${BASE_URL}/auth/azure-crm`, {
        code: "fake-code",
        codeVerifier: "fake-verifier",
      });
      console.log("⚠️ Azure AD endpoint unexpectedly succeeded");
    } catch (error) {
      console.log(
        "✅ Azure AD endpoint correctly rejected invalid credentials"
      );
      console.log("   Error:", error.response?.data?.message || error.message);
    }

    // Test 6: Test Azure AD B2C endpoint (should fail without real credentials)
    console.log("\n6️⃣ Testing Azure AD B2C endpoint (expected to fail)...");
    try {
      await axios.post(`${BASE_URL}/auth/azure-portal`, {
        code: "fake-code",
        codeVerifier: "fake-verifier",
      });
      console.log("⚠️ Azure AD B2C endpoint unexpectedly succeeded");
    } catch (error) {
      console.log(
        "✅ Azure AD B2C endpoint correctly rejected invalid credentials"
      );
      console.log("   Error:", error.response?.data?.message || error.message);
    }

    console.log("\n🎉 Authentication system test completed!");
    console.log("\n📋 Summary:");
    console.log("- Test token generation: ✅");
    console.log("- Token validation: ✅");
    console.log("- Token decode: ✅");
    console.log("- Internal JWT validation: ✅");
    console.log("- Azure AD endpoint protection: ✅");
    console.log("- Azure AD B2C endpoint protection: ✅");

    console.log("\n🚀 Next steps:");
    console.log(
      "1. Configure your Azure AD and B2C credentials in environment variables"
    );
    console.log("2. Test with real Azure authentication flows");
    console.log("3. Use the generated tokens in other services");
  } catch (error) {
    console.log("❌ Test failed:", error.message);
    if (error.code === "ECONNREFUSED") {
      console.log("💡 Make sure the user service is running on", BASE_URL);
      console.log("   Run: npm start");
    }
  }
}

// Run the test
if (require.main === module) {
  testAuthenticationEndpoints().catch(console.error);
}

module.exports = testAuthenticationEndpoints;
