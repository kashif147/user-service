/**
 * Phase 1C-2B — handler-level tenant scoping.
 *  - tenant.handler getAllTenants: ownTenantId restricts the Mongo query (not an in-memory filter).
 *  - role.handler updateRole (M1): tenant-scoped selector kept; only allow-listed fields are $set,
 *    so a body tenantId cannot move the role and _id / isSystemRole / audit fields are untouched.
 * Models are mocked; no DB.
 */
const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockRoleFindOne = jest.fn(async () => ({ _id: "r1", code: "CUSTOM", isSystemRole: false, permissions: [] }));

jest.mock("../models/tenant.model", () => ({
  find: (...a) => {
    mockFind(...a);
    return { sort: () => ({ select: async () => [] }) };
  },
  findOne: async (...a) => (mockFindOne(...a), null),
}));
jest.mock("../models/role.model", () => ({
  findOne: (...a) => mockRoleFindOne(...a),
  findOneAndUpdate: async (...a) => (mockFindOneAndUpdate(...a), { _id: "r1" }),
}));
jest.mock("../models/user.model", () => ({}));
jest.mock("../models/permission.model", () => ({ find: () => ({ select: async () => [] }) }));

const TenantHandler = require("../handlers/tenant.handler");
const RoleHandler = require("../handlers/role.handler");

const A = "68cbf7806080b4621d469d34";
const ASU = { roles: ["ASU"] };

beforeEach(() => {
  mockFind.mockClear();
  mockFindOne.mockClear();
  mockFindOneAndUpdate.mockClear();
  mockRoleFindOne.mockClear();
});

describe("tenant.handler getAllTenants", () => {
  test("ownTenantId is applied to the query (by _id or directoryId), alongside existing filters", async () => {
    await TenantHandler.getAllTenants({ status: "active", ownTenantId: A });
    expect(mockFind).toHaveBeenCalledWith({
      isActive: true,
      status: "active",
      $or: [{ _id: A }, { "authenticationConnections.directoryId": A }],
    });
  });

  test("without ownTenantId (SU) the query is unchanged: platform-wide", async () => {
    await TenantHandler.getAllTenants({ status: undefined, plan: undefined });
    expect(mockFind).toHaveBeenCalledWith({ isActive: true });
  });
});

describe("tenant.handler code/domain lookups (B2)", () => {
  test.each([["getTenantByCode", "code", "INMO"], ["getTenantByDomain", "domain", "inmo.example"]])(
    "%s: non-SU ownership is in the selector; no match returns null (-> 404)",
    async (fn, field, value) => {
      const out = await TenantHandler[fn](value, { ownTenantId: A });
      expect(mockFindOne).toHaveBeenCalledWith({
        [field]: value,
        isActive: true,
        $or: [{ _id: A }, { "authenticationConnections.directoryId": A }],
      });
      expect(out).toBeNull();
    }
  );

  test.each([["getTenantByCode", "code", "INMO"], ["getTenantByDomain", "domain", "inmo.example"]])(
    "%s: SU (no ownTenantId) keeps the platform-wide selector",
    async (fn, field, value) => {
      await TenantHandler[fn](value);
      expect(mockFindOne).toHaveBeenCalledWith({ [field]: value, isActive: true });
    }
  );
});

describe("role.handler updateRole (M1)", () => {
  test("selector stays { _id, tenantId } and only allow-listed fields are $set", async () => {
    await RoleHandler.updateRole(
      "r1",
      {
        name: "Renamed",
        description: "d",
        code: "NEWCODE",
        category: "CRM",
        level: 5,
        permissions: ["role:read"],
        isActive: false,
        tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa", // must not move the role
        _id: "bbbbbbbbbbbbbbbbbbbbbbbb", // must not overwrite _id
        isSystemRole: true, // must not flip system flag
        createdBy: "attacker",
        createdAt: 0,
        $unset: { tenantId: 1 }, // operator injection must be ignored
      },
      A,
      "u1",
      ASU
    );
    expect(mockRoleFindOne).toHaveBeenCalledWith({ _id: "r1", tenantId: A }); // persisted read is tenant-scoped
    const [selector, update, opts] = mockFindOneAndUpdate.mock.calls[0];
    expect(selector).toEqual({ _id: "r1", tenantId: A });
    expect(Object.keys(update)).toEqual(["$set"]);
    const set = update.$set;
    expect(set).toMatchObject({
      name: "Renamed",
      description: "d",
      code: "NEWCODE",
      category: "CRM",
      level: 5,
      permissions: ["role:read"],
      isActive: false,
      updatedBy: "u1",
    });
    for (const f of ["tenantId", "_id", "isSystemRole", "createdBy", "createdAt", "$unset"]) {
      expect(set).not.toHaveProperty(f);
    }
    expect(opts).toEqual({ new: true });
  });

  test("a body that only tries to change tenantId changes nothing but the audit fields", async () => {
    await RoleHandler.updateRole("r1", { tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa" }, A, "u1", ASU);
    const set = mockFindOneAndUpdate.mock.calls[0][1].$set;
    expect(Object.keys(set).sort()).toEqual(["updatedAt", "updatedBy"]);
  });

  test("allow-list contract", () => {
    expect(RoleHandler.ROLE_UPDATABLE_FIELDS).toEqual([
      "name",
      "code",
      "description",
      "category",
      "level",
      "permissions",
      "isActive",
    ]);
  });
});
