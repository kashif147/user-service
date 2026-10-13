/**
 * Phase 2a: helpers/portalRoleSync.js at portal sign-in.
 *  - The NON-MEMBER -> MEMBER upgrade is unchanged: a user whose only role is NON-MEMBER, or a new
 *    user, is upgraded to MEMBER when profile/subscription report an active membership.
 *  - It never assigns a role to a user without one (zero active roles is refused before this runs;
 *    REO/NON-MEMBER are no longer restored here).
 */
const mongoose = require("mongoose");

const T = "68cbf7806080b4621d469d34";
const NON_MEMBER = new mongoose.Types.ObjectId("68c6b4d1e42306a6836622cf");
const MEMBER = new mongoose.Types.ObjectId("68c6b4d1e42306a6836622cc");
const OTHER = new mongoose.Types.ObjectId("68c6b4d1e42306a6836622d2");

const mockMembership = { active: false, calls: 0 };
jest.mock("../models/role.model", () => ({
  findOne: async (q) => {
    const { Types } = require("mongoose");
    if (q.code === "NON-MEMBER") return { _id: new Types.ObjectId("68c6b4d1e42306a6836622cf"), code: "NON-MEMBER" };
    if (q.code === "MEMBER") return { _id: new Types.ObjectId("68c6b4d1e42306a6836622cc"), code: "MEMBER" };
    return null;
  },
}));
jest.mock("../services/membershipCheck.service", () => ({
  hasActiveMembership: async () => {
    mockMembership.calls++;
    return mockMembership.active;
  },
}));

const { syncPortalUserRolesFromMembership } = require("../helpers/portalRoleSync");

const user = (roles) => ({ roles, saved: 0, save: async function () { this.saved++; return this; } });

beforeEach(() => {
  mockMembership.active = false;
  mockMembership.calls = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("13 NON-MEMBER with an active membership -> upgraded to MEMBER (unchanged)", async () => {
  mockMembership.active = true;
  const u = user([NON_MEMBER]);
  const r = await syncPortalUserRolesFromMembership(u, "m@x.com", T);
  expect(r.assignedMemberFromCheck).toBe(true);
  expect(u.roles.map(String)).toEqual([String(MEMBER)]);
  expect(u.saved).toBe(1);
});

test("NON-MEMBER without an active membership -> stays NON-MEMBER, nothing saved", async () => {
  const u = user([NON_MEMBER]);
  await syncPortalUserRolesFromMembership(u, "m@x.com", T);
  expect(u.roles).toEqual([NON_MEMBER]);
  expect(u.saved).toBe(0);
});

test("new user (created with the connection's default role) with an active membership -> MEMBER", async () => {
  mockMembership.active = true;
  const u = user([NON_MEMBER]);
  await syncPortalUserRolesFromMembership(u, "n@x.com", T, { isNewUser: true });
  expect(u.roles.map(String)).toEqual([String(MEMBER)]);
});

test("new user without membership keeps its default role; no other role is added", async () => {
  const u = user([OTHER]);
  await syncPortalUserRolesFromMembership(u, "n@x.com", T, { isNewUser: true });
  expect(u.roles).toEqual([OTHER]);
  expect(mockMembership.calls).toBe(1);
  expect(u.saved).toBe(0);
});

test("11 a user with zero roles is never given NON-MEMBER (or anything) here", async () => {
  const u = user([]);
  await syncPortalUserRolesFromMembership(u, "z@x.com", T);
  expect(u.roles).toEqual([]);
  expect(u.saved).toBe(0);
  expect(mockMembership.calls).toBe(0);
});

test("a MEMBER (or other non-NON-MEMBER role) is not re-checked", async () => {
  const u = user([MEMBER]);
  await syncPortalUserRolesFromMembership(u, "m@x.com", T);
  expect(mockMembership.calls).toBe(0);
  expect(u.roles).toEqual([MEMBER]);
});
