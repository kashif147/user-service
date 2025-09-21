#!/usr/bin/env node

/**
 * HTTP Status Code Response Examples
 * Demonstrates the actual response formats for different status codes
 */

const http = require("http");

const BASE_URL = "http://localhost:5001";

function makeRequest(method, path, data = null, headers = {}) {
  return new Promise((resolve) => {
    const options = {
      hostname: "localhost",
      port: 5001,
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });

    req.on("error", (error) => {
      resolve({ status: 0, error: error.message });
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function demonstrateStatusCodes() {
  console.log("🎯 HTTP Status Code Response Examples\n");
  console.log("=" * 60);

  // 200 OK - Success Response
  console.log("\n📋 200 OK - Success Response");
  console.log("-" * 30);
  console.log("Example: GET /api/policy/health");
  console.log("Status: 200");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        status: "success",
        message: "Policy service is healthy",
        timestamp: "2024-01-15T10:30:00.000Z",
        version: "1.0.0",
      },
      null,
      2
    )
  );

  // 201 Created - Resource Created
  console.log("\n📋 201 Created - Resource Created");
  console.log("-" * 30);
  console.log("Example: POST /api/tenants");
  console.log("Status: 201");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        status: "success",
        data: {
          _id: "507f1f77bcf86cd799439011",
          name: "Test Tenant",
          code: "TEST_TENANT",
          domain: "test.example.com",
          status: "active",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:00.000Z",
        },
      },
      null,
      2
    )
  );

  // 400 Bad Request - Client Error
  console.log("\n📋 400 Bad Request - Client Error");
  console.log("-" * 30);
  console.log("Example: Missing authorization header");
  console.log("Status: 400");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Authorization header required",
          code: "BAD_REQUEST",
          status: 400,
          tokenError: true,
          missingHeader: true,
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174000",
      },
      null,
      2
    )
  );

  // 401 Unauthorized - Authentication Required
  console.log("\n📋 401 Unauthorized - Authentication Required");
  console.log("-" * 30);
  console.log("Example: Invalid JWT token");
  console.log("Status: 401");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Invalid or expired token",
          code: "UNAUTHORIZED",
          status: 401,
          tokenError: true,
          jwtError: "invalid signature",
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174001",
      },
      null,
      2
    )
  );

  // 403 Forbidden - Access Denied
  console.log("\n📋 403 Forbidden - Access Denied");
  console.log("-" * 30);
  console.log("Example: Insufficient permissions");
  console.log("Status: 403");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Insufficient permissions to access this resource",
          code: "FORBIDDEN",
          status: 403,
          requiredPermission: "tenant:admin",
          userPermissions: ["tenant:read"],
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174002",
      },
      null,
      2
    )
  );

  // 404 Not Found - Resource Not Found
  console.log("\n📋 404 Not Found - Resource Not Found");
  console.log("-" * 30);
  console.log("Example: GET /api/tenants/invalid-id");
  console.log("Status: 404");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Tenant not found",
          code: "NOT_FOUND",
          status: 404,
          resource: "tenant",
          resourceId: "invalid-id",
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174003",
      },
      null,
      2
    )
  );

  // 409 Conflict - Resource Conflict
  console.log("\n📋 409 Conflict - Resource Conflict");
  console.log("-" * 30);
  console.log("Example: POST /api/users/register (user already exists)");
  console.log("Status: 409");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "User already exists",
          code: "CONFLICT",
          status: 409,
          conflictField: "email",
          conflictValue: "user@example.com",
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174004",
      },
      null,
      2
    )
  );

  // 422 Unprocessable Entity - Validation Error
  console.log("\n📋 422 Unprocessable Entity - Validation Error");
  console.log("-" * 30);
  console.log("Example: POST /api/roles (validation failed)");
  console.log("Status: 422");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Validation Error",
          code: "VALIDATION_ERROR",
          status: 422,
          details: [
            "Name is required",
            "Code must be at least 3 characters long",
            "Description is required",
          ],
          validationErrors: {
            name: "Name is required",
            code: "Code must be at least 3 characters long",
            description: "Description is required",
          },
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174005",
      },
      null,
      2
    )
  );

  // 500 Internal Server Error - Server Error
  console.log("\n📋 500 Internal Server Error - Server Error");
  console.log("-" * 30);
  console.log("Example: Database connection failed");
  console.log("Status: 500");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Internal server error",
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174006",
      },
      null,
      2
    )
  );

  // 500 Internal Server Error - Development Mode (with stack trace)
  console.log("\n📋 500 Internal Server Error - Development Mode");
  console.log("-" * 30);
  console.log("Example: Unhandled exception (NODE_ENV=development)");
  console.log("Status: 500");
  console.log("Response:");
  console.log(
    JSON.stringify(
      {
        success: false,
        error: {
          message: "Cannot read property 'name' of undefined",
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
          stack:
            "TypeError: Cannot read property 'name' of undefined\n    at UserController.createUser (/app/controllers/user.controller.js:45:12)\n    at processTicksAndRejections (internal/process/task_queues.js:95:5)",
        },
        correlationId: "123e4567-e89b-12d3-a456-426614174007",
      },
      null,
      2
    )
  );

  console.log("\n" + "=" * 60);
  console.log("🎯 Status Code Response Examples Complete!");
  console.log("\nKey Features:");
  console.log("✅ Consistent error response format");
  console.log("✅ Correlation ID for request tracking");
  console.log("✅ Structured error codes");
  console.log("✅ Production-safe error messages");
  console.log("✅ Development mode stack traces");
  console.log("✅ Detailed validation error information");
}

// Helper function to repeat strings
String.prototype.repeat = function (count) {
  return new Array(count + 1).join(this);
};

demonstrateStatusCodes().catch(console.error);
