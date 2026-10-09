/**
 * GET /api/me — CRM users get `assignedLocations` (regions / branches / work locations where
 * Lookup.officer is the user); PORTAL users don't. Models are mocks; cache disabled. No DB.
 */
process.env.REDIS_ENABLED = "false";

const TENANT = "68cbf7806080b4621d469d34";
const USER = "c00000000000000000000001";
const T_REGION = "a00000000000000000000001";
const T_BRANCH = "a00000000000000000000002";
const T_WORKLOC = "a00000000000000000000003";

const mockState = { user: null, lookupQueries: [] };

const chain = (result, onPopulate) => {
  const q = {
    populate: jest.fn((arg) => {
      if (onPopulate) onPopulate(arg);
      return q;
    }),
    select: jest.fn(() => q),
    sort: jest.fn(() => q),
    lean: jest.fn(async () => result),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return q;
};

jest.mock("../models/user.model", () => ({
  findOne: jest.fn(() => chain(mockState.user)),
}));
jest.mock("../models/role.model", () => ({ find: jest.fn(() => chain([])) }));
jest.mock("../models/permission.model", () => ({ find: jest.fn(() => chain([])) }));
jest.mock("../models/lookupType.model", () => ({
  find: jest.fn(() =>
    chain([
      { _id: "a00000000000000000000001", code: "REGION", lookuptype: "Region" },
      { _id: "a00000000000000000000002", code: "BRANCH", lookuptype: "Branch" },
      { _id: "a00000000000000000000003", code: "WORKLOC", lookuptype: "Work Location" },
    ])
  ),
}));
jest.mock("../models/lookup.model", () => ({
  find: jest.fn((sel) => {
    mockState.lookupQueries.push(sel);
    return chain([
      { _id: "b1", code: "R1", lookupname: "Dublin", lookuptypeId: "a00000000000000000000001", Parentlookupid: null },
      { _id: "b2", code: "B1", lookupname: "Dublin North", lookuptypeId: "a00000000000000000000002", Parentlookupid: { _id: "b1", lookupname: "Dublin" } },
      { _id: "b3", code: "W1", lookupname: "Beaumont", lookuptypeId: "a00000000000000000000003", Parentlookupid: { _id: "b2", lookupname: "Dublin North" } },
    ]);
  }),
}));

const { getMeProfile } = require("../controllers/me.controller");

const makeUser = (userType) => ({
  _id: { toString: () => USER },
  tenantId: TENANT,
  userType,
  isActive: true,
  roles: [],
  createdAt: new Date("2026-01-01"),
});

const run = async () => {
  const req = { headers: {}, ctx: { tenantId: TENANT, userId: USER } };
  const res = {
    statusCode: null,
    body: null,
    set: jest.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  await getMeProfile(req, res, next);
  return { res, next };
};

beforeEach(() => {
  mockState.lookupQueries = [];
});

test("CRM user gets assigned regions, branches and work locations", async () => {
  mockState.user = makeUser("CRM");
  const { res, next } = await run();

  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(200);
  const { assignedLocations } = res.body.data;
  expect(assignedLocations.regions.map((l) => l.lookupname)).toEqual(["Dublin"]);
  expect(assignedLocations.branches).toEqual([
    expect.objectContaining({ id: "b2", code: "B1", parentLookupId: "b1", parentLookupName: "Dublin" }),
  ]);
  expect(assignedLocations.workLocations).toEqual([
    expect.objectContaining({ id: "b3", parentLookupName: "Dublin North" }),
  ]);

  expect(mockState.lookupQueries).toHaveLength(1);
  const sel = mockState.lookupQueries[0];
  expect(sel.officer.toString()).toBe(USER);
  expect(sel.isdeleted).toBe(false);
  expect(sel.isactive).toBe(true);
  expect(sel.lookuptypeId.$in.sort()).toEqual([T_REGION, T_BRANCH, T_WORKLOC].sort());
});

test("PORTAL user has no assignedLocations and no lookup query", async () => {
  mockState.user = makeUser("PORTAL");
  const { res } = await run();

  expect(res.statusCode).toBe(200);
  expect(res.body.data.assignedLocations).toBeUndefined();
  expect(mockState.lookupQueries).toHaveLength(0);
});
