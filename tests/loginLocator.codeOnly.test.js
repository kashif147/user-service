/**
 * Login locator hardening: the browser-facing sign-in selector (GET /pkce/generate?tenant=...) is the
 * Organisation Code ONLY. The internal tenant _id is backend-only and is never resolved from the
 * browser; it gets the same generic refusal as an unknown or unconfigured organisation. And no
 * unauthenticated organisation / tenant listing route exists (no public customer directory).
 */
const fs = require("fs");
const path = require("path");

const TENANT_A = "68cbf7806080b4621d469d34";
const ENTRA = "Entra ID (Azure AD)";
const mockQueries = [];
const mockTenants = [];
jest.mock("../models/tenant.model", () => ({
  find: (q) => {
    mockQueries.push(q);
    const rows = mockTenants.filter((t) => t.isActive !== false && t.code === q.code && q._id === undefined && q.$or === undefined);
    return { select: () => ({ lean: async () => JSON.parse(JSON.stringify(rows)) }) };
  },
}));

const { resolveLoginTenant } = require("../helpers/loginTenantContext");
const conn = (id, extra = {}) => ({ _id: id, connectionType: ENTRA, directoryId: "39866a06-30bc-4a89-80c6-9dd9357dd453", isActive: true, ...extra });
const codeOf = async (p) => p.then(() => "OK", (e) => e.code);

beforeEach(() => {
  mockQueries.length = 0;
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", isActive: true, authenticationConnections: [conn("connA")] },
    { _id: "6acd6119b28a863c61361ae0", code: "DEVTENANTB", isActive: true, authenticationConnections: [conn("connB")] },
    { _id: "cccccccccccccccccccccccc", code: "TWOENTRA", isActive: true, authenticationConnections: [conn("c1"), conn("c2")] },
    { _id: "dddddddddddddddddddddddd", code: "NOENTRA", isActive: true, authenticationConnections: [] },
    { _id: "eeeeeeeeeeeeeeeeeeeeeeee", code: "INACTIVEENTRA", isActive: true, authenticationConnections: [conn("c3", { isActive: false })] }
  );
});

test("1 the Organisation Code resolves (case-insensitive) to the internal tenant and its connection", async () => {
  await expect(resolveLoginTenant(" multiauth ")).resolves.toMatchObject({ tenantId: TENANT_A, connectionId: "connA" });
});

test("the query is by Organisation Code only: never an _id, never an $or", async () => {
  await resolveLoginTenant("MULTIAUTH");
  await resolveLoginTenant(TENANT_A).catch(() => {});
  expect(mockQueries).toEqual([
    { code: "MULTIAUTH", isActive: { $ne: false } },
    { code: TENANT_A.toUpperCase(), isActive: { $ne: false } },
  ]);
});

test.each([
  ["2 raw internal tenant _id (lower case)", TENANT_A, "UNKNOWN_TENANT"],
  ["2 raw internal tenant _id (upper case)", TENANT_A.toUpperCase(), "UNKNOWN_TENANT"],
  ["3 unknown code", "NOPE", "UNKNOWN_TENANT"],
  ["4 organisation without an Entra connection", "NOENTRA", "NO_ENTRA_CONNECTION"],
  ["4 organisation whose Entra connection is inactive", "INACTIVEENTRA", "NO_ENTRA_CONNECTION"],
  ["5 organisation with two active Entra connections", "TWOENTRA", "MULTIPLE_ENTRA_CONNECTIONS"],
  ["malformed selector", "{$ne:1}", "INVALID_TENANT"],
])("%s -> refused (%s)", async (_label, selector, expected) => {
  expect(await codeOf(resolveLoginTenant(selector))).toBe(expected);
});

test("11 no unauthenticated organisation / tenant listing route exists", () => {
  const dir = path.join(__dirname, "..", "routes");
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const re = /router\.(get|post|use)\(\s*["'`]([^"'`]+)["'`]([\s\S]*?)\);/g;
    let m;
    while ((m = re.exec(src))) {
      const [, method, routePath, rest] = m;
      if (!/tenant|organi[sz]ation/i.test(routePath)) continue;
      if (/(^|\/)(public|directory|discover|list)(\/|$)/i.test(routePath)) offenders.push(`${file} ${method} ${routePath} (public-looking path)`);
      const guarded = /requireTenant|authenticate|policy|middleware\(|requirePermission|ensureAuthenticated|verifyToken/.test(rest);
      if (method === "get" && !guarded) offenders.push(`${file} ${method} ${routePath} (no auth middleware)`);
    }
  }
  expect(offenders).toEqual([]);
});
