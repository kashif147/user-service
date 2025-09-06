#!/usr/bin/env node

const axios = require("axios");
const jwt = require("jsonwebtoken");

// Configuration
const BASE_URL = "http://localhost:4000";

class EndpointTester {
  constructor() {
    this.results = [];
  }

  async testEndpoint(name, method, url, headers = {}, data = null) {
    try {
      console.log(`\n🧪 Testing: ${name}`);
      console.log(`   ${method.toUpperCase()} ${url}`);

      const config = {
        method,
        url: `${BASE_URL}${url}`,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      };

      if (data) {
        config.data = data;
      }

      const response = await axios(config);

      console.log(`   ✅ Status: ${response.status}`);
      console.log(`   📄 Response:`, JSON.stringify(response.data, null, 2));

      this.results.push({
        name,
        status: "PASS",
        statusCode: response.status,
        response: response.data,
      });

      return response.data;
    } catch (error) {
      console.log(`   ❌ Error: ${error.response?.status || error.message}`);
      if (error.response?.data) {
        console.log(
          `   📄 Error Response:`,
          JSON.stringify(error.response.data, null, 2)
        );
      }

      this.results.push({
        name,
        status: "FAIL",
        statusCode: error.response?.status || 0,
        error: error.message,
        response: error.response?.data,
      });

      return null;
    }
  }

  decodeJWT(token) {
    try {
      const cleanToken = token.replace("Bearer ", "");
      const decoded = jwt.decode(cleanToken);
      console.log("   🔐 JWT Payload:", JSON.stringify(decoded, null, 2));
      return decoded;
    } catch (error) {
      console.log("   ❌ JWT Decode Error:", error.message);
      return null;
    }
  }

  async runTests() {
    console.log("🚀 Starting Endpoint Tests");
    console.log("============================");

    // Test 1: Login endpoint with Super User
    const loginResponse = await this.testEndpoint(
      "Login (Super User)",
      "POST",
      "/auth/general-crm/login",
      {},
      {
        email: "kashif@creativelab147outlook.onmicrosoft.com",
        password: "test123",
      }
    );

    if (loginResponse && loginResponse.token) {
      const token = loginResponse.token;
      console.log("\n🔍 Analyzing Super User JWT Token:");
      const decoded = this.decodeJWT(token);

      if (decoded) {
        console.log("\n📊 Super User Token Analysis:");
        console.log(`   User ID: ${decoded.id}`);
        console.log(`   Email: ${decoded.email}`);
        console.log(`   User Type: ${decoded.userType}`);
        console.log(
          `   Roles: ${
            decoded.roles ? JSON.stringify(decoded.roles) : "Not included"
          }`
        );
        console.log(
          `   Permissions: ${
            decoded.permissions
              ? JSON.stringify(decoded.permissions)
              : "Not included"
          }`
        );
      }

      // Test 2: Protected endpoints with Super User token
      await this.testEndpoint(
        "Get All Roles (Super User)",
        "GET",
        "/api/roles",
        { Authorization: token }
      );

      await this.testEndpoint(
        "Get All Users (Super User)",
        "GET",
        "/api/users",
        { Authorization: token }
      );

      if (decoded && decoded.id) {
        await this.testEndpoint(
          "Get User Roles (Super User)",
          "GET",
          `/api/users/${decoded.id}/roles`,
          { Authorization: token }
        );

        await this.testEndpoint(
          "Get User Permissions (Super User)",
          "GET",
          `/api/users/${decoded.id}/permissions`,
          { Authorization: token }
        );
      }
    }

    // Test 3: Login with regular user
    const regularLoginResponse = await this.testEndpoint(
      "Login (Regular User)",
      "POST",
      "/auth/general-crm/login",
      {},
      { email: "sadeeq@gmail.com", password: "test123" }
    );

    if (regularLoginResponse && regularLoginResponse.token) {
      const regularToken = regularLoginResponse.token;
      console.log("\n🔍 Analyzing Regular User JWT Token:");
      const regularDecoded = this.decodeJWT(regularToken);

      if (regularDecoded) {
        console.log("\n📊 Regular User Token Analysis:");
        console.log(`   User ID: ${regularDecoded.id}`);
        console.log(`   Email: ${regularDecoded.email}`);
        console.log(`   User Type: ${regularDecoded.userType}`);
        console.log(
          `   Roles: ${
            regularDecoded.roles
              ? JSON.stringify(regularDecoded.roles)
              : "Not included"
          }`
        );
        console.log(
          `   Permissions: ${
            regularDecoded.permissions
              ? JSON.stringify(regularDecoded.permissions)
              : "Not included"
          }`
        );
      }

      // Test 4: Protected endpoints with regular user token
      await this.testEndpoint(
        "Get All Roles (Regular User)",
        "GET",
        "/api/roles",
        { Authorization: regularToken }
      );
    }

    // Test 5: Endpoints without token (should fail)
    await this.testEndpoint("Get All Roles (No Auth)", "GET", "/api/roles");

    // Summary
    console.log("\n📊 Test Summary");
    console.log("================");
    this.results.forEach((result) => {
      const status = result.status === "PASS" ? "✅" : "❌";
      console.log(`${status} ${result.name}: ${result.statusCode}`);
    });

    const passCount = this.results.filter((r) => r.status === "PASS").length;
    const totalCount = this.results.length;
    console.log(`\n🎯 Results: ${passCount}/${totalCount} tests passed`);
  }
}

// Run tests
const tester = new EndpointTester();
tester.runTests().catch(console.error);
