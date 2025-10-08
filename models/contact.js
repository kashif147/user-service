const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    surname: { type: String, required: true },
    forename: { type: String, required: true },
    contactPhone: { type: String, required: true },
    contactEmail: { type: String, required: true },
    contactAddress: {
      buildingOrHouse: { type: String, required: false },
      streetOrRoad: { type: String, required: false },
      areaOrTown: { type: String, required: false },
      cityCountyOrPostCode: { type: String, required: false },
      eircode: { type: String, required: false }
    },
    contactTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactType', required: false },
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

module.exports = mongoose.model('Contact', contactSchema);

