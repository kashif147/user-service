/**
 * Phase 2a: authentication-connection provisioning rules (helpers/connectionDefaultRole.js), run
 * for real against in-memory Role / Permission models.
 *
 *  - defaultRoleId must be a role of the SAME organisation, active, of the connection's user type
 *    (Entra -> CRM, B2C -> PORTAL), not SU/ASU/isSystemRole/category SYSTEM, without reserved
 *    permissions.
 *  - autoProvisionUsers === true requires a valid default role when a connection is saved.
 *  - JIT: a configured but unusable default role refuses; an automatic connection without one
 *    (saved before Phase 2a) falls back to REO / NON-MEMBER with an id-only LEGACY_DEFAULT_ROLE
 *    warning (removed in Phase 2b).
 *  - Access: only ACTIVE roles of the organisation count.
 */
const ORG_A = "68cbf7806080b4621d469d34";
const ORG_B = "6acd6119b28a863c61361ae0";
const ORG_C = "7acd6119b28a863c61361ae0";
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const PERM_ADMIN = "70000000000000000000000a";
const PERM_READ = "70000000000000000000000b";
const PERM_GONE = "70000000000000000000000c";

const id = (n) => `5${String(n).padStart(23, "0")}`;
const mockRoles = [];
const mockRole = (n, o) => ({
  _id: id(n), tenantId: ORG_A, name: `Role ${n}`, code: `R${n}`, category: "CRM", isActive: true,
  isSystemRole: false, level: 1, permissions: ["profile:read"], ...o,
});
const mockMatch = (r, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });
const mockChain = (rows) => {
  const c = {
    select: () => c,
    sort: () => c,
    lean: async () => rows.map((r) => ({ ...r })),
    then: (a, b) => Promise.resolve(rows).then(a, b),
  };
  return c;
};

jest.mock("../models/role.model", () => ({
  findOne: (q) => {
    const r = mockRoles.find((x) => mockMatch(x, q));
    return { select() { return this; }, lean: async () => (r ? { ...r } : null) };
  },
  find: (q) => mockChain(mockRoles.filter((x) => mockMatch(x, q))),
  countDocuments: async (q) => mockRoles.filter((x) => mockMatch(x, q)).length,
}));
jest.mock("../models/permission.model", () => {
  const perms = [
    { _id: "70000000000000000000000a", resource: "admin", action: "cache" },
    { _id: "70000000000000000000000b", resource: "profile", action: "read" },
  ];
  return {
    find: (q) => ({
      select: () => ({ lean: async () => perms.filter((p) => q._id.$in.includes(p._id)) }),
    }),
  };
});

const H = require("../helpers/connectionDefaultRole");

let warns;
beforeEach(() => {
  mockRoles.length = 0;
  mockRoles.push(
    mockRole(1, { code: "REO", name: "Read Only" }), // eligible CRM
    mockRole(2, { code: "NON-MEMBER", category: "PORTAL" }), // eligible PORTAL
    mockRole(3, { code: "REO", tenantId: ORG_B }), // other organisation
    mockRole(4, { isActive: false }), // inactive
    mockRole(5, { code: "SU", category: "SYSTEM", isSystemRole: true, level: 100 }),
    mockRole(6, { code: "ASU", category: "CRM", level: 1 }), // reserved code, mis-categorised
    mockRole(7, { code: "PLATFORM", isSystemRole: true }),
    mockRole(8, { code: "SYS", category: "SYSTEM" }),
    mockRole(9, { permissions: ["profile:read", "*"] }),
    mockRole(10, { permissions: ["TENANT_CREATE"] }),
    mockRole(11, { permissions: [PERM_ADMIN] }), // ObjectId -> admin:cache (reserved)
    mockRole(12, { permissions: [PERM_READ, "profile:read"] }), // ObjectId -> profile:read (fine)
    mockRole(13, { permissions: [PERM_GONE] }), // unresolvable
    mockRole(14, { code: "MEMBER", category: "PORTAL", isActive: false }),
    // B2C provider rule fixtures (existing DEV data: staff roles carry category PORTAL)
    mockRole(15, { code: "MEMBER", category: "PORTAL", tenantId: ORG_B }),
    mockRole(16, { code: "GS", category: "PORTAL", level: 90 }),
    mockRole(17, { code: "NON-MEMBER", category: "PORTAL", tenantId: ORG_B }),
    mockRole(18, { code: "NON-MEMBER", category: "PORTAL", tenantId: ORG_C, isActive: false }),
    mockRole(19, { code: "DIR", category: "PORTAL" }),
  );
  warns = [];
  jest.spyOn(console, "warn").mockImplementation((...a) => warns.push(JSON.stringify(a)));
});
afterEach(() => jest.restoreAllMocks());

