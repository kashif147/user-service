jest.mock("../models/user.model", () => ({
  findOne: jest.fn(),
}));

jest.mock("../helpers/roleAssignment", () => ({
  assignMemberRole: jest.fn(),
}));

const mongoose = require("mongoose");
const User = require("../models/user.model");
const { assignMemberRole } = require("../helpers/roleAssignment");
const {
  classifyApplicant,
  handleApplicationApproved,
} = require("../rabbitMQ/listeners/application.approval.listener");

describe("application approval listener", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assignMemberRole.mockResolvedValue(true);
  });

  function makeUser(overrides = {}) {
    return {
      _id: new mongoose.Types.ObjectId("64f000000000000000000001"),
      tenantId: "tenant-1",
      userEmail: "member@example.com",
      roles: [],
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("promotes a portal user found by user-service document id", async () => {
    const portalUserId = "64f000000000000000000001";
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);

    await handleApplicationApproved({
      data: {
        applicationId: "app-1",
        tenantId: "tenant-1",
        userId: portalUserId,
        userEmail: "member@example.com",
      },
    });

    expect(User.findOne).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId(portalUserId),
      tenantId: "tenant-1",
      userType: "PORTAL",
      isActive: true,
    });
    expect(assignMemberRole).toHaveBeenCalledWith(user, "tenant-1");
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  // P5: the external-identity and email fallbacks are kept ONLY for an explicitly CRM-created event;
  // unmarked (older) and verified portal events use the explicit id in the event's tenant only.
  it("crm_created: falls back to tenant-scoped external identity fields", async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);

    await handleApplicationApproved({
      data: {
        applicationId: "app-1",
        tenantId: "tenant-1",
        userId: "b2c-subject-1",
        applicantIdentity: { source: "crm_created", verified: false, pending: null },
      },
    });

    expect(User.findOne).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userType: "PORTAL",
      isActive: true,
      $or: [
        { userMicrosoftId: "b2c-subject-1" },
        { userSubject: "b2c-subject-1" },
      ],
    });
    expect(assignMemberRole).toHaveBeenCalledWith(user, "tenant-1");
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  it("crm_created: falls back to case-insensitive email lookup when no user id matches", async () => {
    const user = makeUser();
    User.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(user);

    await handleApplicationApproved({
      data: {
        applicationId: "app-1",
        tenantId: "tenant-1",
        userId: "64f000000000000000000002",
        userEmail: "Member@Example.com",
        applicantIdentity: { source: "crm_created", verified: false, pending: null },
      },
    });

    expect(User.findOne).toHaveBeenLastCalledWith({
      userEmail: { $regex: /^member@example\.com$/i },
      tenantId: "tenant-1",
      userType: "PORTAL",
      isActive: true,
    });
    expect(assignMemberRole).toHaveBeenCalledWith(user, "tenant-1");
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});

describe("application approval listener - verified portal applicant (P5)", () => {
  const T = "tenant-1";
  const APPLICANT = "64f0000000000000000000a1";
  const VERIFIED = { source: "portal_submitter", verified: true, pending: null };
  const makeUser = (o = {}) => ({ _id: new mongoose.Types.ObjectId(APPLICANT), tenantId: T, userEmail: "member@example.com", roles: [], save: jest.fn(), ...o });
  const run = (data) => handleApplicationApproved({ data: { applicationId: "app-v", tenantId: T, userEmail: "member@example.com", effective: { contactInfo: { personalEmail: "member@example.com" } }, ...data } });
  const queries = () => User.findOne.mock.calls.map(([q]) => q);
  const noEmailOrExternal = () => {
    for (const q of queries()) {
      expect(q).not.toHaveProperty("userEmail");
      expect(q).not.toHaveProperty("$or");
      expect(q).toHaveProperty("tenantId", T); // never a tenantless lookup
    }
  };
  beforeEach(() => { jest.clearAllMocks(); assignMemberRole.mockResolvedValue(true); });

  it("classifies events", () => {
    expect(classifyApplicant({ applicantIdentity: VERIFIED })).toBe("verified");
    expect(classifyApplicant({ applicantIdentity: { source: "crm_created" } })).toBe("crm_created");
    expect(classifyApplicant({})).toBe("unmarked");
    expect(classifyApplicant({ applicantIdentity: "crm_created" })).toBe("unmarked");
    expect(classifyApplicant({ applicantIdentity: { source: "other" } })).toBe("unmarked");
  });

  it("valid: verified id in the event's tenant gets the grant", async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);
    await run({ userId: APPLICANT, applicantIdentity: VERIFIED });
    expect(User.findOne).toHaveBeenCalledTimes(1);
    expect(User.findOne).toHaveBeenCalledWith({ _id: new mongoose.Types.ObjectId(APPLICANT), tenantId: T, userType: "PORTAL", isActive: true });
    expect(assignMemberRole).toHaveBeenCalledWith(user, T);
  });

  it("missing: null userId -> no grant, no lookup by email", async () => {
    await run({ userId: null, applicantIdentity: VERIFIED });
    expect(User.findOne).not.toHaveBeenCalled();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("unknown: id not in user-service -> no grant, no email / external fallback", async () => {
    User.findOne.mockResolvedValue(null);
    await run({ userId: "64f0000000000000000000ff", applicantIdentity: VERIFIED });
    expect(User.findOne).toHaveBeenCalledTimes(1);
    noEmailOrExternal();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("cross-tenant: id belongs to another tenant -> no grant (lookup is tenant-scoped only)", async () => {
    // the user exists, but only under tenant-2: the tenant-1 scoped query finds nothing
    User.findOne.mockImplementation(async (q) => (q.tenantId === "tenant-2" ? makeUser({ tenantId: "tenant-2" }) : null));
    await run({ userId: APPLICANT, applicantIdentity: VERIFIED });
    noEmailOrExternal();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("non-ObjectId id (identity-provider subject) -> no grant, no external fallback", async () => {
    await run({ userId: "b2c-subject-1", applicantIdentity: VERIFIED });
    expect(User.findOne).not.toHaveBeenCalled();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("pending: IDENTITY_LINK_PENDING -> no grant and no lookup, even with a valid id or email", async () => {
    for (const ai of [{ ...VERIFIED, pending: "IDENTITY_LINK_PENDING" }, { source: "crm_created", verified: false, pending: "IDENTITY_LINK_PENDING" }]) {
      User.findOne.mockResolvedValue(makeUser());
      await run({ userId: APPLICANT, applicantIdentity: ai });
    }
    expect(User.findOne).not.toHaveBeenCalled();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("unmarked (older event / retry): explicit id in tenant only - no email or external fallback", async () => {
    User.findOne.mockResolvedValue(null);
    await run({ userId: "64f0000000000000000000ff" });
    expect(User.findOne).toHaveBeenCalledTimes(1);
    noEmailOrExternal();
    expect(assignMemberRole).not.toHaveBeenCalled();
    jest.clearAllMocks();
    await run({ userId: null }); // older CRM-created event without a user id: no grant until re-sent marked
    expect(User.findOne).not.toHaveBeenCalled();
    expect(assignMemberRole).not.toHaveBeenCalled();
  });

  it("unmarked with a valid id in tenant still gets the grant (intermediate deployment)", async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);
    await run({ userId: APPLICANT });
    expect(assignMemberRole).toHaveBeenCalledWith(user, T);
  });
});
