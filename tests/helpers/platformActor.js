/**
 * Phase B / Z5 test helpers: real HS256 ProjectShell bearer tokens (legacy SU "*", ASU, ordinary users, platform
 * principals) and one in-memory PlatformPrincipal + its bound CRM user for the REAL platform evaluator
 * (services/platformAuthorizationService.js). Call useTestSecret() before requests; installPrincipal() inside a
 * test (jest.restoreAllMocks() / restoreMocks undoes it).
 */
const jwt = require("jsonwebtoken");

const SECRET = "unit-test-only-secret-z5-platform";
const PID = "6a0000000000000000000a05";
const ISSUER = "https://login.microsoftonline.com/39866a06-30bc-4a89-80c6-9dd9357dd453/v2.0";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd5555";

function useTestSecret() {
  process.env.JWT_SECRET = SECRET;
}

/** A tenant-scoped bearer token; `plat` makes it a platform actor's token. */
function bearer({ userId, tenantId, roles = [], permissions = ["*"], plat, expiresIn = "5m" }) {
  const payload = {
    id: userId,
    sub: userId,
    tenantId,
    userType: "CRM",
    roles: roles.map((r) => (typeof r === "string" ? { code: r } : r)),
    permissions,
    ...(plat ? { plat } : {}),
  };
  return `Bearer ${jwt.sign(payload, SECRET, { algorithm: "HS256", expiresIn })}`;
}

const platClaim = (rev = 1) => ({ v: 1, pid: PID, rev });

/** The live principal the evaluator reads, bound to (userId, tenantId). */
function installPrincipal({ permissions, status = "active", revision = 1, userId, tenantId }) {
  const PlatformPrincipal = require("../../models/platformPrincipal.model");
  const User = require("../../models/user.model");
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === PID ? { _id: PID, issuer: ISSUER, oid: OID, status, revision, permissions } : null) }),
  }));
  jest.spyOn(User, "findOne").mockImplementation((q) => ({
    select: () => ({
      lean: async () => (q && String(q._id) === String(userId) && String(q.tenantId) === String(tenantId)
        ? { _id: userId, tenantId, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true }
        : null),
    }),
  }));
}

module.exports = { SECRET, PID, ISSUER, OID, useTestSecret, bearer, platClaim, installPrincipal };