const check = (n, connectionType = ENTRA, tenantId = ORG_A) =>
  H.checkDefaultRole({ tenantId, connectionType, roleId: id(n) }).then((r) => r.reason);

describe("default role eligibility (save and login use the same rule)", () => {
  test("6 a valid role of the same organisation and type is accepted (CRM for Entra, PORTAL for B2C)", async () => {
    expect(await check(1, ENTRA)).toBeNull();
    expect(await check(2, B2C)).toBeNull();
    expect(await check(12, ENTRA)).toBeNull();
  });
  test("7 a role of ANOTHER organisation is rejected (looked up only inside this organisation)", async () => {
    expect(await check(3, ENTRA, ORG_A)).toBe("NOT_FOUND");
  });
  test("8 an inactive role is rejected", async () => {
    expect(await check(4)).toBe("INACTIVE");
  });
  test("9 SU / ASU / isSystemRole / category SYSTEM are rejected", async () => {
    for (const n of [5, 6, 7, 8]) expect(await check(n)).toBe("PROTECTED");
  });
  test("9b roles with reserved permissions (literal, CODE_FORMAT or ObjectId) are rejected; unresolvable ids fail closed", async () => {
    expect(await check(9)).toBe("RESERVED_PERMISSION");
    expect(await check(10)).toBe("RESERVED_PERMISSION");
    expect(await check(11)).toBe("RESERVED_PERMISSION");
    expect(await check(13)).toBe("UNVERIFIABLE_PERMISSION");
  });
  test("9c a role of the wrong user type is rejected (CRM role on B2C, PORTAL role on Entra)", async () => {
    expect(await check(1, B2C)).toBe("WRONG_TYPE");
    expect(await check(2, ENTRA)).toBe("WRONG_TYPE");
  });
  test("9d malformed / missing role ids are rejected", async () => {
    expect((await H.checkDefaultRole({ tenantId: ORG_A, connectionType: ENTRA, roleId: "x" })).reason).toBe("INVALID_ID");
    expect((await H.checkDefaultRole({ tenantId: ORG_A, connectionType: ENTRA, roleId: id(99) })).reason).toBe("NOT_FOUND");
  });
  test("role picker lists only eligible, active roles of THIS organisation for the type", async () => {
    expect((await H.eligibleDefaultRoles(ORG_A, ENTRA)).map((r) => r.code)).toEqual(["REO", "R12"]);
    expect((await H.eligibleDefaultRoles(ORG_A, B2C)).map((r) => r._id)).toEqual([id(2)]);
    expect((await H.eligibleDefaultRoles(ORG_B, B2C)).map((r) => r._id)).toEqual([id(17)]);
    expect(await H.eligibleDefaultRoles(ORG_C, B2C)).toEqual([]); // its NON-MEMBER is inactive
    expect((await H.eligibleDefaultRoles(ORG_B, ENTRA)).map((r) => r._id)).toEqual([id(3)]);
    await expect(H.eligibleDefaultRoles(ORG_A, "SAML")).rejects.toBeInstanceOf(H.ConnectionValidationError);
  });
});

