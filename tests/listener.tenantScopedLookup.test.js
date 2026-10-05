/**
 * Phase 1C-2E (M2) — RabbitMQ listeners never fall back to a { _id }-only user lookup when the
 * event carries tenant context.
 *
 * Listeners: membership demotion (members.subscription.resigned.v1 / cancel.grace.ended.v1),
 * membership promotion (current.updated / resignation.undone / cancellation.undone), and the
 * already-compliant application approval listener (applications.review.processed.v1).
 *
 * The User model is a fixture-backed mock that evaluates selectors (so a missing tenantId in a
 * selector really would match across tenants); roleAssignment helpers are spies. No DB / broker.
 */
const mockQueries = [];
const mockUsers = [];

function mockMatches(doc, sel) {
  return Object.entries(sel).every(([k, v]) => {
    if (k === "userEmail" && v && v.$regex) return v.$regex.test(doc.userEmail);
    return String(doc[k]) === String(v);
  });
}

jest.mock("../models/user.model", () => ({
  findOne: jest.fn(async (sel) => {
    mockQueries.push(sel);
    return mockUsers.find((u) => mockMatches(u, sel)) || null;
  }),
}));
jest.mock("../helpers/roleAssignment", () => ({
  assignMemberRole: jest.fn(async () => true),
  assignNonMemberRole: jest.fn(async () => true),
}));

const { assignMemberRole, assignNonMemberRole } = require("../helpers/roleAssignment");
const demotion = require("../rabbitMQ/listeners/subscription.membership.demotion.listener");
const promotion = require("../rabbitMQ/listeners/subscription.membership.promotion.listener");
const approval = require("../rabbitMQ/listeners/application.approval.listener");

const TA = "68cbf7806080b4621d469d34";
const TB = "aaaaaaaaaaaaaaaaaaaaaaaa";
const U_A = "c00000000000000000000001"; // portal user in tenant A
const U_B = "c00000000000000000000002"; // portal user in tenant B

