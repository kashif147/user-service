/**
 * Phase A / A10-A11 test fixtures: in-memory Lookup / LookupType / ProductType / Product model fakes,
 * an in-memory PolicyCache (records every key read/written, with a fake Redis for the legacy purge)
 * and an HTTP harness over the REAL lookup + product routers and controllers.
 *
 * Lookups are global (no tenantId), as in DEV/UAT today. Product types are tenant-owned:
 * MEM exists in tenant A (4080 Retired Associate, 4090 Undergraduate Student) and, with different
 * products, in tenant B; tenant D has none - so a by-code request can only ever see its own tenant.
 */
const http = require("http");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const D = "6ad4e0c941376f7df605fd57"; // DEVDIRB

const id = (n) => `65a0000000000000000000${String(n).padStart(2, "0")}`;

// ---- lookup data (global) ----
const TYPES = {
  REGION: { _id: id(1), code: "REGION", lookuptype: "Region", displayname: "Region", ParentlookuptypeId: null, isdeleted: false },
  BRANCH: { _id: id(2), code: "BRANCH", lookuptype: "Branch", displayname: "Branch", ParentlookuptypeId: null, isdeleted: false },
  WORKLOC: { _id: id(3), code: "WORKLOC", lookuptype: "workLocation", displayname: "Work Location", ParentlookuptypeId: null, isdeleted: false },
  "001": { _id: id(4), code: "001", lookuptype: "Title", displayname: "Title", ParentlookuptypeId: null, isdeleted: false },
  MCAT: { _id: id(5), code: "MCAT", lookuptype: "membershipCategory", displayname: "Membership Category", ParentlookuptypeId: null, isdeleted: false },
  OLDTYPE: { _id: id(6), code: "OLDTYPE", lookuptype: "Old", displayname: "Old", ParentlookuptypeId: null, isdeleted: true },
};
const typeById = (tid) => Object.values(TYPES).find((t) => String(t._id) === String(tid)) || null;

const lk = (n, type, name, parent = null, extra = {}) => ({
  _id: id(n),
  code: `${type}-${n}`,
  lookupname: name,
  DisplayName: name,
  lookuptypeId: TYPES[type],
  Parentlookupid: parent,
  isactive: true,
  isdeleted: false,
  ...extra,
});
const LOOKUPS = [
  lk(20, "REGION", "North East"),
  lk(21, "BRANCH", "Dublin North", id(20)),
  lk(22, "WORKLOC", "Beaumont Hospital", id(21), { processSalaryDeduction: true }),
  lk(23, "WORKLOC", "Mater Hospital", id(21)),
  lk(24, "001", "Mr"),
  lk(25, "001", "Ms"),
  lk(26, "MCAT", "General"),
  lk(27, "MCAT", "Honorary Member"),
];

// Chainable query result: .select/.populate/.lean/.sort all return the same thenable.
const q = (value) => {
  const p = Promise.resolve(value);
  for (const m of ["select", "populate", "lean", "sort"]) p[m] = () => p;
  return p;
};

const calls = { lookupTypeFindOne: [], productTypeFindOne: [], productFind: [] };

const LookupType = {
  findById: (tid) => q(typeById(tid)),
  findOne: (filter) => {
    calls.lookupTypeFindOne.push(filter);
    const t = Object.values(TYPES).find((x) => x.code === filter.code) || null;
    if (t && filter.isdeleted && filter.isdeleted.$ne === true && t.isdeleted) return q(null);
    return q(t);
  },
};

const Lookup = {
  find: (filter) => {
    if (filter._id && filter._id.$in) {
      const ids = filter._id.$in.map(String);
      return q(LOOKUPS.filter((l) => ids.includes(String(l._id))));
    }
    if (filter.lookuptypeId) {
      return q(LOOKUPS.filter((l) => String(l.lookuptypeId._id) === String(filter.lookuptypeId) && l.isactive && !l.isdeleted));
    }
    return q(LOOKUPS.slice());
  },
  findOne: (filter) => q(LOOKUPS.find((l) => String(l._id) === String(filter._id)) || null),
  findById: (lid) => q(LOOKUPS.find((l) => String(l._id) === String(lid)) || null),
  distinct: async () => [],
  updateMany: async (filter) => ({ matchedCount: filter._id.$in.length, modifiedCount: filter._id.$in.length }),
};