describe("B2C (portal) provider rule: only the organisation's own active NON-MEMBER", () => {
  test("B2C NON-MEMBER of the same organisation is accepted", async () => {
    expect(await check(2, B2C, ORG_A)).toBeNull();
    expect(await check(17, B2C, ORG_B)).toBeNull();
  });
  test("B2C MEMBER is rejected as the configured JIT default (portalRoleSync upgrades instead)", async () => {
    expect(await check(15, B2C, ORG_B)).toBe("NOT_PORTAL_DEFAULT");
  });
  test("B2C staff roles (GS, DIR) are rejected even though their category is PORTAL", async () => {
    expect(await check(16, B2C)).toBe("NOT_PORTAL_DEFAULT");
    expect(await check(19, B2C)).toBe("NOT_PORTAL_DEFAULT");
  });
  test("B2C REO / SU are rejected", async () => {
    expect(await check(1, B2C)).toBe("WRONG_TYPE");
    expect(await check(5, B2C)).toBe("PROTECTED");
  });
  test("B2C NON-MEMBER of another organisation is rejected", async () => {
    expect(await check(17, B2C, ORG_A)).toBe("NOT_FOUND");
  });
  test("inactive NON-MEMBER is rejected", async () => {
    expect(await check(18, B2C, ORG_C)).toBe("INACTIVE");
  });
  test("save: B2C automatic connection with GS or MEMBER -> 400 with the provider message", async () => {
    for (const [tenantId, n] of [[ORG_A, 16], [ORG_B, 15]]) {
      await expect(H.assertConnectionWritable(tenantId, { connectionType: B2C, autoProvisionUsers: true, defaultRoleId: id(n) }))
        .rejects.toMatchObject({ status: 400, message: "Portal (Azure B2C) connections must use this organisation's NON-MEMBER role as the default role" });
    }
    await expect(H.assertConnectionWritable(ORG_A, { connectionType: B2C, autoProvisionUsers: true, defaultRoleId: id(2) })).resolves.toBeUndefined();
  });
  test("JIT revalidates: a B2C connection whose stored default is GS / MEMBER / inactive NON-MEMBER refuses", async () => {
    for (const [tenantId, n] of [[ORG_A, 16], [ORG_B, 15], [ORG_C, 18]]) {
      await expect(H.resolveJitDefaultRoleId({ tenantId, connection: { connectionType: B2C, autoProvisionUsers: true, defaultRoleId: id(n) }, userType: "PORTAL" }))
        .rejects.toBeInstanceOf(H.DefaultRoleError);
    }
    expect(String(await H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: { connectionType: B2C, autoProvisionUsers: true, defaultRoleId: id(2) }, userType: "PORTAL" }))).toBe(id(2));
  });
  test("Entra CRM configurable default still works (any eligible CRM role)", async () => {
    expect(await check(1, ENTRA)).toBeNull();
    expect(await check(12, ENTRA)).toBeNull();
    expect(String(await H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: { connectionType: ENTRA, autoProvisionUsers: true, defaultRoleId: id(12) }, userType: "CRM" }))).toBe(id(12));
  });
});

describe("saving a connection", () => {
  const save = (c) => H.assertConnectionWritable(ORG_A, { connectionType: ENTRA, ...c });
  test("automatic provisioning without a default role -> 400", async () => {
    await expect(save({ autoProvisionUsers: true })).rejects.toMatchObject({ status: 400, message: "Automatic user provisioning requires a default role" });
  });
  test("automatic provisioning with an invalid role -> 400 with the reason", async () => {
    await expect(save({ autoProvisionUsers: true, defaultRoleId: id(5) })).rejects.toMatchObject({ status: 400, message: "Privileged or system roles cannot be a default role" });
    await expect(save({ autoProvisionUsers: true, defaultRoleId: id(3) })).rejects.toMatchObject({ status: 400, message: "Default role was not found in this organisation" });
    await expect(save({ autoProvisionUsers: true, defaultRoleId: id(4) })).rejects.toMatchObject({ status: 400, message: "Default role is inactive" });
  });
  test("automatic provisioning with a valid role, or pre-authorised without one -> accepted", async () => {
    await expect(save({ autoProvisionUsers: true, defaultRoleId: id(1) })).resolves.toBeUndefined();
    await expect(save({ autoProvisionUsers: false })).resolves.toBeUndefined();
    await expect(save({})).resolves.toBeUndefined();
  });
  test("a non-boolean flag is rejected (no 'yes'/'true' strings)", async () => {
    await expect(save({ autoProvisionUsers: "true", defaultRoleId: id(1) })).rejects.toMatchObject({ status: 400 });
    await expect(save({ autoProvisionUsers: null })).rejects.toMatchObject({ status: 400 });
  });
  test("a default role on a pre-authorised connection is still validated", async () => {
    await expect(save({ autoProvisionUsers: false, defaultRoleId: id(5) })).rejects.toMatchObject({ status: 400 });
  });
});

