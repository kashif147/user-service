/**
 * PDP rollout P1: Permission.audience - optional enum CRM | PORTAL | BOTH, no default; selected by
 * permissionsService.getAllPermissions (stored and exposed only; the evaluator ignores it until P4/P5).
 */
jest.mock("../services/cacheService", () => ({ get: jest.fn(async () => null), set: jest.fn(async () => true), del: jest.fn(async () => true) }));
const mongoose = require("mongoose");
const Permission = require("../models/permission.model");

const base = { name: "Read Contacts", code: "CONTACT_READ", description: "d", resource: "contact", action: "read", category: "CRM", level: 1 };

describe("Permission.audience", () => {
  test.each(["CRM", "PORTAL", "BOTH"])("accepts %s", (audience) => {
    const doc = new Permission({ ...base, audience });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.audience).toBe(audience);
  });

  test.each(["ALL", "crm", "", "SYSTEM"])("rejects %j", (audience) => {
    const err = new Permission({ ...base, audience }).validateSync();
    expect(err && err.errors.audience).toBeDefined();
  });

  test("optional with no default: absent stays absent", () => {
    const doc = new Permission(base);
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.audience).toBeUndefined();
    expect(doc.toObject()).not.toHaveProperty("audience");
  });

  test("schema path: enum, not required, no default", () => {
    const p = Permission.schema.path("audience");
    // P5: LEGACY = explicitly left on the legacy category rule (a missing value is "not back-filled").
    expect(p.enumValues).toEqual(["CRM", "PORTAL", "BOTH", "LEGACY"]);
    expect(p.isRequired).toBeFalsy();
    expect(p.defaultValue).toBeUndefined();
  });
});

describe("permissionsService.getAllPermissions selects audience", () => {
  afterEach(() => jest.restoreAllMocks());
  test("projection includes audience alongside the existing fields", async () => {
    let projection;
    jest.spyOn(Permission, "find").mockImplementation(() => ({
      select(s) {
        projection = s;
        return { lean: async () => [] };
      },
    }));
    const svc = require("../services/permissionsService");
    jest.spyOn(console, "log").mockImplementation(() => {});
    await svc.getAllPermissions();
    expect(projection.split(/\s+/).sort()).toEqual(["action", "audience", "category", "code", "level", "name", "resource"]);
  });
});

describe("P5: catalogue unavailability is tagged; a cache-layer error is a miss, never the fallback", () => {
  afterEach(() => jest.restoreAllMocks());
  const quiet = () => ["log", "warn", "error"].forEach((m) => jest.spyOn(console, m).mockImplementation(() => {}));

  test("database error -> the fallback list, every row tagged source:'fallback'", async () => {
    quiet();
    const svc = require("../services/permissionsService");
    const cache = require("../services/cacheService");
    jest.spyOn(cache, "get").mockResolvedValue(null);
    jest.spyOn(Permission, "find").mockImplementation(() => { throw new Error("db down"); });
    const rows = await svc.getAllPermissions();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "fallback")).toBe(true);
  });

  test("cache read throws -> the database is read (no fallback); cache write throws -> database rows still served", async () => {
    quiet();
    const svc = require("../services/permissionsService");
    const cache = require("../services/cacheService");
    const DB = [{ code: "X_READ", resource: "x", action: "read", category: "CRM", audience: "CRM" }];
    jest.spyOn(cache, "get").mockRejectedValue(new Error("redis down"));
    jest.spyOn(cache, "set").mockRejectedValue(new Error("redis down"));
    jest.spyOn(Permission, "find").mockImplementation(() => ({ select: () => ({ lean: async () => DB }) }));
    const rows = await svc.getAllPermissions();
    expect(rows).toEqual(DB);
    expect(rows.some((r) => r.source === "fallback")).toBe(false);
  });
});

afterAll(() => mongoose.disconnect());