// ---- product data (tenant-owned) ----
const PRODUCT_TYPES = [
  { _id: id(40), code: "MEM", name: "Membership", description: "Membership categories", tenantId: A, isDeleted: false },
  { _id: id(41), code: "MEM", name: "Membership B", description: "Tenant B categories", tenantId: B, isDeleted: false },
  { _id: id(42), code: "CODE 005", name: "Spaced", description: "Code with a space", tenantId: A, isDeleted: false },
];
const pr = (n, type, code, name, tenantId) => ({
  _id: id(n), code, name, description: name, productTypeId: type._id, tenantId, isDeleted: false,
  status: "ACTIVE", isActive: true, currentPricing: null, createdBy: null, updatedBy: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
const PRODUCTS = [
  pr(50, PRODUCT_TYPES[0], "4080", "Retired Associate", A),
  pr(51, PRODUCT_TYPES[0], "4090", "Undergraduate Student", A),
  pr(52, PRODUCT_TYPES[0], "4000", "General (all grades)", A),
  pr(53, PRODUCT_TYPES[0], "4099", "Honorary Member", A),
  pr(54, PRODUCT_TYPES[1], "4080", "Tenant B Retired", B),
];

const ProductType = {
  findOne: (filter) => {
    calls.productTypeFindOne.push(filter);
    return q(
      PRODUCT_TYPES.find(
        (t) =>
          (filter._id === undefined || String(t._id) === String(filter._id)) &&
          (filter.code === undefined || t.code === filter.code) &&
          t.tenantId === filter.tenantId &&
          t.isDeleted === filter.isDeleted
      ) || null
    );
  },
};
const Product = {
  find: (filter) => {
    calls.productFind.push(filter);
    return q(
      PRODUCTS.filter(
        (p) =>
          String(p.productTypeId) === String(filter.productTypeId) &&
          p.tenantId === filter.tenantId &&
          p.isDeleted === filter.isDeleted &&
          (filter.code === undefined || p.code === filter.code)
      ).sort((x, y) => x.name.localeCompare(y.name))
    );
  },
};

// ---- in-memory PolicyCache (Redis-enabled shape) ----
const cacheStore = new Map(); // full key (prefix + key) -> value
const cacheOps = []; // ["get"|"set", fullKey]
const globToRegex = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const fakeRedis = {
  keys: async (pattern) => [...cacheStore.keys()].filter((k) => globToRegex(pattern).test(k)),
  del: async (keys) => {
    let n = 0;
    for (const k of [].concat(keys)) if (cacheStore.delete(k)) n++;
    return n;
  },
};
class FakePolicyCache {
  constructor(options = {}) {
    this.prefix = options.prefix;
    this.enabled = true;
    this.redis = fakeRedis;
  }
  async initialize() {}
  async get(key) {
    cacheOps.push(["get", this.prefix + key]);
    return cacheStore.has(this.prefix + key) ? cacheStore.get(this.prefix + key) : null;
  }
  async set(key, value) {
    cacheOps.push(["set", this.prefix + key]);
    cacheStore.set(this.prefix + key, value);
  }
  async delete(key) {
    cacheStore.delete(this.prefix + key);
  }
  async del(key) {
    return this.delete(key);
  }
  async clear() {
    for (const k of [...cacheStore.keys()]) if (k.startsWith(this.prefix)) cacheStore.delete(k);
  }
  async getStats() {
    return { enabled: true };
  }
}

const resetState = () => {
  cacheStore.clear();
  cacheOps.length = 0;
  for (const k of Object.keys(calls)) calls[k].length = 0;
};

// ---- auth stub: trusted tenant from x-test-tenant only (stands in for the verified gateway context) ----
const authMock = () => {
  const actual = jest.requireActual("../../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t) {
        req.ctx = { tenantId: t, userId: "u1", roles: ["SU"], permissions: [] };
        req.user = { id: "u1", tenantId: t, userType: req.headers["x-test-user-type"] || "CRM" };
        req.tenantId = t;
      }
      next();
    },
  };
};

const startApp = async () => {
  const express = require("express");
  const { AppError } = require("../../errors/AppError");
  const app = express();
  app.use(express.json());
  app.use("/api", require("../../routes/lookup.router"));
  app.use("/api", require("../../routes/product.routes"));
  // Same AppError envelope as app.js
  app.use((err, req, res, next) => {
    if (err instanceof AppError || err.name === "AppError") {
      return res.status(err.status).json({ success: false, error: { message: err.message, code: err.code, status: err.status } });
    }
    return res.status(500).json({ success: false, error: { message: "Internal server error" } });
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return server;
};

const call = (server, method, path, { tenant, userType, headers = {}, body } = {}) =>
  new Promise((resolve) => {
    const h = { "content-type": "application/json", ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
    if (userType) h["x-test-user-type"] = userType;
    const rq = http.request({ port: server.address().port, path, method, headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = b ? JSON.parse(b) : null; } catch (e) { parsed = { raw: b }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE" }); });
    if (body) rq.write(JSON.stringify(body));
    rq.end();
  });

module.exports = {
  A, B, D, id, TYPES, LOOKUPS, PRODUCT_TYPES, PRODUCTS,
  LookupType, Lookup, ProductType, Product, FakePolicyCache,
  cacheStore, cacheOps, calls, resetState, authMock, startApp, call,
};