function mkUser(_id, tenantId, email) {
  return { _id, tenantId, userType: "PORTAL", isActive: true, userEmail: email, roles: [], save: jest.fn(async () => {}) };
}
beforeEach(() => {
  mockQueries.length = 0;
  mockUsers.length = 0;
  mockUsers.push(mkUser(U_A, TA, "a@example.com"), mkUser(U_B, TB, "b@example.com"));
  assignMemberRole.mockClear();
  assignNonMemberRole.mockClear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const userB = () => mockUsers.find((u) => u._id === U_B);
const userA = () => mockUsers.find((u) => u._id === U_A);
const idOnlySelectors = () => mockQueries.filter((q) => q._id !== undefined && q.tenantId === undefined);
const noSideEffects = () => {
  expect(assignMemberRole).not.toHaveBeenCalled();
  expect(assignNonMemberRole).not.toHaveBeenCalled();
  for (const u of mockUsers) expect(u.save).not.toHaveBeenCalled();
};

const LISTENERS = [
  ["demotion", (p) => demotion.handlePortalMemberDemotion(p, { routingKey: demotion.SUBSCRIPTION_RESIGNED }), () => assignNonMemberRole],
  ["promotion", (p) => promotion.handlePortalMemberPromotion(p, { routingKey: promotion.SUBSCRIPTION_CURRENT_UPDATED }), () => assignMemberRole],
];

describe.each(LISTENERS)("%s listener", (_name, handle, assignFn) => {
  test("A tenant A event + tenant A user -> tenant-scoped lookup succeeds; role applied in tenant A", async () => {
    await handle({ data: { userId: U_A, tenantId: TA, profileId: "p1" } });
    expect(mockQueries[0]).toMatchObject({ tenantId: TA });
    expect(assignFn()).toHaveBeenCalledWith(userA(), TA);
    expect(userA().save).toHaveBeenCalledTimes(1);
    expect(idOnlySelectors()).toHaveLength(0);
  });

  test("B tenant A event + user _id from tenant B -> no match, NO {_id}-only fallback, tenant B user untouched", async () => {
    await handle({ data: { userId: U_B, tenantId: TA, profileId: "p1" } });
    expect(idOnlySelectors()).toHaveLength(0);
    expect(mockQueries.every((q) => q.tenantId === TA)).toBe(true);
    noSideEffects();
    expect(userB().save).not.toHaveBeenCalled();
  });

  test("C tenant A event + missing user -> no fallback by _id", async () => {
    await handle({ data: { userId: "c0000000000000000000dead", tenantId: TA } });
    expect(idOnlySelectors()).toHaveLength(0);
    noSideEffects();
  });

  test("C' tenant A event + tenant B user's email -> email lookup stays tenant-scoped (no match)", async () => {
    await handle({ data: { userId: U_B, userEmail: "b@example.com", tenantId: TA } });
    expect(mockQueries.every((q) => q.tenantId === TA)).toBe(true);
    noSideEffects();
  });

  test.each([[""], ["   "], ["\t\n"]])("D tenant present but empty/whitespace (%p) -> fail closed, no lookup at all", async (bad) => {
    await handle({ data: { userId: U_A, tenantId: bad } });
    expect(mockQueries).toHaveLength(0);
    noSideEffects();
  });

  test("normalisation: surrounding whitespace on a real tenantId is trimmed (not treated as malformed)", async () => {
    await handle({ data: { userId: U_A, tenantId: `  ${TA}  ` } });
    expect(mockQueries[0].tenantId).toBe(TA);
    expect(assignFn()).toHaveBeenCalledWith(userA(), TA);
  });

  test.each([[undefined], [null]])("E legacy event with no tenant field (%p) -> explicit {_id} branch preserved (user's own tenant)", async (t) => {
    const data = { userId: U_B };
    if (t === null) data.tenantId = null;
    await handle({ data });
    expect(idOnlySelectors()).toHaveLength(1);
    expect(assignFn()).toHaveBeenCalledWith(userB(), TB); // tenant taken from the found user, never guessed
  });

  test("E' legacy event with no tenant and no userId -> nothing (email lookup requires tenant)", async () => {
    await handle({ data: { userEmail: "b@example.com" } });
    expect(mockQueries).toHaveLength(0);
    noSideEffects();
  });

  test("F with tenant context present, only that tenant's user can ever be modified", async () => {
    await handle({ data: { userId: U_B, tenantId: TA } });
    await handle({ data: { userId: U_A, tenantId: TA } });
    expect(userB().save).not.toHaveBeenCalled();
    expect(userA().save).toHaveBeenCalledTimes(1);
    expect(assignFn()).toHaveBeenCalledTimes(1);
  });
});

test("resolveEventTenant contract (both listeners share it)", () => {
  for (const mod of [demotion, promotion]) {
    expect(mod.resolveEventTenant(undefined)).toEqual({ kind: "absent", tid: null });
    expect(mod.resolveEventTenant(null)).toEqual({ kind: "absent", tid: null });
    expect(mod.resolveEventTenant("")).toEqual({ kind: "malformed", tid: null });
    expect(mod.resolveEventTenant("  ")).toEqual({ kind: "malformed", tid: null });
    expect(mod.resolveEventTenant(` ${TA} `)).toEqual({ kind: "present", tid: TA });
  }
});

describe("application approval listener (already compliant, unchanged)", () => {
  test("B tenant A event + tenant B user id -> no {_id}-only fallback, no side effects", async () => {
    await approval.handleApplicationApproved({ data: { userId: U_B, tenantId: TA, applicationId: "x" } });
    expect(idOnlySelectors()).toHaveLength(0);
    noSideEffects();
  });

  test("missing tenant -> skipped before any lookup", async () => {
    await approval.handleApplicationApproved({ data: { userId: U_B, applicationId: "x" } });
    expect(mockQueries).toHaveLength(0);
    noSideEffects();
  });

  test("A tenant A event + tenant A user -> promoted in tenant A", async () => {
    await approval.handleApplicationApproved({ data: { userId: U_A, tenantId: TA, applicationId: "x" } });
    expect(assignMemberRole).toHaveBeenCalledWith(userA(), TA);
    expect(idOnlySelectors()).toHaveLength(0);
  });
});