describe("full authenticationConnections array (Tenant Management form / PUT /tenants/:id)", () => {
  const C1 = "c10000000000000000000001";
  const C2 = "c10000000000000000000002";
  const stored = () => [
    { _id: C1, connectionType: ENTRA, directoryId: "d1", issuerUrl: "i", audience: "a", isActive: true, autoProvisionUsers: true, createdAt: "2026-01-01" },
    { _id: C2, connectionType: B2C, directoryId: "d2", issuerUrl: "i", audience: "a", isActive: true, autoProvisionUsers: false, createdAt: "2026-01-02" },
  ];
  test("unchanged connections pass as stored (a legacy automatic one without a role is grandfathered)", async () => {
    const out = await H.prepareConnectionsForWrite(ORG_A, stored(), stored());
    expect(out.map((c) => c._id)).toEqual([C1, C2]);
    expect(out[0].createdAt).toBe("2026-01-01");
  });
  test("a changed connection must satisfy the rules: enabling automatic without a role -> 400", async () => {
    const body = stored();
    body[1].autoProvisionUsers = true;
    await expect(H.prepareConnectionsForWrite(ORG_A, body, stored())).rejects.toMatchObject({ status: 400 });
  });
  test("changing an automatic connection forces a valid role; a valid one is accepted", async () => {
    const body = stored();
    body[0].audience = "changed";
    await expect(H.prepareConnectionsForWrite(ORG_A, body, stored())).rejects.toMatchObject({ status: 400 });
    body[0].defaultRoleId = id(1);
    const out = await H.prepareConnectionsForWrite(ORG_A, body, stored());
    expect(out[0]).toMatchObject({ _id: C1, audience: "changed", defaultRoleId: id(1) });
  });
  test("new connections (no or unknown _id) are validated; unknown fields are dropped", async () => {
    const body = [...stored(), { _id: "ffffffffffffffffffffffff", connectionType: B2C, autoProvisionUsers: true, defaultRoleId: id(1), evil: 1 }];
    await expect(H.prepareConnectionsForWrite(ORG_A, body, stored())).rejects.toMatchObject({ status: 400, message: "Default role does not match the connection's user type" });
    body[2].defaultRoleId = id(2);
    const out = await H.prepareConnectionsForWrite(ORG_A, body, stored());
    expect(out[2]._id).toBeUndefined();
    expect(out[2].evil).toBeUndefined();
  });
  test("not an array -> 400", async () => {
    await expect(H.prepareConnectionsForWrite(ORG_A, { 0: {} }, stored())).rejects.toMatchObject({ status: 400 });
  });
});

describe("JIT default role at sign-in", () => {
  const conn = (o) => ({ _id: "c10000000000000000000009", connectionType: ENTRA, autoProvisionUsers: true, ...o });
  test("configured valid role -> that role", async () => {
    expect(String(await H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: conn({ defaultRoleId: id(1) }), userType: "CRM" }))).toBe(id(1));
    expect(warns.join()).not.toContain("LEGACY_DEFAULT_ROLE");
  });
  test("10 configured role deleted / deactivated / made privileged after saving -> JIT refused", async () => {
    for (const roleId of [id(99), id(4), id(5)]) {
      await expect(H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: conn({ defaultRoleId: roleId }), userType: "CRM" }))
        .rejects.toBeInstanceOf(H.DefaultRoleError);
    }
  });
  test("2a migration: automatic connection without a role -> legacy REO / NON-MEMBER + id-only LEGACY_DEFAULT_ROLE", async () => {
    expect(String(await H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: conn({}), userType: "CRM" }))).toBe(id(1));
    expect(String(await H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: conn({ connectionType: B2C }), userType: "PORTAL" }))).toBe(id(2));
    const legacy = warns.filter((w) => w.includes("LEGACY_DEFAULT_ROLE"));
    expect(legacy).toHaveLength(2);
    expect(legacy[0]).toContain(ORG_A);
    expect(legacy.join()).not.toMatch(/@/);
  });
  test("2a migration: legacy role missing in the organisation -> JIT refused", async () => {
    mockRoles.splice(0, mockRoles.length, ...mockRoles.filter((r) => r.code !== "REO"));
    await expect(H.resolveJitDefaultRoleId({ tenantId: ORG_A, connection: conn({}), userType: "CRM" })).rejects.toBeInstanceOf(H.DefaultRoleError);
  });
});

describe("11 access requires at least one ACTIVE role of the organisation", () => {
  test("zero roles, only inactive roles, or only another organisation's roles -> no access", async () => {
    expect(await H.hasActiveRoleInTenant({ roles: [] }, ORG_A)).toBe(false);
    expect(await H.hasActiveRoleInTenant({}, ORG_A)).toBe(false);
    expect(await H.hasActiveRoleInTenant({ roles: [id(4), id(14)] }, ORG_A)).toBe(false);
    expect(await H.hasActiveRoleInTenant({ roles: [id(3)] }, ORG_A)).toBe(false);
  });
  test("one active role of the organisation (id or populated doc) -> access", async () => {
    expect(await H.hasActiveRoleInTenant({ roles: [id(4), id(1)] }, ORG_A)).toBe(true);
    expect(await H.hasActiveRoleInTenant({ roles: [{ _id: id(2) }] }, ORG_A)).toBe(true);
  });
});
