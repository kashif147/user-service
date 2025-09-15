// models/LookupType.js
const mongoose = require('mongoose');

const lookupTypeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    minlength: 3,
    maxlength: 10
  },
  lookuptype: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 50
  },
  displayname: {
    type: String,
    trim: true,
    minlength: 3,
    maxlength: 50
  },
  isdeleted: {
    type: Boolean,
    default: false
  },
  isactive: {
    type: Boolean,
    default: true
  },
  userid: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Assuming 'User' is the model name for users in your database
    required: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('LookupType', lookupTypeSchema);


