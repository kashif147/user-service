/**
 * P5 identity - the second MEMBER grant path (members.subscription.current.updated.v1 and the
 * undo routing keys) follows the same rule as application.approval.listener (#47):
 *  - applicantIdentity.pending -> no lookup, no grant;
 *  - verified portal applicant / unmarked application events -> explicit userId in the event
 *    tenant only, never email;
 *  - crm_created and reliably non-application events (publisher origin, renewalBatchId, undo
 *    routing keys) keep the existing id -> email chain.
 * The User model is a fixture-backed mock that evaluates selectors; no DB / broker.
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

const { assignMemberRole } = require("../helpers/roleAssignment");
const promotion = require("../rabbitMQ/listeners/subscription.membership.promotion.listener");

const TA = "68cbf7806080b4621d469d34";
const TB = "aaaaaaaaaaaaaaaaaaaaaaaa";
const APPLICANT = "c00000000000000000000011"; // verified applicant, tenant A
const SAME_EMAIL = "c00000000000000000000012"; // another tenant-A portal user sharing the email
const OTHER_TENANT = "c00000000000000000000013"; // tenant B user
const STALE = "c0000000000000000000dead"; // id with no user
const EMAIL = "shared@example.com";

const VERIFIED = { source: "portal_submitter", verified: true, pending: null };
const PENDING = { source: "portal_submitter", verified: true, pending: "IDENTITY_LINK_PENDING" };
const CRM = { source: "crm_created", verified: false, pending: null };

function mkUser(_id, tenantId, email) {
  return { _id, tenantId, userType: "PORTAL", isActive: true, userEmail: email, roles: [], save: jest.fn(async () => {}) };
}
beforeEach(() => {
  mockQueries.length = 0;
  mockUsers.length = 0;
  mockUsers.push(mkUser(APPLICANT, TA, "applicant@example.com"), mkUser(SAME_EMAIL, TA, EMAIL), mkUser(OTHER_TENANT, TB, "b@example.com"));
  assignMemberRole.mockClear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const user = (id) => mockUsers.find((u) => u._id === id);
const emailQueries = () => mockQueries.filter((q) => q.userEmail !== undefined);
const currentUpdated = (data) =>
  promotion.handlePortalMemberPromotion({ data: { tenantId: TA, profileId: "p1", subscriptionId: "s1", ...data } }, { routingKey: promotion.SUBSCRIPTION_CURRENT_UPDATED });
const noGrant = () => {
  expect(assignMemberRole).not.toHaveBeenCalled();
  for (const u of mockUsers) expect(u.save).not.toHaveBeenCalled();
};

describe("classifyPromotion", () => {
  const C = promotion.SUBSCRIPTION_CURRENT_UPDATED;
  test.each([
    ["pending (portal)", { applicantIdentity: PENDING }, C, "none"],
    ["pending (crm_created)", { applicantIdentity: { ...CRM, pending: "IDENTITY_LINK_PENDING" } }, C, "none"],
    ["verified portal applicant", { applicantIdentity: VERIFIED }, C, "strict"],
    ["unknown identity source", { applicantIdentity: { source: "other" } }, C, "strict"],
    ["crm_created", { applicantIdentity: CRM }, C, "fallback"],
    ["unmarked (no origin)", {}, C, "strict"],
    ["application upsert origin, no identity", { origin: "application_upsert", applicationId: "a1" }, C, "strict"],
    ["unknown origin", { origin: "something_else" }, C, "strict"],
    ["stored applicationId alone does not classify", { applicationId: "a1" }, C, "strict"],
    ["profile upsert (no application)", { origin: "profile_upsert" }, C, "fallback"],
    ["renewal origin", { origin: "renewal_batch", applicationId: "a1" }, C, "fallback"],
    ["older renewal event (renewalBatchId only)", { renewalBatchId: "rb1" }, C, "fallback"],
    ["undo resignation routing key", { applicantIdentity: PENDING }, promotion.SUBSCRIPTION_RESIGNATION_UNDONE, "fallback"],
    ["undo cancellation routing key", {}, promotion.SUBSCRIPTION_CANCELLATION_UNDONE, "fallback"],
  ])("%s -> %s", (_n, data, rk, expected) => {
    expect(promotion.classifyPromotion(data, rk)).toBe(expected);
  });
});

describe("current.updated from an application approval", () => {
  test("valid: verified applicant id in tenant -> MEMBER granted to that user only", async () => {
    await currentUpdated({ applicationId: "a1", origin: "application_upsert", applicantIdentity: VERIFIED, userId: APPLICANT, userEmail: EMAIL });
    expect(assignMemberRole).toHaveBeenCalledTimes(1);
    expect(assignMemberRole).toHaveBeenCalledWith(user(APPLICANT), TA);
    expect(emailQueries()).toHaveLength(0);
  });

  test("pending: no lookup at all, no grant - even with a real stored userId and a matching email", async () => {
    await currentUpdated({ applicationId: "a1", origin: "application_upsert", applicantIdentity: PENDING, userId: SAME_EMAIL, userEmail: EMAIL });
    expect(mockQueries).toHaveLength(0);
    noGrant();
  });

  test("missing userId: no email fallback, no grant", async () => {
    await currentUpdated({ applicationId: "a1", applicantIdentity: VERIFIED, userId: null, userEmail: EMAIL });
    expect(mockQueries).toHaveLength(0);
    noGrant();
  });

  test("unknown (stale) userId: one id-in-tenant query, no email query, no grant", async () => {
    await currentUpdated({ applicationId: "a1", applicantIdentity: VERIFIED, userId: STALE, userEmail: EMAIL });
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toMatchObject({ tenantId: TA, userType: "PORTAL", isActive: true });
    expect(emailQueries()).toHaveLength(0);
    noGrant();
  });

  test("cross-tenant userId: only a tenant-A query, tenant-B user untouched", async () => {
    await currentUpdated({ applicationId: "a1", applicantIdentity: VERIFIED, userId: OTHER_TENANT, userEmail: "b@example.com" });
    expect(mockQueries.every((q) => q.tenantId === TA)).toBe(true);
    expect(emailQueries()).toHaveLength(0);
    noGrant();
  });

  test("non-ObjectId userId: no query, no grant", async () => {
    await currentUpdated({ applicationId: "a1", applicantIdentity: VERIFIED, userId: "not-an-id", userEmail: EMAIL });
    expect(mockQueries).toHaveLength(0);
    noGrant();
  });

  test("strict path with no tenant on the event: no {_id}-only lookup, no grant", async () => {
    await promotion.handlePortalMemberPromotion({ data: { applicantIdentity: VERIFIED, userId: APPLICANT, userEmail: EMAIL } }, { routingKey: promotion.SUBSCRIPTION_CURRENT_UPDATED });
    expect(mockQueries).toHaveLength(0);
    noGrant();
  });

  test("crm_created: existing chain preserved (no userId -> email in tenant)", async () => {
    await currentUpdated({ applicationId: "a1", origin: "application_upsert", applicantIdentity: CRM, userId: null, userEmail: EMAIL });
    expect(emailQueries()).toHaveLength(1);
    expect(emailQueries()[0]).toMatchObject({ tenantId: TA });
    expect(assignMemberRole).toHaveBeenCalledWith(user(SAME_EMAIL), TA);
  });
});

describe("older / unmarked events cannot bypass the rule", () => {
  test("unmarked application retry (stale id + matching email, no identity, no origin): no email query, no grant", async () => {
    await currentUpdated({ applicationId: "a1", userId: STALE, userEmail: EMAIL });
    expect(emailQueries()).toHaveLength(0);
    noGrant();
  });

  test("unmarked application retry with no userId + matching email: no query, no grant", async () => {
    await currentUpdated({ applicationId: "a1", userId: null, userEmail: EMAIL });
    expect(mockQueries).toHaveLength(0);
    noGrant();
  });

  test("application upsert from before the identity pass-through (origin set, identity absent): id-only", async () => {
    await currentUpdated({ applicationId: "a1", origin: "application_upsert", userId: STALE, userEmail: EMAIL });
    expect(emailQueries()).toHaveLength(0);
    noGrant();
  });

  test("unmarked event with a valid id in tenant: still granted (intermediate compatibility)", async () => {
    await currentUpdated({ applicationId: "a1", userId: APPLICANT, userEmail: EMAIL });
    expect(assignMemberRole).toHaveBeenCalledWith(user(APPLICANT), TA);
    expect(emailQueries()).toHaveLength(0);
  });
});

describe("non-application flows keep the existing chain", () => {
  test("renewal (origin) with a stored applicationId and no userId: email fallback still promotes", async () => {
    await currentUpdated({ applicationId: "a1", origin: "renewal_batch", userId: null, userEmail: EMAIL });
    expect(assignMemberRole).toHaveBeenCalledWith(user(SAME_EMAIL), TA);
  });

  test("older renewal event (renewalBatchId, no origin): email fallback still promotes", async () => {
    await currentUpdated({ applicationId: "a1", renewalBatchId: "rb1", userId: null, userEmail: EMAIL });
    expect(assignMemberRole).toHaveBeenCalledWith(user(SAME_EMAIL), TA);
  });

  test("profile upsert with no application (CRM user flow): email fallback still promotes", async () => {
    await currentUpdated({ applicationId: null, origin: "profile_upsert", userId: null, userEmail: EMAIL });
    expect(assignMemberRole).toHaveBeenCalledWith(user(SAME_EMAIL), TA);
  });

  test.each([["resignation"], ["cancellation"]])("undo %s routing key: email fallback still promotes", async (kind) => {
    const rk = kind === "resignation" ? promotion.SUBSCRIPTION_RESIGNATION_UNDONE : promotion.SUBSCRIPTION_CANCELLATION_UNDONE;
    await promotion.handlePortalMemberPromotion({ data: { tenantId: TA, applicationId: "a1", userId: null, userEmail: EMAIL } }, { routingKey: rk });
    expect(assignMemberRole).toHaveBeenCalledWith(user(SAME_EMAIL), TA);
  });
});

describe("logs are ids-only", () => {
  test("no email in any promotion log line (no-user and promoted cases)", async () => {
    await currentUpdated({ applicationId: "a1", origin: "renewal_batch", userId: null, userEmail: EMAIL });
    await currentUpdated({ applicationId: "a1", applicantIdentity: VERIFIED, userId: STALE, userEmail: EMAIL });
    const text = JSON.stringify([console.log.mock.calls, console.warn.mock.calls, console.error.mock.calls]);
    expect(text).not.toContain("@example.com");
    expect(text).toContain("classification");
  });
});
