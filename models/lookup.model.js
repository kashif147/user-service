const mongoose = require('mongoose');

const lookupSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        maxlength: 10 // Code length constraint
    },
    lookupname: {
        type: String,
        required: true,
        maxlength: 100 // Lookname length constraint
    },
    DisplayName: {
        type: String,
        maxlength: 100 // Displayname length constraint
    },
    Parentlookupid: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lookup', // Self-reference to the Look collection
        default: null
    },
    lookuptypeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LookupType', // Reference to LookType collection
        required: true
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
        ref: 'User', // Reference to User collection
        required: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Lookup', lookupSchema);
