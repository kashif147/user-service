/**
 * helpers/pkceStateStore.js - the nonce store the live CRM and B2C login flows rely on for
 * replay protection (see handlers/azure.ad.handler.js and handlers/b2c.users.handler.js).
 */
const {
  rememberStatePolicy,
  takePolicyForState,
  rememberNonceForState,
  takeNonceForState,
} = require("../helpers/pkceStateStore");

describe("nonce store", () => {
  test("stores and retrieves a nonce for a state", () => {
    rememberNonceForState("state-1", "nonce-1");
    expect(takeNonceForState("state-1")).toBe("nonce-1");
  });

  test("is single-use - a second read after consumption returns null", () => {
    rememberNonceForState("state-2", "nonce-2");
    expect(takeNonceForState("state-2")).toBe("nonce-2");
    expect(takeNonceForState("state-2")).toBeNull();
  });

  test("unknown state returns null", () => {
    expect(takeNonceForState("never-issued-state")).toBeNull();
  });

  test("expires after the TTL", () => {
    jest.useFakeTimers();
    try {
      rememberNonceForState("state-3", "nonce-3");
      jest.setSystemTime(Date.now() + 11 * 60 * 1000); // TTL is 10 minutes
      expect(takeNonceForState("state-3")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("nonce store is independent of the policy store for the same state key", () => {
    rememberStatePolicy("state-4", "B2C_1_signin");
    rememberNonceForState("state-4", "nonce-4");

    // Consuming the nonce must not affect the policy entry, and vice versa.
    expect(takeNonceForState("state-4")).toBe("nonce-4");
    expect(takePolicyForState("state-4")).toBe("B2C_1_signin");
  });
});
