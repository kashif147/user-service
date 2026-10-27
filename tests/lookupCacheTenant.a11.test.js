/**
 * Phase A / A11 — tenant-keyed, versioned lookup caches (user-service).
 *
 * The lookup source is still global, so the SAME ObjectIds are returned to every tenant today;
 * these tests prove the CACHE NAMESPACE is tenant-separated anyway:
 *   lookuptype:v2:<tenant>:code:<CODE>, lookuptype-hierarchy:v2:<tenant>:type:<id>, lookup:v2:<tenant>:…
 * REAL lookup router/controllers/lookupCacheService over HTTP; PolicyCache is an in-memory fake with a
 * fake Redis (tests/helpers/a3Fixtures.js) that records every key read and written.
 */
jest.mock("../models/lookup.model", () => require("./helpers/a3Fixtures").Lookup);
jest.mock("../models/lookupType.model", () => require("./helpers/a3Fixtures").LookupType);
jest.mock("../models/productType.model", () => require("./helpers/a3Fixtures").ProductType);
jest.mock("../models/product.model", () => require("./helpers/a3Fixtures").Product);
jest.mock("../models/pricing.model", () => ({}));
jest.mock("../services/policyCache", () => require("./helpers/a3Fixtures").FakePolicyCache);
jest.mock("../controllers/me.controller", () => ({ invalidateMeCache: async () => {} }));
jest.mock("../rabbitMQ/publishers/product.publisher", () => ({
  publishProductCreated: async () => {},
  publishProductUpdated: async () => {},
  publishProductDeleted: async () => {},
}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: () => (req, res, next) => next() },
}));
jest.mock("../middlewares/auth", () => require("./helpers/a3Fixtures").authMock());
jest.mock("../config/bizLogger.js", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fx = require("./helpers/a3Fixtures");
const { A, B, D, TYPES, call, cacheStore, cacheOps } = fx;
const lookupCacheService = require("../services/lookupCacheService");

let server;
beforeAll(async () => {
  server = await fx.startApp();
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  fx.resetState();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const WL = TYPES.WORKLOC._id;
const byCode = (code) => `/api/lookup/by-type-code/${code}/hierarchy`;
const keysFor = (t) => [...cacheStore.keys()].filter((k) => k.includes(`:${t}:`)).sort();

test("same code by MULTIAUTH, DEVTENANTB and DEVDIRB -> three distinct tenant namespaces (same ids today)", async () => {
  const bodies = [];
  for (const t of [A, B, D]) bodies.push((await call(server, "GET", byCode("WORKLOC"), { tenant: t })).body);
  expect(bodies[1]).toEqual(bodies[0]); // global source: identical data/ids today
  expect(bodies[2]).toEqual(bodies[0]);
  for (const t of [A, B, D]) {
    expect(keysFor(t)).toEqual([
      `lookuptype-hierarchy:v2:${t}:type:${WL}`,
      `lookuptype:v2:${t}:code:WORKLOC`,
    ]);
  }
  expect(cacheStore.size).toBe(6);
});

test("cache hit stays inside the tenant: tenant A's cached payload is never served to B or DIRB", async () => {
  // Tenant A's entry holds a sentinel; B and DIRB must not see it (no fallback to A's value).
  cacheStore.set(`lookuptype:v2:${A}:code:WORKLOC`, WL);
  cacheStore.set(`lookuptype-hierarchy:v2:${A}:type:${WL}`, { lookuptype: { code: "WORKLOC" }, totalCount: 1, results: [{ lookup: { lookupname: "TENANT-A-ONLY" }, hierarchy: [] }] });
  const a = await call(server, "GET", byCode("WORKLOC"), { tenant: A });
  expect(a.body.results[0].lookup.lookupname).toBe("TENANT-A-ONLY"); // A: cache hit
  for (const t of [B, D]) {
    const r = await call(server, "GET", byCode("WORKLOC"), { tenant: t });
    expect(r.body.totalCount).toBe(2);
    expect(JSON.stringify(r.body)).not.toContain("TENANT-A-ONLY");
  }
  const reads = cacheOps.filter(([op]) => op === "get").map(([, k]) => k);
  expect(reads.filter((k) => k.includes(A))).toHaveLength(2); // only A's own request read A's keys
});

test("cache miss uses the trusted tenant: the forged tenant is never used for the key", async () => {
  await call(server, "GET", `${byCode("WORKLOC")}?tenantId=${A}`, { tenant: B, headers: { "x-tenant-id": A } });
  expect(keysFor(A)).toEqual([]);
  expect(keysFor(B)).toHaveLength(2);
});

test("stale pre-v2 global keys are ignored (never read) and purged from Redis", async () => {
  const legacy = {
    "lookuptype:all": [{ code: "STALE" }],
    [`lookuptype:id:${WL}`]: { code: "STALE" },
    "lookup:all": [{ lookupname: "STALE" }],
    [`lookup:id:${fx.id(22)}`]: { lookupname: "STALE" },
    [`hierarchy:hierarchy:${fx.id(22)}`]: { requestedLookup: { lookupname: "STALE" } },
    [`lookuptype-hierarchy:type:${WL}`]: { totalCount: 99, results: [{ lookup: { lookupname: "STALE" } }] },
  };
  for (const [k, v] of Object.entries(legacy)) cacheStore.set(k, v);
  const unrelated = ["policy:x", `role_hierarchy:${A}`, "country:all", "permissions_map", `me:user:${A}:u1`];
  for (const k of unrelated) cacheStore.set(k, "keep");

  for (const path of [byCode("WORKLOC"), `/api/lookup/by-type/${WL}/hierarchy`, "/api/lookup", `/api/lookup/${fx.id(22)}`, `/api/lookup/${fx.id(22)}/hierarchy`]) {
    const r = await call(server, "GET", path, { tenant: A });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("STALE");
  }
  const readKeys = cacheOps.map(([, k]) => k);
  for (const k of Object.keys(legacy)) expect(readKeys).not.toContain(k);
  expect(readKeys.every((k) => k.includes(`:v2:${A}:`))).toBe(true);

  const res = await lookupCacheService.purgeLegacyKeys();
  expect(res).toEqual({ redis: true, removed: Object.keys(legacy).length });
  for (const k of Object.keys(legacy)) expect(cacheStore.has(k)).toBe(false);
  for (const k of unrelated) expect(cacheStore.get(k)).toBe("keep"); // nothing unrelated flushed
  expect(keysFor(A).length).toBeGreaterThan(0); // v2 entries untouched by the purge
});

test("every lookup read path keys by the trusted tenant (all, by id, hierarchy, by-type, lookuptypes)", async () => {
  for (const path of ["/api/lookup", `/api/lookup/${fx.id(22)}`, `/api/lookup/${fx.id(22)}/hierarchy`, `/api/lookup/by-type/${WL}/hierarchy`]) {
    await call(server, "GET", path, { tenant: D });
  }
  expect(keysFor(D)).toEqual([
    `hierarchy:v2:${D}:${fx.id(22)}`,
    `lookup:v2:${D}:all`,
    `lookup:v2:${D}:id:${fx.id(22)}`,
    `lookuptype-hierarchy:v2:${D}:type:${WL}`,
  ]);
  // lookuptype controller paths
  await lookupCacheService.getAllLookupTypes(D, async () => [TYPES.WORKLOC]);
  await lookupCacheService.getLookupTypeById(D, WL, async () => TYPES.WORKLOC);
  expect(keysFor(D)).toEqual(expect.arrayContaining([`lookuptype:v2:${D}:all`, `lookuptype:v2:${D}:id:${WL}`]));
});

test("no trusted tenant (missing / placeholder / malformed) -> TENANT_REQUIRED; no cache key, DB not queried", async () => {
  for (const t of [undefined, null, "", "  ", "default", "unknown", "system", "a:b", "x*"]) {
    let dbCalls = 0;
    await expect(
      lookupCacheService.getLookupsByTypeWithHierarchy(t, WL, async () => {
        dbCalls++;
        return { ok: true };
      })
    ).rejects.toMatchObject({ name: "AppError", status: 400, code: "TENANT_REQUIRED" });
    expect(dbCalls).toBe(0);
  }
  expect(cacheOps).toEqual([]);
  expect(cacheStore.size).toBe(0);
  expect(lookupCacheService.keyFor("", "all")).toBeNull();
  expect(lookupCacheService.keyFor(A, "all")).toBe(`${A}:all`);
});

test("unknown codes are not cached (a later-created type is found immediately)", async () => {
  await call(server, "GET", byCode("NOPE"), { tenant: A });
  expect(keysFor(A)).toEqual([]);
});

test("writes invalidate every tenant's entries (lookups are shared until Phase D)", async () => {
  for (const t of [A, B, D]) await call(server, "GET", byCode("WORKLOC"), { tenant: t });
  cacheStore.set("policy:x", "keep");
  await lookupCacheService.invalidateHierarchyCache(null, WL);
  await lookupCacheService.invalidateLookupTypeCache(WL);
  expect([...cacheStore.keys()]).toEqual(["policy:x"]);
});

test("B-12: bulk officer update clears the by-type hierarchy cache for every tenant", async () => {
  for (const t of [A, B]) await call(server, "GET", byCode("WORKLOC"), { tenant: t });
  await call(server, "GET", `/api/lookup/${fx.id(22)}`, { tenant: A });
  expect(keysFor(A)).toContain(`lookuptype-hierarchy:v2:${A}:type:${WL}`);
  const r = await call(server, "PATCH", "/api/lookups/officer", { tenant: A, body: { ids: [fx.id(22)], officer: null } });
  expect(r.status).toBe(200);
  const left = [...cacheStore.keys()];
  expect(left.filter((k) => k.startsWith("lookuptype-hierarchy:") || k.startsWith("hierarchy:") || k.startsWith("lookup:"))).toEqual([]);
});

test("key format is versioned and tenant-dimensioned", () => {
  expect(lookupCacheService.lookupCache.prefix).toBe("lookup:v2:");
  expect(lookupCacheService.lookupTypeCache.prefix).toBe("lookuptype:v2:");
  expect(lookupCacheService.hierarchyCache.prefix).toBe("hierarchy:v2:");
  expect(lookupCacheService.lookupTypeHierarchyCache.prefix).toBe("lookuptype-hierarchy:v2:");
  expect(lookupCacheService.countryCache.prefix).toBe("country:"); // unchanged in A-3; tenant-keyed with the Phase E country clone
  const { LEGACY_KEY_PATTERNS } = require("../services/lookupCacheService");
  const re = (p) => new RegExp(`^${p.replace(/\*/g, ".*")}$`);
  for (const t of [A, B, D]) {
    for (const k of [`lookup:v2:${t}:all`, `lookuptype:v2:${t}:code:WORKLOC`, `hierarchy:v2:${t}:${fx.id(22)}`, `lookuptype-hierarchy:v2:${t}:type:${WL}`]) {
      expect(LEGACY_KEY_PATTERNS.some((p) => re(p).test(k))).toBe(false); // the purge can never hit a v2 key
    }
  }
});
