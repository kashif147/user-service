const mongoose = require("mongoose");

const contactTypeSchema = new mongoose.Schema(
  {
    contactType: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    isdeleted: { type: Boolean, default: false },
    isactive: { type: Boolean, default: true },
    userid: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ContactType", contactTypeSchema);
