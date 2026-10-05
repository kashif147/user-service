/**
 * Phase 1F — ProductType uniqueness contract (schema only, no Mongo connection).
 *
 * ProductType.code must be unique PER TENANT, not globally: two tenants may use the same
 * code. The field-level `unique: true` on `code` made Mongoose (autoIndex) build a global
 * unique `code_1` index; it was removed so the compound `{ code, tenantId }` unique index is
 * the only uniqueness constraint the schema declares.
 *
 * Note: removing the schema option does NOT drop an already-built `code_1` index in Mongo —
 * that is a separate, explicit index migration.
 */
const ProductType = require("../models/productType.model");

const schemaIndexes = () => ProductType.schema.indexes(); // [[keys, options], ...]
const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const findIndex = (keys) => schemaIndexes().find(([k]) => sameKeys(k, keys));

describe("ProductType schema indexes (Phase 1F)", () => {
  test("A no standalone index on { code: 1 } (unique or otherwise)", () => {
    expect(findIndex({ code: 1 })).toBeUndefined();
    expect(ProductType.schema.path("code").options.unique).toBeUndefined();
  });

  test("B unique compound index on { code: 1, tenantId: 1 } is preserved", () => {
    const ix = findIndex({ code: 1, tenantId: 1 });
    expect(ix).toBeDefined();
    expect(ix[1].unique).toBe(true);
  });

  test("C unrelated indexes are unchanged and nothing else was added", () => {
    const tenantActive = findIndex({ tenantId: 1, isActive: 1, isDeleted: 1 });
    const nameTenant = findIndex({ name: 1, tenantId: 1 });
    expect(tenantActive).toBeDefined();
    expect(tenantActive[1].unique).toBeFalsy();
    expect(nameTenant).toBeDefined();
    expect(nameTenant[1].unique).toBeFalsy();
    expect(schemaIndexes()).toHaveLength(3);
  });

  test("D code field keeps its other constraints", () => {
    const opts = ProductType.schema.path("code").options;
    expect(opts.type).toBe(String);
    expect(opts.required).toBe(true);
    expect(opts.maxlength).toBe(20);
    expect(opts.uppercase).toBe(true);
    expect(opts.trim).toBe(true);
  });
});
