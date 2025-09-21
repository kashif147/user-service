const mongoose = require("mongoose");

const countrySchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    }, // ISO2
    name: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    }, // ISO3
    displayname: { type: String, required: true },
    callingCodes: { type: [String], default: [] }, // e.g. ["+353"]
    isdeleted: { type: Boolean, default: false },
    isactive: { type: Boolean, default: true },
    userid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Country", countrySchema);
