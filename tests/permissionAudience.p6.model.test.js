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
    expect(p.enumValues).toEqual(["CRM", "PORTAL", "BOTH"]);
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

afterAll(() => mongoose.disconnect());
