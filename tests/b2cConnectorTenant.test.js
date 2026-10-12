// Phase 2C Track B: the Azure B2C sign-up connector (POST /users/validate) resolves its
// TRUSTED tenant from the B2C app (client_id -> active "Azure B2C" connection audience),
// never from a tenantId in the body or a "default" fallback, and forwards to
// profile-service as a genuine internal call (x-internal-request + x-tenant-id).
const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const mockTenants = [
  { _id: A, authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-A", isActive: true }] },
  { _id: B, authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-B", isActive: true }] },
  { _id: "dup1", authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-shared", isActive: true }] },
  { _id: "dup2", authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-shared", isActive: true }] },
  { _id: "off", authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-off", isActive: false }] },
  // Phase 2E: two tenants share one B2C app; only the first auto-provisions (sign-up target).
  { _id: "prov", authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-sharedB", isActive: true }] },
  { _id: "noprov", authenticationConnections: [{ connectionType: "Azure B2C", audience: "app-sharedB", isActive: true, autoProvisionUsers: false }] },
];
jest.mock("../models/tenant.model", () => ({
  find: jest.fn((q) => {
    const m = q.authenticationConnections.$elemMatch;
    const rows = mockTenants.filter((t) => t.authenticationConnections.some((c) => c.connectionType === m.connectionType && c.audience === m.audience && c.isActive === m.isActive
      && (!m.autoProvisionUsers || c.autoProvisionUsers !== m.autoProvisionUsers.$ne)));
    const chain = { select: () => chain, limit: (n) => { chain._n = n; return chain; }, lean: async () => rows.slice(0, chain._n || rows.length) };
    return chain;
  }),
}));
const mockPosts = [];
let mockAxiosBehaviour = "ok";
jest.mock("axios", () => ({
  post: jest.fn(async (url, body, opts) => {
    mockPosts.push({ url, body, headers: opts.headers });
    if (mockAxiosBehaviour === "down") { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; }
    return { data: { version: "1.0.0", action: "Continue", tenantId: opts.headers["x-tenant-id"] } };
  }),
}));
const { validateUser } = require("../controllers/user.controller");

function call(body) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(payload) { this.headersSent = true; resolve({ code: this.code, body: payload }); return this; },
    };
    validateUser({ body, headers: {}, query: {} }, res, () => {});
  });
}
beforeEach(() => { mockPosts.length = 0; mockAxiosBehaviour = "ok"; });

test("1 an unknown B2C application cannot validate sign-up (no profile-service call)", async () => {
  const r = await call({ email: "x@example.test", step: "PostAttributeCollection", client_id: "app-unknown" });
  expect(r.body.action).toBe("ShowBlockPage");
  expect(mockPosts).toHaveLength(0);
});

test("2 an inactive connection or an ambiguous application (two tenants) fails closed", async () => {
  for (const client_id of ["app-off", "app-shared", undefined]) {
    const r = await call({ email: "x@example.test", client_id });
    expect(r.body.action).toBe("ShowBlockPage");
  }
  expect(mockPosts).toHaveLength(0);
});

test("3 the tenant comes from the B2C app, not from a tenantId in the body", async () => {
  const r = await call({ email: "x@example.test", step: "PostAttributeCollection", client_id: "app-A", tenantId: B });
  expect(r.body.action).toBe("Continue");
  expect(mockPosts).toHaveLength(1);
  expect(mockPosts[0].headers["x-internal-request"]).toBe("true");
  expect(mockPosts[0].headers["x-tenant-id"]).toBe(A);
});

test("4 each tenant's app resolves to its own tenant", async () => {
  await call({ email: "y@example.test", client_id: "app-B" });
  expect(mockPosts[0].headers["x-tenant-id"]).toBe(B);
});

test("5 profile-service down: fail-open continues with the TRUSTED tenant, never a default", async () => {
  mockAxiosBehaviour = "down";
  const r = await call({ email: "z@example.test", client_id: "app-B" });
  expect(r.body.action).toBe("Continue");
  expect(r.body.tenantId).toBe(B);
  expect(r.body.tenantId).not.toMatch(/default/);
});

test("6 a B2C app shared by two tenants signs up only into the auto-provisioning one (never a sign-in-only tenant)", async () => {
  const r = await call({ email: "s@example.test", step: "PostAttributeCollection", client_id: "app-sharedB" });
  expect(r.body.action).toBe("Continue");
  expect(mockPosts).toHaveLength(1);
  expect(mockPosts[0].headers["x-tenant-id"]).toBe("prov");
});
