// Phase A / A8 — users: identity uniqueness only for populated identifiers.
// Run: npx jest tests/userIdentityIndexes.a8.test.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const User = require("../models/user.model");

const idx = () => User.schema.indexes();
const find = (field) => idx().find(([key]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, [field]: 1 }));

for (const field of ["userMicrosoftId", "userSubject"]) {
  test(`${field}: unique per tenant ONLY when populated (partial { $gt: "" })`, () => {
    const hit = find(field);
    assert.ok(hit, `index on { tenantId, ${field} } declared`);
    const [, opts] = hit;
    assert.strictEqual(opts.unique, true);
    assert.strictEqual(opts.name, `tenantId_1_${field}_1_partial`);
    assert.deepStrictEqual(opts.partialFilterExpression, { [field]: { $gt: "" } });
    assert.strictEqual(idx().filter(([key]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, [field]: 1 })).length, 1, "no non-partial duplicate declaration");
  });
}

test("email uniqueness per tenant is unchanged (non-partial)", () => {
  const hit = idx().find(([key]) => JSON.stringify(key) === JSON.stringify({ tenantId: 1, userEmail: 1 }));
  assert.ok(hit && hit[1].unique === true && !hit[1].partialFilterExpression);
});

test("the tenant-isolation script never recreates the non-partial identity indexes", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "migrate-tenant-isolation.js"), "utf8");
  assert.match(src, /name: "tenantId_1_userMicrosoftId_1_partial", partialFilterExpression: \{ userMicrosoftId: \{ \$gt: "" \} \}/);
  assert.match(src, /name: "tenantId_1_userSubject_1_partial", partialFilterExpression: \{ userSubject: \{ \$gt: "" \} \}/);
});
