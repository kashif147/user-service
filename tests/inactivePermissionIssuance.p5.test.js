/**
 * P5 (B4): inactive catalogue permissions are never issued.
 *
 * handlers/role.handler.js getUserPermissions is the single source of the token `permissions` claim
 * (helpers/jwt.js generateToken -> login and helpers/refreshToken.js /auth/refresh both go through it).
 * A role entry resolved by the catalogue is issued only when the Permission has isActive !== false,
 * whether the role stores it as a CODE string or as the Permission's ObjectId. An inactive code is
 * "resolved" (dropped), never re-issued through the unresolved-literal branch. Non-catalogue literal
 * codes keep the pre-existing behaviour (issued lower-cased) - documented here, changed elsewhere if at all.
 */
const jwt = require("jsonwebtoken");

const mockState = { user: null, refreshUser: null };
const ID_ACTIVE = "a".repeat(24);
const ID_INACTIVE = "b".repeat(24);
const ID_LEGACY = "c".repeat(24); // isActive field missing (pre-dates the field) -> treated as active
const CATALOGUE = [
  { _id: ID_ACTIVE, code: "USER_READ", resource: "user", action: "read", isActive: true },
  { _id: ID_INACTIVE, code: "OLD_THING_READ", resource: "oldthing", action: "read", isActive: false },
  { _id: "d".repeat(24), code: "OLD_THING_WRITE", resource: "oldthing", action: "write", isActive: false },
  { _id: ID_LEGACY, code: "LEGACY_READ", resource: "legacy", action: "read" },
];

const matches = (doc, q) => {
  if (q.isActive !== undefined && doc.isActive !== q.isActive) return false;
  if (q._id && q._id.$in) return q._id.$in.map(String).includes(String(doc._id));
  if (q.code && q.code.$in) return q.code.$in.includes(doc.code);
  return false;
};

jest.mock("../models/permission.model", () => ({
  find: jest.fn(async (q) => mockCatalogueFind(q)),
}));
jest.mock("../models/user.model", () => ({
  findOne: jest.fn((q) => {
    if (q && Object.prototype.hasOwnProperty.call(q, "tokens.refresh_token")) return Promise.resolve(mockState.refreshUser);
    return { populate: async () => mockState.user };
  }),
  findByIdAndUpdate: jest.fn(async () => ({})),
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
function mockCatalogueFind(q) {
  return CATALOGUE.filter((d) => matches(d, q)).map((d) => ({ ...d }));
}

const RoleHandler = require("../handlers/role.handler");
const jwtHelper = require("../helpers/jwt");
const RefreshTokenHelper = require("../helpers/refreshToken");

const SECRET = "test-secret-b4";
const TENANT = "t".repeat(24);
const userWith = (rolePermissions, roleCode = "MEMBER", userType = "PORTAL") => ({
  _id: "e".repeat(24),
  tenantId: TENANT,
  userEmail: "member@example.test",
  userType,
  isActive: true,
  roles: [{ _id: "f".repeat(24), code: roleCode, name: roleCode, permissions: rolePermissions }],
  tokens: { refresh_token: "rt-opaque", refresh_token_expires_at: Date.now() + 60_000 },
});

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.JWT_EXPIRY = "1h";
});
beforeEach(() => {
  for (const m of ["log", "warn", "error", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const issue = async (perms, roleCode) => {
  mockState.user = userWith(perms, roleCode);
  return RoleHandler.getUserPermissions(mockState.user._id, TENANT);
};

describe("getUserPermissions - catalogue isActive", () => {
  test("active code is issued in canonical form", async () => {
    expect(await issue(["USER_READ"])).toEqual(["user:read"]);
  });

  test("active ObjectId is issued in canonical form", async () => {
    expect(await issue([ID_ACTIVE])).toEqual(["user:read"]);
  });

  test("permission with no isActive field (legacy doc) is still issued (isActive !== false)", async () => {
    expect(await issue(["LEGACY_READ", ID_LEGACY])).toEqual(["legacy:read"]);
  });

  test("inactive code is NOT issued", async () => {
    const out = await issue(["OLD_THING_READ", "USER_READ"]);
    expect(out).toEqual(["user:read"]);
    expect(out).not.toContain("oldthing:read");
  });

  test("inactive ObjectId is NOT issued", async () => {
    const out = await issue([ID_INACTIVE, ID_ACTIVE]);
    expect(out).toEqual(["user:read"]);
  });

  test("inactive code is NOT issued as a lower-cased literal either", async () => {
    const out = await issue(["OLD_THING_READ", "OLD_THING_WRITE"]);
    expect(out).toEqual([]);
    expect(out).not.toContain("old_thing_read");
    expect(out).not.toContain("old_thing_write");
  });

  test("documented, unchanged: a non-catalogue literal code is still issued lower-cased", async () => {
    const out = await issue(["ACCOUNT_READ", "READ_ONLY", "USER_READ"]);
    expect(out.sort()).toEqual(["account_read", "read_only", "user:read"]);
  });

  test("ASU still receives exactly ['*'] (computed, catalogue not consulted)", async () => {
    const Permission = require("../models/permission.model");
    Permission.find.mockClear();
    expect(await issue(["OLD_THING_READ", ID_INACTIVE], "ASU")).toEqual(["*"]);
    expect(Permission.find).not.toHaveBeenCalled();
  });
});

describe("token issuance paths are consistent", () => {
  const MIXED = ["USER_READ", "OLD_THING_READ", ID_INACTIVE, "ACCOUNT_READ"];

  test("generateToken (login) carries only active + unchanged literal permissions", async () => {
    mockState.user = userWith(MIXED);
    const { token } = await jwtHelper.generateToken(mockState.user);
    const claims = jwt.verify(token, SECRET);
    // Documented, unchanged: jwt.js normalizePermission then rewrites the literal's "_" to ":", so the
    // non-catalogue code ACCOUNT_READ reaches the token claim as "account:read".
    expect(claims.permissions.sort()).toEqual(["account:read", "user:read"]);
    expect(claims.permissions).not.toContain("oldthing:read");
    expect(claims.permissions).not.toContain("old:thing:read");
  });

  test("/auth/refresh (RefreshTokenHelper) issues the same permission set as login", async () => {
    mockState.user = userWith(MIXED);
    mockState.refreshUser = mockState.user;
    const login = jwt.verify((await jwtHelper.generateToken(mockState.user)).token, SECRET).permissions;
    const res = await RefreshTokenHelper.validateAndRefresh("rt-opaque");
    const refreshed = jwt.verify(res.accessToken, SECRET).permissions;
    expect(refreshed.sort()).toEqual(login.sort());
    expect(refreshed).not.toContain("oldthing:read");
    expect(refreshed).not.toContain("old_thing_read");
    expect(refreshed).not.toContain("old:thing:read");
  });

  test("ASU token after refresh is still ['*']", async () => {
    mockState.user = userWith(MIXED, "ASU");
    mockState.refreshUser = mockState.user;
    const res = await RefreshTokenHelper.validateAndRefresh("rt-opaque");
    // Refresh serves PORTAL users only, so this holder is PORTAL + ASU: under P7
    // ROLE_CLASS_MODE=enforce the SYSTEM-class ASU is left out of a PORTAL token and "*" with it.
    const enforce = require("../helpers/roleClass").roleClassMode() === "enforce";
    expect(jwt.verify(res.accessToken, SECRET).permissions).toEqual(enforce ? [] : ["*"]);
  });
});
