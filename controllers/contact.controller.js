const mongoose = require("mongoose");
const Contact = require("../models/contact");
const ContactType = require("../models/contactType");

// PDP rollout P2 (review-package A.5): contacts are global reference data. A caller whose tenant permissions
// are not "*" (i.e. not ASU) gets the picker projection only - id, names and contact type - never phone,
// email or address (those stay with ASU, e.g. Configuration -> Solicitors). ASU can ask for the picker view
// with ?view=picker. ?contactType=<contactType|code> filters server-side for every caller.
const PICKER_FIELDS = "_id forename surname contactTypeId";
const FULL_FIELDS = "surname forename contactPhone contactEmail contactAddress contactTypeId isactive createdAt updatedAt";
const fullViewer = (req) => Array.isArray(req.user?.permissions) && req.user.permissions.includes("*");
const pickerView = (req) => !fullViewer(req) || req.query?.view === "picker";
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolves ?contactType to ContactType ids (matched on contactType or code). null = no filter. */
async function contactTypeFilter(req) {
  const raw = req.query?.contactType;
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const types = await ContactType.find({ isdeleted: { $ne: true }, $or: [{ contactType: raw.trim() }, { code: raw.trim() }] }).select("_id");
  return types.map((t) => t._id);
}
const { AppError } = require("../errors/AppError");

/**
 * Get all contacts
 * GET /api/contacts
 */
const getAllContacts = async (req, res, next) => {
  try {
    const picker = pickerView(req);
    const query = { isdeleted: false };
    const typeIds = await contactTypeFilter(req);
    if (typeIds) query.contactTypeId = { $in: typeIds };
    const contacts = await Contact.find(query)
      .populate("contactTypeId", "contactType displayName")
      .select(picker ? PICKER_FIELDS : FULL_FIELDS)
      .sort({ surname: 1, forename: 1 });

    res.status(200).json({
      success: true,
      data: contacts,
      count: contacts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching contacts:", error);
    return next(AppError.internalServerError("Failed to retrieve contacts"));
  }
};

/**
 * Get single contact by ID
 * GET /api/contacts/:id
 */
const getContactById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact ID format"));
    }

    const contact = await Contact.findOne({ _id: id, isdeleted: false })
      .populate("contactTypeId", "contactType displayName")
      .select(pickerView(req) ? PICKER_FIELDS : FULL_FIELDS);

    if (!contact) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.status(200).json({
      success: true,
      data: contact,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching contact:", error);
    return next(AppError.internalServerError("Failed to retrieve contact"));
  }
};

/**
 * Create new contact
 * POST /api/contacts
 */
const createContact = async (req, res, next) => {
  try {
    const {
      surname,
      forename,
      contactPhone,
      contactEmail,
      contactAddress,
      contactTypeId,
      isactive,
    } = req.body;

    const userid = req.ctx?.userId || req.user?.id;

    if (!surname || !forename || !contactPhone || !contactEmail) {
      return next(
        AppError.badRequest(
          "Surname, forename, contactPhone, and contactEmail are required"
        )
      );
    }

    // Validate contactTypeId if provided
    if (contactTypeId && !mongoose.Types.ObjectId.isValid(contactTypeId)) {
      return next(AppError.badRequest("Invalid contact type ID format"));
    }

    const contact = await Contact.create({
      surname,
      forename,
      contactPhone,
      contactEmail,
      contactAddress: {
        buildingOrHouse: contactAddress?.buildingOrHouse || "",
        streetOrRoad: contactAddress?.streetOrRoad || "",
        areaOrTown: contactAddress?.areaOrTown || "",
        cityCountyOrPostCode: contactAddress?.cityCountyOrPostCode || "",
        eircode: contactAddress?.eircode || "",
      },
      contactTypeId: contactTypeId || null,
      isactive: isactive !== undefined ? isactive : true,
      userid,
    });

    res.status(201).json({
      success: true,
      data: contact,
      message: "Contact created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating contact:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to create contact"));
  }
};

/**
 * Update contact
 * PUT /api/contacts/:id
 */
const updateContact = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      surname,
      forename,
      contactPhone,
      contactEmail,
      contactAddress,
      contactTypeId,
      isactive,
    } = req.body;

    const userid = req.ctx?.userId || req.user?.id;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact ID format"));
    }

    // Validate contactTypeId if provided
    if (contactTypeId && !mongoose.Types.ObjectId.isValid(contactTypeId)) {
      return next(AppError.badRequest("Invalid contact type ID format"));
    }

    const contact = await Contact.findOne({ _id: id, isdeleted: false });
    if (!contact) {
      return res.notFoundRecord("Contact not found");
    }

    if (surname) contact.surname = surname;
    if (forename) contact.forename = forename;
    if (contactPhone) contact.contactPhone = contactPhone;
    if (contactEmail) contact.contactEmail = contactEmail;

    if (contactAddress) {
      if (contactAddress.buildingOrHouse !== undefined)
        contact.contactAddress.buildingOrHouse = contactAddress.buildingOrHouse;
      if (contactAddress.streetOrRoad !== undefined)
        contact.contactAddress.streetOrRoad = contactAddress.streetOrRoad;
      if (contactAddress.areaOrTown !== undefined)
        contact.contactAddress.areaOrTown = contactAddress.areaOrTown;
      if (contactAddress.cityCountyOrPostCode !== undefined)
        contact.contactAddress.cityCountyOrPostCode =
          contactAddress.cityCountyOrPostCode;
      if (contactAddress.eircode !== undefined)
        contact.contactAddress.eircode = contactAddress.eircode;
    }

    if (contactTypeId !== undefined) contact.contactTypeId = contactTypeId;
    if (typeof isactive !== "undefined") contact.isactive = isactive;
    if (userid) contact.userid = userid;

    await contact.save();

    res.status(200).json({
      success: true,
      data: contact,
      message: "Contact updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating contact:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to update contact"));
  }
};

