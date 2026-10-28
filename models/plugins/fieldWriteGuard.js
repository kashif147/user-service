/**
 * Phase B / Z3: a schema plugin that checks every value written to one array/string field, on every
 * Mongoose write path - document save/create/validate, insertMany, bulkWrite, and query updates
 * (updateOne / updateMany / findOneAndUpdate / findByIdAndUpdate / replaceOne / findOneAndReplace),
 * whether or not runValidators is set. Raw driver writes (Model.collection / db.collection) are not
 * covered; nothing in the request path uses them.
 *
 *   schema.plugin(fieldWriteGuard, { fields: ["permissions"], check(values, field) { throw ... } })
 *
 * `check` receives the flat list of values being written to `field` (array elements flattened) and
 * throws to refuse the write. An aggregation-pipeline update that touches the field cannot be inspected
 * and is refused.
 */
const UPDATE_OPS = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"];

const flat = (v) => (Array.isArray(v) ? v.flat(Infinity) : v === undefined ? [] : [v]);

/** Values an update document writes to `field` (or to `field.<n>` / `field.$`). */
function valuesWritten(update, field) {
  if (!update || typeof update !== "object") return [];
  const out = [];
  const take = (obj, unwrapEach) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (k !== field && !k.startsWith(`${field}.`)) continue;
      out.push(...flat(unwrapEach && v && typeof v === "object" && !Array.isArray(v) && "$each" in v ? v.$each : v));
    }
  };
  take(update, false); // replacement document / implicit $set
  take(update.$set, false);
  take(update.$setOnInsert, false);
  take(update.$push, true);
  take(update.$addToSet, true);
  return out;
}

function touchesInPipeline(update, field) {
  return Array.isArray(update) && JSON.stringify(update).includes(field);
}

module.exports = function fieldWriteGuard(schema, { fields, check }) {
  const checkDoc = (doc) => {
    for (const f of fields) check(flat(doc && typeof doc.get === "function" ? doc.get(f) : doc?.[f]), f);
  };
  const checkUpdate = (update) => {
    for (const f of fields) {
      if (touchesInPipeline(update, f)) throw new Error(`pipeline updates to ${f} are not allowed`);
      if (!Array.isArray(update)) check(valuesWritten(update, f), f);
    }
  };
  const guard = (fn) => function guarded(next, ...args) {
    try {
      fn.call(this, ...args);
      return next();
    } catch (err) {
      return next(err);
    }
  };

  schema.pre("validate", guard(function () { checkDoc(this); }));
  schema.pre("save", guard(function () { checkDoc(this); })); // validateBeforeSave: false still checked
  schema.pre("insertMany", guard(function (docs) { for (const d of flat(docs)) checkDoc(d); }));
  schema.pre("bulkWrite", guard(function (ops) {
    for (const op of ops || []) {
      if (op.insertOne) checkDoc(op.insertOne.document);
      for (const k of ["updateOne", "updateMany"]) if (op[k]) checkUpdate(op[k].update);
      if (op.replaceOne) checkUpdate(op.replaceOne.replacement);
    }
  }));
  for (const op of UPDATE_OPS) schema.pre(op, guard(function () { checkUpdate(this.getUpdate()); }));
};

module.exports.valuesWritten = valuesWritten;
