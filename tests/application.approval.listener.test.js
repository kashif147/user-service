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

  it("falls back to tenant-scoped external identity fields for older userId payloads", async () => {
    const user = makeUser();
    User.findOne.mockResolvedValueOnce(user);

    await handleApplicationApproved({
      data: {
        applicationId: "app-1",
        tenantId: "tenant-1",
        userId: "b2c-subject-1",
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

  it("falls back to case-insensitive email lookup when no user id matches", async () => {
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
