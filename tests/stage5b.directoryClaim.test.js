/**
 * Stage 5b: verified directory claims.
 *
 *  - models/directoryClaim.model.js: one claim per connection and per (organisation, directory);
 *    one VERIFIED directory -> one organisation (partial unique index); immutable ownership; no
 *    secrets / client ids / appRef; DEV shared-directory exception only under all DEV conditions.
 *  - helpers/directoryClaimPolicy.js: switches, DEV exception, startup guard.
 *  - helpers/directoryClaimGate.js: in multi-directory mode a connection is usable only with a
 *    verified claim matching directory + organisation + connection (login start, callback,
 *    activation); with the switch off nothing changes and no claim is read.
 *
 * Database-level uniqueness under concurrency: tests/stage5b.directoryClaim.mongo.test.js.
 * New modules are required inside the tests so each test fails on its own against older code.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js
const OTHER_DIR = "11111111-2222-3333-4444-555555555555";
const CONSUMER_DIR = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const SWITCH = "ENTRA_CRM_MULTI_DIRECTORY";
const DEV_VARS = ["DEPLOYMENT_ENV", "ENTRA_ALLOW_SHARED_DIRECTORY", "ENTRA_SHARED_DIRECTORY_ALLOWLIST"];

const mockTenants = [];
const mockRows = (q) =>
  mockTenants.filter((t) => {
    if (t.isActive === false) return false;
    if (q.$or) return q.$or.some((c) => (c.code && c.code === t.code) || (c._id && String(c._id) === t._id));
    return String(q._id) === t._id;
  });
const mockQuery = (value) => ({
  lean: async () => JSON.parse(JSON.stringify(value)),
  then: (ok, ko) => Promise.resolve(value).then(ok, ko),
});
jest.mock("../models/tenant.model", () => ({
  find: (q) => ({ select: () => mockQuery(mockRows(q)) }),
  findOne: (q) => ({ select: () => mockQuery(mockRows(q)[0] || null) }),
}));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));

const fs = require("fs");
const path = require("path");
const AzureADHandler = require("../handlers/azure.ad.handler");

const load = {
  model: () => require("../models/directoryClaim.model"),
  policy: () => require("../helpers/directoryClaimPolicy"),
  gate: () => require("../helpers/directoryClaimGate"),
};
const entraConn = (id, extra = {}) => ({ _id: id, connectionType: ENTRA, directoryId: HOME_DIR, isActive: true, ...extra });

// In-memory claim store behind DirectoryClaim.findOne (exact field match, like the gate's query).
const claims = [];
const verified = (extra = {}) => ({
  _id: `claim${claims.length + 1}`,
  connectionType: ENTRA,
  directoryId: OTHER_DIR,
  tenantId: TENANT_B,
  connectionId: "connB",
  status: "verified",
  method: "entra-admin-sign-in",
  sharedDirectoryException: false,
  claimedAt: new Date(),
  claimedBy: "platform-test",
  verifiedAt: new Date(),
  verifiedBy: "admin-oid-test",
  ...extra,
});
function stubClaimStore() {
  return jest.spyOn(load.model(), "findOne").mockImplementation((q) => ({
    lean: async () => {
      const hit = claims.find((c) => Object.entries(q).every(([k, v]) => String(c[k]) === String(v)));
      return hit ? JSON.parse(JSON.stringify(hit)) : null;
    },
  }));
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const on = (fn) => withEnv({ [SWITCH]: "true" }, fn);
const devOk = (fn, extra = {}) =>
  withEnv({ DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: HOME_DIR, ...extra }, fn);
const res = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
async function startLogin(query) {
  const { generatePKCE } = require("../controllers/pkce.controller");
  const r = res();
  const next = jest.fn();
  await generatePKCE({ query }, r, next);
  if (next.mock.calls.length) return { error: next.mock.calls[0][0], r };
  const url = new URL(r.json.mock.calls[0][0].authorizationUrls.azureAD);
  return { url, state: url.searchParams.get("state") };
}
function spyFlow() {
  const exchange = jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockResolvedValue({ id_token: "i", access_token: "a" });
  jest.spyOn(AzureADHandler, "decodeIdToken").mockResolvedValue({ userEmail: "e" });
  jest.spyOn(AzureADHandler, "getUserInfoFromGraph").mockResolvedValue({});
  const find = jest.spyOn(AzureADHandler, "findOrCreateUser").mockResolvedValue({ _id: "u", tenantId: TENANT_B });
  return { exchange, find };
}
const thrownAsync = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[SWITCH];
  for (const v of DEV_VARS) delete process.env[v];
  claims.length = 0;
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", isActive: true, authenticationConnections: [entraConn("connA")] },
    { _id: TENANT_B, code: "FOREIGNORG", isActive: true, authenticationConnections: [entraConn("connB", { directoryId: OTHER_DIR })] }
  );
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env[SWITCH];
  for (const v of DEV_VARS) delete process.env[v];
  jest.restoreAllMocks();
});

describe("A: DirectoryClaim model", () => {
  const base = (extra = {}) => ({
    connectionType: ENTRA,
    directoryId: OTHER_DIR,
    tenantId: TENANT_B,
    connectionId: "connB",
    method: "entra-admin-sign-in",
    claimedBy: "platform-test",
    ...extra,
  });

  test("A1 directoryId is normalised to lower case; defaults pending; sharedDirectoryException derived", async () => {
    const DirectoryClaim = load.model();
    const doc = new DirectoryClaim(base({ directoryId: `  ${OTHER_DIR.toUpperCase()}  `, sharedDirectoryException: true }));
    await doc.validate();
    expect(doc.directoryId).toBe(OTHER_DIR);
    expect(doc.status).toBe("pending");
    expect(doc.sharedDirectoryException).toBe(false);
  });

  test("A2 statuses and methods are closed sets", () => {
    const DirectoryClaim = load.model();
    // Stage 5c-3 adds the terminal "revoked" status (Disconnect).
    expect(DirectoryClaim.CLAIM_STATUSES).toEqual(["pending", "verified", "revoked"]);
    expect(DirectoryClaim.CLAIM_METHODS).toEqual(["entra-admin-sign-in", "platform", "dev-exception"]);
  });

  test.each([
    ["unknown status", { status: "approved" }, "status"],
    ["unknown method", { method: "typed-by-admin" }, "method"],
    ["B2C provider", { connectionType: B2C }, "connectionType"],
    ["non-GUID directory", { directoryId: "common" }, "directoryId"],
    ["consumer directory", { directoryId: CONSUMER_DIR }, "directoryId"],
    ["no tenant", { tenantId: undefined }, "tenantId"],
    ["no connection", { connectionId: undefined }, "connectionId"],
    ["verified without verifiedAt/verifiedBy", { status: "verified" }, "verifiedAt"],
    ["pending with verification details", { verifiedAt: new Date(), verifiedBy: "x" }, "status"],
  ])("A3 invalid: %s", async (_d, extra, field) => {
    const DirectoryClaim = load.model();
    const err = await thrownAsync(new DirectoryClaim(base(extra)).validate());
    expect(err).toBeTruthy();
    expect(Object.keys(err.errors)).toContain(field);
  });

  test("A4 only safe fields: client id, scopes, secrets, tokens, codes and appRef are rejected", () => {
    const DirectoryClaim = load.model();
    for (const f of ["clientId", "scopes", "clientSecret", "accessToken", "idToken", "authCode", "appRef", "redirectUris"]) {
      expect(() => new DirectoryClaim(base({ [f]: "x" }))).toThrow();
    }
    expect(Object.keys(DirectoryClaim.schema.paths).sort()).toEqual(
      [
        "_id",
        "__v",
        "claimedAt",
        "claimedBy",
        "connectionId",
        "connectionType",
        "createdAt",
        "directoryId",
        "method",
        "revokedAt", // Stage 5c-3: Disconnect audit (server time)
        "revokedBy", // Stage 5c-3: Disconnect audit ("user:<id>")
        "sharedDirectoryException",
        "status",
        "tenantId",
        "updatedAt",
        "verifiedAt",
        "verifiedBy",
        "verificationEvidence", // Stage 5c-1: audit evidence {directoryUserId, roleTemplateId}
      ].sort()
    );
  });

  test("A5 ownership fields are immutable (no re-assigning a claim to another organisation/connection/directory)", () => {
    const DirectoryClaim = load.model();
    for (const f of ["connectionType", "directoryId", "tenantId", "connectionId", "method"]) {
      expect(DirectoryClaim.schema.path(f).options.immutable).toBe(true);
    }
    const doc = DirectoryClaim.hydrate({ _id: "507f1f77bcf86cd799439011", ...base(), status: "verified" });
    doc.tenantId = TENANT_A;
    doc.directoryId = HOME_DIR;
    doc.connectionId = "connA";
    expect(doc.tenantId).toBe(TENANT_B);
    expect(doc.directoryId).toBe(OTHER_DIR);
    expect(doc.connectionId).toBe("connB");
  });
});

describe("B: uniqueness (index design; behaviour under concurrency in the mongo suite)", () => {
  test("B1 one VERIFIED normal directory -> one organisation: partial unique index", () => {
    const idx = load.model().schema.indexes();
    const byName = Object.fromEntries(idx.map(([fields, opts]) => [opts.name, { fields, opts }]));
    expect(byName.uniq_verified_directory).toEqual({
      fields: { connectionType: 1, directoryId: 1 },
      opts: expect.objectContaining({
        unique: true,
        partialFilterExpression: { status: "verified", sharedDirectoryException: false },
      }),
    });
    // Stage 5c-3: one ACTIVE (pending/verified) claim per connection and per tenant+directory; the
    // always-on uniq_claim_per_connection / uniq_claim_per_tenant_directory are replaced.
    const active = { status: { $in: ["pending", "verified"] } };
    expect(byName.uniq_active_claim_per_connection.opts).toEqual(expect.objectContaining({ unique: true, partialFilterExpression: active }));
    expect(byName.uniq_active_claim_per_connection.fields).toEqual({ connectionType: 1, connectionId: 1 });
    expect(byName.uniq_active_claim_per_tenant_directory.opts).toEqual(expect.objectContaining({ unique: true, partialFilterExpression: active }));
    expect(byName.uniq_active_claim_per_tenant_directory.fields).toEqual({ connectionType: 1, directoryId: 1, tenantId: 1 });
    expect(byName.uniq_claim_per_connection).toBeUndefined();
    expect(byName.uniq_claim_per_tenant_directory).toBeUndefined();
  });
});

describe("C-H, L: the claim gate in multi-directory mode", () => {
  const gate = (args) => load.gate().assertConnectionDirectoryClaim(args);
  const conn = entraConn("connB", { directoryId: OTHER_DIR });

  test("C pending claim does not satisfy the gate", async () => {
    stubClaimStore();
    claims.push(verified({ status: "pending", verifiedAt: null, verifiedBy: null }));
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
    });
  });

  test("D verified matching claim satisfies the gate (directory compared case-insensitively)", async () => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).resolves.toMatchObject({ required: true });
      await expect(
        gate({ tenantId: TENANT_B, connection: { ...conn, directoryId: OTHER_DIR.toUpperCase() } })
      ).resolves.toMatchObject({ required: true });
    });
  });

  test("E claim for the directory but another organisation is refused", async () => {
    stubClaimStore();
    claims.push(verified({ tenantId: TENANT_A }));
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
    });
  });

  test("F claim for the same directory and organisation but another connection is refused", async () => {
    stubClaimStore();
    claims.push(verified({ connectionId: "connOld" }));
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
    });
  });

  test("F2 claim for another directory is refused; missing ids fail closed", async () => {
    stubClaimStore();
    claims.push(verified({ directoryId: "22222222-3333-4444-5555-666666666666" }));
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
      await expect(gate({ tenantId: null, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
      await expect(gate({ tenantId: TENANT_B, connection: { ...conn, _id: undefined } })).rejects.toMatchObject({
        code: "DIRECTORY_NOT_CLAIMED",
      });
    });
  });

  test("F3 a claim that does not match its method rules is not trusted", async () => {
    stubClaimStore();
    claims.push(verified({ sharedDirectoryException: true }));
    await on(async () => {
      await expect(gate({ tenantId: TENANT_B, connection: conn })).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" });
    });
  });

  test("L1 login start: an active foreign-directory connection without a verified claim -> generic 400, no authorize URL", async () => {
    stubClaimStore();
    await on(async () => {
      const out = await startLogin({ tenant: "FOREIGNORG" });
      expect(out.error).toMatchObject({ status: 400, message: "Microsoft sign-in is not available for this organisation" });
      expect(out.r.json).not.toHaveBeenCalled();
    });
  });

  test("L2 login start: a verified claim lets the login proceed to the normal Stage 5a flow", async () => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      const s = await startLogin({ tenant: "FOREIGNORG" });
      expect(s.url.pathname).toBe(`/${OTHER_DIR}/oauth2/v2.0/authorize`);
      expect(require("../helpers/pkceStateStore").takeLoginTransaction(s.state).loginContext).toEqual({
        tenantId: TENANT_B,
        connectionId: "connB",
      });
    });
  });

  test("L3 the home directory also needs a verified claim in multi-directory mode", async () => {
    stubClaimStore();
    await on(async () => {
      const out = await startLogin({ tenant: "MULTIAUTH" });
      expect(out.error).toMatchObject({ status: 400 });
    });
  });

  test("L4 the no-code CRM path is unaffected (home directory, existing users only, no claim)", async () => {
    const find = stubClaimStore();
    await on(async () => {
      const s = await startLogin({});
      expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
      expect(find).not.toHaveBeenCalled();
    });
  });

  test("G claim removed after the login started -> callback refused before any token request", async () => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      const s = await startLogin({ tenant: "FOREIGNORG" });
      expect(s.url).toBeTruthy();
      claims.length = 0;
      const { exchange, find } = spyFlow();
      await expect(
        AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", { tenantId: TENANT_B, connectionId: "connB" })
      ).rejects.toMatchObject({ status: 403, message: "CRM sign-in is not available for this account" });
      expect(exchange).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
    });
  });

  test.each([
    ["downgraded to pending", { status: "pending", verifiedAt: null, verifiedBy: null }],
    ["re-pointed at another organisation", { tenantId: TENANT_A }],
    ["re-pointed at another connection", { connectionId: "connX" }],
  ])("H claim %s after the login started -> callback refused", async (_d, change) => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      Object.assign(claims[0], change);
      const { exchange } = spyFlow();
      await expect(
        AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", { tenantId: TENANT_B, connectionId: "connB" })
      ).rejects.toMatchObject({ status: 403 });
      expect(exchange).not.toHaveBeenCalled();
    });
  });

  test("H2 connection directory changed after the claim (stale state) -> callback refused", async () => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      mockTenants[1].authenticationConnections = [entraConn("connB", { directoryId: "22222222-3333-4444-5555-666666666666" })];
      const { exchange } = spyFlow();
      await expect(
        AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", { tenantId: TENANT_B, connectionId: "connB" })
      ).rejects.toMatchObject({ status: 403 });
      expect(exchange).not.toHaveBeenCalled();
    });
  });

  test("H3 a verified claim lets the callback proceed; tenant comes from the state, not the claim or tid", async () => {
    stubClaimStore();
    claims.push(verified());
    await on(async () => {
      const { exchange, find } = spyFlow();
      const ctx = { tenantId: TENANT_B, connectionId: "connB" };
      await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", ctx);
      expect(exchange.mock.calls[0][2]).toMatchObject({ directoryId: OTHER_DIR, connectionId: "connB" });
      expect(find.mock.calls[0][2]).toEqual(ctx);
    });
  });
});

describe("I/J: DEV shared-directory exception and production safety", () => {
  const policy = () => load.policy();

  test("I1 allowed only when DEPLOYMENT_ENV=dev, the flag is exactly true and the directory is allow-listed", async () => {
    await devOk(async () => {
      expect(policy().devExceptionAllowed(HOME_DIR)).toBe(true);
      expect(policy().devExceptionAllowed(HOME_DIR.toUpperCase())).toBe(true);
    });
  });

  test.each([
    ["DEPLOYMENT_ENV unset", { DEPLOYMENT_ENV: undefined }],
    ["DEPLOYMENT_ENV=uat", { DEPLOYMENT_ENV: "uat" }],
    ["DEPLOYMENT_ENV=prod", { DEPLOYMENT_ENV: "prod" }],
    ["DEPLOYMENT_ENV=DEV (case)", { DEPLOYMENT_ENV: "DEV" }],
    ["flag missing", { ENTRA_ALLOW_SHARED_DIRECTORY: undefined }],
    ["flag not exactly true", { ENTRA_ALLOW_SHARED_DIRECTORY: "TRUE" }],
    ["directory not allow-listed", { ENTRA_SHARED_DIRECTORY_ALLOWLIST: OTHER_DIR }],
    ["allow-list missing", { ENTRA_SHARED_DIRECTORY_ALLOWLIST: undefined }],
  ])("I2 refused: %s", async (_d, extra) => {
    await devOk(async () => expect(policy().devExceptionAllowed(HOME_DIR)).toBe(false), extra);
  });

  test("I3 NODE_ENV never stands in for DEPLOYMENT_ENV", async () => {
    await devOk(async () => expect(policy().devExceptionAllowed(HOME_DIR)).toBe(false), {
      DEPLOYMENT_ENV: undefined,
      NODE_ENV: "development",
    });
  });

  test("I4 a dev-exception claim validates only under the DEV conditions; other methods never become exceptions", async () => {
    const DirectoryClaim = load.model();
    const claim = (extra) =>
      new DirectoryClaim({
        connectionType: ENTRA,
        directoryId: HOME_DIR,
        tenantId: TENANT_A,
        connectionId: "connA",
        method: "dev-exception",
        claimedBy: "platform-test",
        ...extra,
      });
    await devOk(async () => {
      const ok = claim();
      await ok.validate();
      expect(ok.sharedDirectoryException).toBe(true);
      const normal = claim({ method: "platform" });
      await normal.validate();
      expect(normal.sharedDirectoryException).toBe(false);
    });
    for (const extra of [{ DEPLOYMENT_ENV: "uat" }, { ENTRA_ALLOW_SHARED_DIRECTORY: undefined }, { ENTRA_SHARED_DIRECTORY_ALLOWLIST: OTHER_DIR }]) {
      await devOk(async () => {
        const err = await thrownAsync(claim().validate());
        expect(Object.keys(err.errors)).toContain("method");
      }, extra);
    }
  });

  test("I5 a verified dev-exception claim satisfies the gate only while the DEV conditions hold", async () => {
    stubClaimStore();
    claims.push(verified({ directoryId: HOME_DIR, tenantId: TENANT_A, connectionId: "connA", method: "dev-exception", sharedDirectoryException: true }));
    const gate = () => load.gate().assertConnectionDirectoryClaim({ tenantId: TENANT_A, connection: entraConn("connA") });
    await on(() => devOk(async () => expect(gate()).resolves.toMatchObject({ required: true })));
    await on(() => devOk(async () => expect(gate()).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" }), { DEPLOYMENT_ENV: "prod" }));
    await on(() =>
      devOk(async () => expect(gate()).rejects.toMatchObject({ code: "DIRECTORY_NOT_CLAIMED" }), { ENTRA_ALLOW_SHARED_DIRECTORY: undefined })
    );
  });

  test.each([
    ["flag outside dev", { ENTRA_ALLOW_SHARED_DIRECTORY: "true" }],
    ["allow-list outside dev", { ENTRA_SHARED_DIRECTORY_ALLOWLIST: HOME_DIR }],
    ["flag in prod", { DEPLOYMENT_ENV: "prod", ENTRA_ALLOW_SHARED_DIRECTORY: "true" }],
    ["flag=false still counts as configured outside dev", { DEPLOYMENT_ENV: "uat", ENTRA_ALLOW_SHARED_DIRECTORY: "false" }],
  ])("J1 startup refuses: %s", async (_d, vars) => {
    await withEnv(vars, async () => {
      expect(() => policy().assertDirectoryClaimConfig()).toThrow(/refusing to start/);
    });
  });

  test("J2 startup refuses a malformed allow-list in dev, accepts a valid one, and is silent when nothing is configured", async () => {
    await devOk(async () => expect(() => policy().assertDirectoryClaimConfig()).toThrow(/invalid directory id/), {
      ENTRA_SHARED_DIRECTORY_ALLOWLIST: `${HOME_DIR},common`,
    });
    await devOk(async () => expect(() => policy().assertDirectoryClaimConfig()).toThrow(/invalid directory id/), {
      ENTRA_SHARED_DIRECTORY_ALLOWLIST: CONSUMER_DIR,
    });
    await devOk(async () => expect(() => policy().assertDirectoryClaimConfig()).not.toThrow());
    expect(() => policy().assertDirectoryClaimConfig()).not.toThrow();
  });

  test("J3 the startup check is wired before the service starts", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
    expect(src).toMatch(/require\("\.\/helpers\/directoryClaimPolicy"\)\.assertDirectoryClaimConfig\(\)/);
  });
});

describe("K: switch off - Stage 5a behaviour, claims never required or read", () => {
  test.each([["absent", undefined], ["false", "false"], ["TRUE", "TRUE"]])(
    "K1 %s: gate is a no-op without any claim read; logins and callbacks unchanged",
    async (_d, value) => {
      const find = stubClaimStore();
      await withEnv({ [SWITCH]: value }, async () => {
        await expect(
          load.gate().assertConnectionDirectoryClaim({ tenantId: TENANT_A, connection: entraConn("connA") })
        ).resolves.toEqual({ required: false });
        const s = await startLogin({ tenant: "MULTIAUTH" });
        expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
        const foreign = await startLogin({ tenant: "FOREIGNORG" });
        expect(foreign.error).toMatchObject({ status: 400 }); // DIRECTORY_NOT_ENABLED, as in Stage 5a
        mockTenants[1].authenticationConnections = [entraConn("connB")];
        const { exchange } = spyFlow();
        await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", { tenantId: TENANT_B, connectionId: "connB" });
        expect(exchange).toHaveBeenCalled();
        expect(find).not.toHaveBeenCalled();
      });
    }
  );

  test("K2 switch off: activating an Entra connection needs no claim", async () => {
    const find = stubClaimStore();
    const { assertConnectionWritable } = require("../helpers/connectionDefaultRole");
    await expect(assertConnectionWritable(TENANT_A, entraConn("connA"), { connectionId: "connA" })).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("Connection writes in multi-directory mode (organisation-admin protection)", () => {
  const writable = (...args) => require("../helpers/connectionDefaultRole").assertConnectionWritable(...args);
  const ConnectionValidationError = () => require("../helpers/connectionDefaultRole").ConnectionValidationError;

  test("W1 a new ACTIVE Entra connection is refused (no claim can exist for it yet); inactive is allowed", async () => {
    stubClaimStore();
    await on(async () => {
      const { _id, ...fresh } = entraConn("x", { directoryId: OTHER_DIR });
      const err = await thrownAsync(writable(TENANT_B, fresh));
      expect(err).toBeInstanceOf(ConnectionValidationError());
      expect(err.message).toMatch(/not verified for this organisation/);
      await expect(writable(TENANT_B, { ...fresh, isActive: false })).resolves.toBeUndefined();
    });
  });

  test("W2 activating / changing an existing connection needs a verified claim for that connection", async () => {
    stubClaimStore();
    await on(async () => {
      const c = { connectionType: ENTRA, directoryId: OTHER_DIR, isActive: true };
      await expect(writable(TENANT_B, c, { connectionId: "connB" })).rejects.toBeInstanceOf(ConnectionValidationError());
      claims.push(verified());
      await expect(writable(TENANT_B, c, { connectionId: "connB" })).resolves.toBeUndefined();
      // Typing another organisation's verified directory does not claim it.
      await expect(writable(TENANT_A, c, { connectionId: "connA" })).rejects.toBeInstanceOf(ConnectionValidationError());
    });
  });

  test("W3 full-array writes pass the stored connection id; new items get none", async () => {
    stubClaimStore();
    claims.push(verified());
    const { prepareConnectionsForWrite } = require("../helpers/connectionDefaultRole");
    const stored = [{ _id: "connB", connectionType: ENTRA, directoryId: OTHER_DIR, isActive: false }];
    await on(async () => {
      const out = await prepareConnectionsForWrite(TENANT_B, [{ _id: "connB", connectionType: ENTRA, directoryId: OTHER_DIR, isActive: true }], stored);
      expect(out[0]).toMatchObject({ _id: "connB", isActive: true });
      await expect(
        prepareConnectionsForWrite(TENANT_B, [{ connectionType: ENTRA, directoryId: OTHER_DIR, isActive: true }], [])
      ).rejects.toBeInstanceOf(ConnectionValidationError());
    });
  });

  test("W4 the per-connection update path passes the stored connection id", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "handlers", "tenant.handler.js"), "utf8");
    // Stage 5c-3: the stored connection is passed too (reactivation guard for disconnected connections).
    expect(src).toMatch(/assertConnectionWritable\(String\(tenant\._id\), merged, \{ connectionId: stored\._id, stored \}\)/);
  });

  test("W5 claim fields are not connection fields and there is no claim API", () => {
    const { pickConnectionFields } = require("../helpers/connectionDefaultRole");
    const picked = pickConnectionFields({ directoryId: OTHER_DIR, directoryClaim: { status: "verified" }, claimStatus: "verified", verified: true, directoryOwnership: "x" });
    expect(Object.keys(picked)).toEqual(["directoryId"]);
    const routes = fs.readdirSync(path.join(__dirname, "..", "routes"));
    for (const f of routes) {
      expect(fs.readFileSync(path.join(__dirname, "..", "routes", f), "utf8")).not.toMatch(/directoryClaim|DirectoryClaim/);
    }
    for (const f of ["helpers/connectionAuthConfig.js", "helpers/directoryClaimGate.js", "handlers/azure.ad.handler.js"]) {
      expect(fs.readFileSync(path.join(__dirname, "..", f), "utf8")).not.toMatch(/\.directoryOwnership|\.appRef/);
    }
  });

  test("W6 B2C connections are never gated by directory claims", async () => {
    const find = stubClaimStore();
    await on(async () => {
      await expect(
        load.gate().assertConnectionDirectoryClaim({ tenantId: TENANT_A, connection: { _id: "b", connectionType: B2C, directoryId: "x", isActive: true } })
      ).resolves.toEqual({ required: false });
      expect(find).not.toHaveBeenCalled();
    });
  });
});
