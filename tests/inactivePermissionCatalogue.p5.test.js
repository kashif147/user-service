/**
 * P5 (B5): #42 against the DEV-shaped catalogue (tests/fixtures/p5-dev-catalogue-shape.json - 142 rows,
 * 128 active, code/resource/action/isActive only).
 *  - Every ACTIVE catalogue code keeps exactly its pre-#42 serialisation (`${resource}:${action}` lower-cased),
 *    whether the role stores the CODE or the ObjectId. The "active only" tests also pass on the pre-#42 handler.
 *  - Every INACTIVE code is dropped and never reappears as a literal.
 *  - Issuance reads the catalogue on every call: no cache sits between the Permission collection and the
 *    token claim, so a deactivation is honoured by the next login/refresh (no cached grant can restore it).
 */
const FIXTURE = require("./fixtures/p5-dev-catalogue-shape.json");

const mockState = { user: null, catalogue: FIXTURE.catalogue.map((d) => ({ ...d })) };

jest.mock("../models/permission.model", () => ({
  find: jest.fn(async (q) =>
    mockState.catalogue
      .filter((d) => {
        if (q.isActive !== undefined && d.isActive !== q.isActive) return false;
        if (q._id && q._id.$in) return q._id.$in.map(String).includes(String(d._id));
        if (q.code && q.code.$in) return q.code.$in.includes(d.code);
        return false;
      })
      .map((d) => ({ ...d })),
  ),
}));
jest.mock("../models/user.model", () => ({
  findOne: jest.fn(() => ({ populate: async () => mockState.user })),
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
// Any cache use on the issuance path fails the test.
const mockCacheUsed = jest.fn();
jest.mock("../services/cacheService", () =>
  new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : (...a) => mockCacheUsed(k, ...a)) }),
);
jest.mock("../services/permissionsService", () =>
  new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : (...a) => mockCacheUsed(k, ...a)) }),
);

const RoleHandler = require("../handlers/role.handler");

const TENANT = "t".repeat(24);
const issue = async (rolePermissions, code = "MO") => {
  mockState.user = {
    _id: "e".repeat(24),
    tenantId: TENANT,
    roles: [{ _id: "f".repeat(24), code, permissions: rolePermissions }],
  };
  return RoleHandler.getUserPermissions(mockState.user._id, TENANT);
};
const tokenOf = (d) => `${d.resource}:${d.action}`.toLowerCase();
const active = FIXTURE.catalogue.filter((d) => d.isActive);
const inactive = FIXTURE.catalogue.filter((d) => !d.isActive);

beforeEach(() => {
  mockState.catalogue = FIXTURE.catalogue.map((d) => ({ ...d }));
  mockCacheUsed.mockClear();
  for (const m of ["log", "warn", "error", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("fixture is the DEV shape (142 rows, 128 active, 14 inactive)", () => {
  expect([FIXTURE.catalogue.length, active.length, inactive.length]).toEqual([142, 128, 14]);
});

describe("active serialisation is unchanged", () => {
  test("a role holding every ACTIVE code (CODE form) gets exactly the pre-#42 token set", async () => {
    const out = await issue(active.map((d) => d.code));
    expect([...out].sort()).toEqual(FIXTURE.expectedActiveTokens);
  });
  test("a role holding every ACTIVE code (ObjectId form) gets exactly the pre-#42 token set", async () => {
    const out = await issue(active.map((d) => d._id));
    expect([...out].sort()).toEqual(FIXTURE.expectedActiveTokens);
  });
  test.each(active.map((d) => [d.code, d]))("%s -> its own resource:action", async (_c, d) => {
    expect(await issue([d.code])).toEqual([tokenOf(d)]);
  });
});

describe("inactive codes are never issued", () => {
  test("a role holding EVERY catalogue code gets only active tokens", async () => {
    const out = await issue(FIXTURE.catalogue.map((d) => d.code));
    expect([...out].sort()).toEqual(FIXTURE.expectedActiveTokens);
  });
  test.each(inactive.map((d) => [d.code, d]))("%s alone -> nothing (neither canonical nor literal)", async (_c, d) => {
    const out = await issue([d.code, d._id]);
    expect(out).toEqual([]);
    expect(out).not.toContain(d.code.toLowerCase());
  });
});

describe("no cache on the issuance path", () => {
  test("deactivating a code is honoured by the very next issuance", async () => {
    const d = active.find((x) => x.code === "USER_READ") || active[0];
    expect(await issue([d.code])).toEqual([tokenOf(d)]);
    mockState.catalogue.find((x) => x.code === d.code).isActive = false;
    expect(await issue([d.code])).toEqual([]);
    mockState.catalogue.find((x) => x.code === d.code).isActive = true;
    expect(await issue([d.code])).toEqual([tokenOf(d)]);
  });
  test("issuance never touches cacheService or permissionsService", async () => {
    await issue(FIXTURE.catalogue.map((d) => d.code));
    expect(mockCacheUsed).not.toHaveBeenCalled();
  });
});

test("ASU stays ['*'] with the DEV catalogue present", async () => {
  expect(await issue(FIXTURE.catalogue.map((d) => d.code), "ASU")).toEqual(["*"]);
});
