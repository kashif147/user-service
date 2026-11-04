/**
 * PDP rollout P2 (review-package A.5): contact / contact-type reads.
 *   - CRM-only (requireCrmUser after the PDP check): PORTAL, SYSTEM or a missing userType -> 403.
 *   - Non-ASU CRM caller (tenant permissions without "*"): picker projection only (_id, forename, surname,
 *     contactTypeId) on GET /contacts, /contacts/search and /contacts/:id; search by name only.
 *   - ASU ("*"): full fields unchanged; ?view=picker opts into the picker.
 *   - ?contactType=<contactType|code> filters server-side for every caller.
 * The PDP is stubbed to PERMIT and set req.user from test headers; contact:read itself is the PDP's job.
 */
const express = require("express");
const request = require("supertest");

const mockCalls = [];
const mockTypes = [
  { _id: "t-sp", contactType: "Service Provider", code: "SP" },
  { _id: "t-sol", contactType: "Solicitor", code: "SOL" },
];
const chain = (rec, result) => {
  const q = {
    populate: (...a) => ((rec.populate = a), q),
    select: (s) => ((rec.select = s), q),
    sort: (s) => ((rec.sort = s), q),
    limit: (n) => ((rec.limit = n), q),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return q;
};
jest.mock("../models/contact", () => ({
  find: (query) => {
    const rec = { op: "find", query };
    mockCalls.push(rec);
    return chain(rec, [{ _id: "c1", forename: "A", surname: "B" }]);
  },
  findOne: (query) => {
    const rec = { op: "findOne", query };
    mockCalls.push(rec);
    return chain(rec, { _id: "c1", forename: "A", surname: "B" });
  },
}));
jest.mock("../models/contactType", () => ({
  find: (query) => {
    const rec = { op: "types", query };
    mockCalls.push(rec);
    const v = query.$or[0].contactType;
    return chain(rec, mockTypes.filter((t) => t.contactType === v || t.code === v).map((t) => ({ _id: t._id })));
  },
}));
jest.mock("../controllers/contactType.controller", () =>
  new Proxy({}, { get: (_t, name) => (req, res) => res.status(200).json({ handler: `contactType.${String(name)}` }) })
);
jest.mock("../helpers/policyAdapter", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => {
      const u = req.headers["x-test-user"];
      if (!u) return res.status(403).json({ policy: `${resource}:${action}` });
      req.user = JSON.parse(u);
      req.policyChecked = `${resource}:${action}`;
      return next();
    },
  },
}));
jest.mock("../middlewares/requirePlatformPermission", () => ({ requirePlatformPermission: () => (req, res) => res.status(298).json({ platform: true }) }));

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", require("../routes/contact.routes"));
  a.use("/api", require("../routes/contactType.routes"));
  a.use((err, req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  return a;
}
const MO = { id: "u1", tenantId: "t1", userType: "CRM", roles: ["MO"], permissions: ["contact:read", "issues:read"] };
const ASU = { id: "u2", tenantId: "t1", userType: "CRM", roles: ["ASU"], permissions: ["*"] };
const as = (u) => ({ "x-test-user": JSON.stringify(u) });
const VALID_ID = "507f1f77bcf86cd799439011";
const PICKER = "_id forename surname contactTypeId";

beforeEach(() => {
  mockCalls.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("CRM-only contact / contact-type reads", () => {
  const routes = ["/api/contacts", "/api/contacts/search?q=ab", `/api/contacts/${VALID_ID}`, "/api/contact-types", "/api/contact-types/search?q=ab", `/api/contact-types/${VALID_ID}`];
  test.each(routes)("%s: PORTAL / SYSTEM / missing userType -> 403 CRM_USER_REQUIRED", async (url) => {
    for (const userType of ["PORTAL", "SYSTEM", undefined, ""]) {
      const r = await request(app()).get(url).set(as({ ...MO, userType }));
      expect([userType, r.status, r.body.error && r.body.error.code]).toEqual([userType, 403, "CRM_USER_REQUIRED"]);
    }
    expect(mockCalls).toEqual([]);
  });
  test.each(routes)("%s: CRM caller passes (after the PDP contact:read check)", async (url) => {
    const r = await request(app()).get(url).set(as(MO));
    expect(r.status).toBe(200);
  });
  test.each(routes)("%s: PDP deny stays a deny", async (url) => {
    const r = await request(app()).get(url);
    expect(r.body).toEqual({ policy: "contact:read" });
  });
  test("writes are unchanged (platform authority, not requireCrmUser)", async () => {
    expect((await request(app()).post("/api/contacts").set(as({ ...MO, userType: "PORTAL" })).send({})).status).toBe(298);
  });
});

describe("GET /contacts projection", () => {
  test("non-ASU CRM: picker projection only", async () => {
    const r = await request(app()).get("/api/contacts").set(as(MO));
    expect(r.status).toBe(200);
    expect(mockCalls).toEqual([expect.objectContaining({ op: "find", query: { isdeleted: false }, select: PICKER })]);
  });
  test("non-ASU CRM cannot opt out of the picker", async () => {
    await request(app()).get("/api/contacts?view=full").set(as(MO));
    expect(mockCalls[0].select).toBe(PICKER);
  });
  test("ASU: full fields unchanged", async () => {
    await request(app()).get("/api/contacts").set(as(ASU));
    expect(mockCalls[0].select).toMatch(/contactPhone/);
    expect(mockCalls[0].select).toMatch(/contactEmail/);
    expect(mockCalls[0].select).toMatch(/contactAddress/);
  });
  test("ASU: ?view=picker opts into the picker", async () => {
    await request(app()).get("/api/contacts?view=picker").set(as(ASU));
    expect(mockCalls[0].select).toBe(PICKER);
  });
  test.each([["Service Provider", ["t-sp"]], ["SOL", ["t-sol"]], ["Nope", []]])("?contactType=%s filters server-side", async (v, ids) => {
    await request(app()).get(`/api/contacts?contactType=${encodeURIComponent(v)}`).set(as(MO));
    const find = mockCalls.find((c) => c.op === "find");
    expect(find.query).toEqual({ isdeleted: false, contactTypeId: { $in: ids } });
    expect(find.select).toBe(PICKER);
  });
});

describe("GET /contacts/search and /contacts/:id", () => {
  test("non-ASU CRM search: name fields only, regex-escaped, picker projection", async () => {
    await request(app()).get("/api/contacts/search?q=a.b*").set(as(MO));
    const find = mockCalls.find((c) => c.op === "find");
    expect(find.query.$or).toEqual([{ surname: { $regex: "a\\.b\\*", $options: "i" } }, { forename: { $regex: "a\\.b\\*", $options: "i" } }]);
    expect(find.select).toBe(PICKER);
  });
  test("ASU search unchanged: phone/email searchable and returned", async () => {
    await request(app()).get("/api/contacts/search?q=ab").set(as(ASU));
    const find = mockCalls.find((c) => c.op === "find");
    expect(find.query.$or.map((o) => Object.keys(o)[0])).toEqual(["surname", "forename", "contactPhone", "contactEmail"]);
    expect(find.select).toMatch(/contactPhone/);
  });
  test("by id: picker for non-ASU, full for ASU", async () => {
    await request(app()).get(`/api/contacts/${VALID_ID}`).set(as(MO));
    expect(mockCalls[0].select).toBe(PICKER);
    mockCalls.length = 0;
    await request(app()).get(`/api/contacts/${VALID_ID}`).set(as(ASU));
    expect(mockCalls[0].select).toMatch(/contactEmail/);
  });
});
