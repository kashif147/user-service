const mongoose = require("mongoose");
const ContactType = require("../models/contactType");
const { AppError } = require("../errors/AppError");

/**
 * Get all contact types
 * GET /api/contact-types
 */
const getAllContactTypes = async (req, res, next) => {
  try {
    const contactTypes = await ContactType.find({ isdeleted: false })
      .select("contactType displayName code isactive createdAt updatedAt")
      .sort({ displayName: 1 });

    res.status(200).json({
      success: true,
      data: contactTypes,
      count: contactTypes.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching contact types:", error);
    return next(
      AppError.internalServerError("Failed to retrieve contact types")
    );
  }
};

/**
 * Get single contact type by ID
 * GET /api/contact-types/:id
 */
const getContactTypeById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact type ID format"));
    }

    const contactType = await ContactType.findOne({
      _id: id,
      isdeleted: false,
    }).select("contactType displayName code isactive createdAt updatedAt");

    if (!contactType) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.status(200).json({
      success: true,
      data: contactType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching contact type:", error);
    return next(
      AppError.internalServerError("Failed to retrieve contact type")
    );
  }
};

/**
 * Create new contact type
 * POST /api/contact-types
 */
const createContactType = async (req, res, next) => {
  try {
    const { contactType, displayName, code, isactive } = req.body;

    const userid = req.ctx?.userId || req.user?.id;

    if (!contactType || !displayName || !code) {
      return next(
        AppError.badRequest("contactType, displayName, and code are required")
      );
    }

    const newContactType = await ContactType.create({
      contactType,
      displayName,
      code,
      isactive: isactive !== undefined ? isactive : true,
      userid,
    });

    res.status(201).json({
      success: true,
      data: newContactType,
      message: "Contact type created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating contact type:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to create contact type"));
  }
};

/**
 * Update contact type
 * PUT /api/contact-types/:id
 */
const updateContactType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { contactType, displayName, code, isactive } = req.body;

    const userid = req.ctx?.userId || req.user?.id;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact type ID format"));
    }

    const existingContactType = await ContactType.findOne({
      _id: id,
      isdeleted: false,
    });
    if (!existingContactType) {
      return next(AppError.notFound("Contact type not found"));
    }

    if (contactType) existingContactType.contactType = contactType;
    if (displayName) existingContactType.displayName = displayName;
    if (code) existingContactType.code = code;
    if (typeof isactive !== "undefined")
      existingContactType.isactive = isactive;
    if (userid) existingContactType.userid = userid;

    await existingContactType.save();

    res.status(200).json({
      success: true,
      data: existingContactType,
      message: "Contact type updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating contact type:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to update contact type"));
  }
};

/**
 * Delete contact type (soft delete)
 * DELETE /api/contact-types/:id
 */
const deleteContactType = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid contact type ID format"));
    }

    const contactType = await ContactType.findOne({
      _id: id,
      isdeleted: false,
    });
    if (!contactType) {
      return next(AppError.notFound("Contact type not found"));
    }

    contactType.isdeleted = true;
    await contactType.save();

    res.status(200).json({
      success: true,
      message: "Contact type deleted successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error deleting contact type:", error);
    return next(AppError.internalServerError("Failed to delete contact type"));
  }
};

/**
 * Search contact types
 * GET /api/contact-types/search?q=searchTerm
 */
const searchContactTypes = async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return next(
        AppError.badRequest("Search query must be at least 2 characters")
      );
    }

    const searchTerm = q.trim();
    const contactTypes = await ContactType.find({
      isdeleted: false,
      $or: [
        { contactType: { $regex: searchTerm, $options: "i" } },
        { displayName: { $regex: searchTerm, $options: "i" } },
        { code: { $regex: searchTerm, $options: "i" } },
      ],
    })
      .select("contactType displayName code isactive")
      .sort({ displayName: 1 })
      .limit(20);

    res.status(200).json({
      success: true,
      data: contactTypes,
      count: contactTypes.length,
      searchTerm,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error searching contact types:", error);
    return next(AppError.internalServerError("Failed to search contact types"));
  }
};

module.exports = {
  getAllContactTypes,
  getContactTypeById,
  createContactType,
  updateContactType,
  deleteContactType,
  searchContactTypes,
};
