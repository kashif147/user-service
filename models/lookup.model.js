const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    eircode: { type: String, default: null },
    buildingOrHouse: { type: String, required: true },
    streetOrRoad: { type: String, default: null },
    areaOrTown: { type: String, default: null },
    countyCityOrPostCode: { type: String, required: true },
    country: { type: String, required: true },
    fullAddress: { type: String, default: null },
  },
  { _id: false }
);

const lookupSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      maxlength: 10, // Code length constraint
    },
    lookupname: {
      type: String,
      required: true,
      maxlength: 100, // Lookname length constraint
    },
    DisplayName: {
      type: String,
      maxlength: 100, // Displayname length constraint
    },
    Parentlookupid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lookup", // Self-reference to the Look collection
      default: null,
    },
    lookuptypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LookupType", // Reference to LookType collection
      required: true,
    },
    isdeleted: {
      type: Boolean,
      default: false,
    },
    isactive: {
      type: Boolean,
      default: true,
    },
    userid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // Reference to User collection
      required: true,
    },
    officer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    worklocationAddress: {
      type: addressSchema,
      required: false,
      default: null,
    },
    processSalaryDeduction: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

lookupSchema.pre("save", function (next) {
  if (this.worklocationAddress && this.isModified("worklocationAddress")) {
    const addr = this.worklocationAddress;
    const parts = [];
    if (addr.buildingOrHouse?.trim()) parts.push(addr.buildingOrHouse.trim());
    if (addr.streetOrRoad?.trim()) parts.push(addr.streetOrRoad.trim());
    if (addr.areaOrTown?.trim()) parts.push(addr.areaOrTown.trim());
    if (addr.countyCityOrPostCode?.trim()) parts.push(addr.countyCityOrPostCode.trim());
    if (addr.country?.trim()) parts.push(addr.country.trim());
    this.worklocationAddress.fullAddress = parts.join(", ");
  }
  next();
});

lookupSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();
  const addr = update?.worklocationAddress || update?.$set?.worklocationAddress;
  if (addr && addr.fullAddress === undefined) {
    const parts = [];
    if (addr.buildingOrHouse?.trim()) parts.push(addr.buildingOrHouse.trim());
    if (addr.streetOrRoad?.trim()) parts.push(addr.streetOrRoad.trim());
    if (addr.areaOrTown?.trim()) parts.push(addr.areaOrTown.trim());
    if (addr.countyCityOrPostCode?.trim()) parts.push(addr.countyCityOrPostCode.trim());
    if (addr.country?.trim()) parts.push(addr.country.trim());
    addr.fullAddress = parts.join(", ");
  }
  next();
});

// Indexes for performance optimization
// Single field indexes
lookupSchema.index({ lookuptypeId: 1 });
lookupSchema.index({ Parentlookupid: 1 });
lookupSchema.index({ isdeleted: 1 });
lookupSchema.index({ isactive: 1 });
lookupSchema.index({ userid: 1 });
lookupSchema.index({ officer: 1 });

// Compound indexes for common query patterns
// Used in getLookupsByTypeWithHierarchy: find({ lookuptypeId, isdeleted: false, isactive: true })
lookupSchema.index({ lookuptypeId: 1, isdeleted: 1, isactive: 1 });

// For queries filtering by active status and lookup type
lookupSchema.index({ isactive: 1, isdeleted: 1 });

// For hierarchy queries that need to find children by parent
lookupSchema.index({ Parentlookupid: 1, isdeleted: 1, isactive: 1 });

// Note: _id is automatically indexed by MongoDB
// Note: code already has unique index from unique: true

module.exports = mongoose.model("Lookup", lookupSchema);
