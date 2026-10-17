/**
 * scripts/clear-crm-oauth-tokens.js against a real MongoDB.
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (same variable as the other
 * database suites); skipped otherwise. The test database is dropped.
 */
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;
const { run: clear } = require("../scripts/clear-crm-oauth-tokens");

run("clear-crm-oauth-tokens against MongoDB", () => {
  let db;
  const oid = () => new mongoose.Types.ObjectId();
  const T1 = oid();
  const T2 = oid();
  const R = oid();
  const users = () => db.collection("users");
  const crm = (o) => ({
    _id: oid(), tenantId: o.t, userType: "CRM", userEmail: o.email, userMicrosoftId: o.oid, userIssuer: "iss", roles: [R], isActive: true,
    tokens: o.tokens,
  });

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `crmtokens_test_${Date.now()}` });
    db = mongoose.connection.db;
  });
  afterAll(async () => {
    await db.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await users().deleteMany({});
    await users().insertMany([
      crm({ t: T1, email: "a@x", oid: "o1", tokens: { id_token: "CRM-ID-1", refresh_token: "CRM-RT-1", id_token_expires_in: 3600, refresh_token_expires_in: null, refresh_token_expires_at: null } }),
      crm({ t: T2, email: "b@x", oid: "o2", tokens: { id_token: "CRM-ID-2", refresh_token: "CRM-RT-2", access_token: "CRM-AT-2" } }),
      crm({ t: T2, email: "c@x", oid: "o3", tokens: { id_token: null, refresh_token: null } }), // already clean
      { _id: oid(), tenantId: T1, userType: "PORTAL", userEmail: "m@x", roles: [R], isActive: true, tokens: { id_token: "P-ID", refresh_token: "P-RT", refresh_token_expires_at: Date.now() + 1e6 } },
    ]);
  });

  test("dry run (default): counts only, nothing written", async () => {
    const lines = [];
    const before = JSON.stringify(await users().find({}).sort({ _id: 1 }).toArray());
    const r = await clear(db, { log: (l) => lines.push(l) });
    expect(r.executed).toBe(false);
    expect(r.before.crm).toEqual({ users: 3, refreshToken: 2, idToken: 2, accessToken: 1, anyMaterial: 2 });
    expect(r.before.portal).toMatchObject({ users: 1, refreshToken: 1, idToken: 1 });
    expect(JSON.stringify(await users().find({}).sort({ _id: 1 }).toArray())).toBe(before);
    expect(lines.join("\n")).not.toMatch(/CRM-ID|CRM-RT|CRM-AT|P-ID|P-RT/);
  });

  test("execute: CRM token material -> 0; identity, tenant, roles, status and PORTAL tokens untouched", async () => {
    const lines = [];
    const r = await clear(db, { execute: true, log: (l) => lines.push(l) });
    expect(r.ok).toBe(true);
    expect(r.modified).toBe(2);
    expect(r.after.crm).toEqual({ users: 3, refreshToken: 0, idToken: 0, accessToken: 0, anyMaterial: 0 });
    const crmDocs = await users().find({ userType: "CRM" }).sort({ userEmail: 1 }).toArray();
    expect(crmDocs.map((u) => [u.userMicrosoftId, String(u.tenantId), u.roles.map(String), u.isActive])).toEqual([
      ["o1", String(T1), [String(R)], true], ["o2", String(T2), [String(R)], true], ["o3", String(T2), [String(R)], true],
    ]);
    expect(crmDocs[1].tokens).toEqual({ id_token: null, refresh_token: null, id_token_expires_in: null, refresh_token_expires_in: null, refresh_token_expires_at: null });
    const portal = await users().findOne({ userType: "PORTAL" });
    expect(portal.tokens).toMatchObject({ id_token: "P-ID", refresh_token: "P-RT" });
    expect(lines.join("\n")).not.toMatch(/CRM-ID|CRM-RT|CRM-AT|P-ID|P-RT/);
    // idempotent
    const again = await clear(db, { execute: true });
    expect(again).toMatchObject({ ok: true, modified: 0 });
  });
});