/**
 * Delete contact (soft delete)
 * DELETE /api/contacts/:id
 */
const deleteContact = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact ID format"));
    }

    const contact = await Contact.findOne({ _id: id, isdeleted: false });
    if (!contact) {
      return res.notFoundRecord("Contact not found");
    }

    contact.isdeleted = true;
    await contact.save();

    res.status(200).json({
      success: true,
      message: "Contact deleted successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error deleting contact:", error);
    return next(AppError.internalServerError("Failed to delete contact"));
  }
};

/**
 * Search contacts
 * GET /api/contacts/search?q=searchTerm
 */
const searchContacts = async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return next(
        AppError.badRequest("Search query must be at least 2 characters")
      );
    }

    const searchTerm = q.trim();
    const picker = pickerView(req);
    // Picker callers search by name only (searching phone/email would disclose them by probing).
    const fields = picker ? ["surname", "forename"] : ["surname", "forename", "contactPhone", "contactEmail"];
    const term = picker ? escapeRegex(searchTerm) : searchTerm;
    const query = { isdeleted: false, $or: fields.map((f) => ({ [f]: { $regex: term, $options: "i" } })) };
    const typeIds = await contactTypeFilter(req);
    if (typeIds) query.contactTypeId = { $in: typeIds };
    const contacts = await Contact.find(query)
      .populate("contactTypeId", "contactType displayName")
      .select(picker ? PICKER_FIELDS : "surname forename contactPhone contactEmail contactTypeId isactive")
      .sort({ surname: 1, forename: 1 })
      .limit(20);

    res.status(200).json({
      success: true,
      data: contacts,
      count: contacts.length,
      searchTerm,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error searching contacts:", error);
    return next(AppError.internalServerError("Failed to search contacts"));
  }
};

module.exports = {
  getAllContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
};
