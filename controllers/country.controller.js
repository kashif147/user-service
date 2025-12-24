const mongoose = require("mongoose");
const Country = require("../models/country.model");
const { AppError } = require("../errors/AppError");
const lookupCacheService = require("../services/lookupCacheService");

/**
 * Get all countries
 * GET /api/countries
 */
const getAllCountries = async (req, res, next) => {
  try {
    // Use cache service to get all countries
    const countries = await lookupCacheService.getAllCountries(async () => {
      // Database query function
      return await Country.find({ isdeleted: false })
        .select(
          "code name displayname callingCodes isactive createdAt updatedAt"
        )
        .sort({ displayname: 1 });
    });

    res.status(200).json({
      success: true,
      data: countries,
      count: countries.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching countries:", error);
    return next(AppError.internalServerError("Failed to retrieve countries"));
  }
};

/**
 * Get single country by ID
 * GET /api/countries/:id
 */
const getCountryById = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Validate ObjectId format
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid country ID format"));
    }

    // Use cache service to get country by ID
    const country = await lookupCacheService.getCountryById(id, async () => {
      // Database query function
      return await Country.findOne({ _id: id, isdeleted: false }).select(
        "code name displayname callingCodes isactive createdAt updatedAt"
      );
    });

    if (!country) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.status(200).json({
      success: true,
      data: country,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching country:", error);
    return next(AppError.internalServerError("Failed to retrieve country"));
  }
};

/**
 * Get country by code
 * GET /api/countries/code/:code
 */
const getCountryByCode = async (req, res, next) => {
  try {
    const { code } = req.params;

    // Use cache service to get country by code
    const country = await lookupCacheService.getCountryByCode(
      code.toUpperCase(),
      async () => {
        // Database query function
        return await Country.findOne({
          code: code.toUpperCase(),
          isdeleted: false,
        }).select(
          "code name displayname callingCodes isactive createdAt updatedAt"
        );
      }
    );

    if (!country) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    res.status(200).json({
      success: true,
      data: country,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching country by code:", error);
    return next(AppError.internalServerError("Failed to retrieve country"));
  }
};

/**
 * Create new country
 * POST /api/countries
 */
const createCountry = async (req, res, next) => {
  try {
    const { code, name, displayname, callingCodes, isactive } = req.body;

    // Get userId from authenticated user context (set by policyAdapter middleware)
    const userid = req.ctx?.userId || req.user?.id;

    // Validate required fields
    if (!code || !name || !displayname) {
      return next(
        AppError.badRequest("Code, name, and displayname are required")
      );
    }

    // Validate code format (ISO2)
    if (code.length !== 2) {
      return next(
        AppError.badRequest("Country code must be exactly 2 characters (ISO2)")
      );
    }

    // Validate name format (ISO3)
    if (name.length !== 3) {
      return next(
        AppError.badRequest("Country name must be exactly 3 characters (ISO3)")
      );
    }

    const country = await Country.create({
      code: code.toUpperCase(),
      name: name.toUpperCase(),
      displayname,
      callingCodes: callingCodes || [],
      isactive: isactive !== undefined ? isactive : true,
      userid,
    });

    // Invalidate cache after successful creation
    await lookupCacheService.invalidateCountryCache();

    res.status(201).json({
      success: true,
      data: country,
      message: "Country created successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating country:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to create country"));
  }
};

/**
 * Update country
 * PUT /api/countries/:id
 */
const updateCountry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { code, name, displayname, callingCodes, isactive } = req.body;

    // Get userId from authenticated user context (set by policyAdapter middleware)
    const userid = req.ctx?.userId || req.user?.id;

    // Validate ObjectId format
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid country ID format"));
    }

    const country = await Country.findOne({ _id: id, isdeleted: false });
    if (!country) {
      return res.notFoundRecord("Country not found");
    }

    // Store old values for audit
    const oldValues = {
      code: country.code,
      name: country.name,
      displayname: country.displayname,
      callingCodes: country.callingCodes,
      isactive: country.isactive,
    };

    // Update fields
    if (code) {
      if (code.length !== 2) {
        return next(
          AppError.badRequest(
            "Country code must be exactly 2 characters (ISO2)"
          )
        );
      }
      country.code = code.toUpperCase();
    }
    if (name) {
      if (name.length !== 3) {
        return next(
          AppError.badRequest(
            "Country name must be exactly 3 characters (ISO3)"
          )
        );
      }
      country.name = name.toUpperCase();
    }
    if (displayname) country.displayname = displayname;
    if (callingCodes) country.callingCodes = callingCodes;
    if (typeof isactive !== "undefined") country.isactive = isactive;
    if (userid) country.userid = userid;

    await country.save();

    // Invalidate cache after successful update
    await lookupCacheService.invalidateCountryCache();
    await lookupCacheService.invalidateCountryCache(country._id.toString());
    await lookupCacheService.invalidateCountryCache(null, oldValues.code);

    res.status(200).json({
      success: true,
      data: country,
      message: "Country updated successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating country:", error);

    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return next(AppError.badRequest(`${field} must be unique`));
    }

    return next(AppError.internalServerError("Failed to update country"));
  }
};

/**
 * Delete country (soft delete)
 * DELETE /api/countries/:id
 */
const deleteCountry = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Validate ObjectId format
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return next(AppError.badRequest("Invalid country ID format"));
    }

    const country = await Country.findOne({ _id: id, isdeleted: false });
    if (!country) {
      return res.notFoundRecord("Country not found");
    }

    // Store country data for audit
    const deletedCountry = {
      countryId: country._id,
      code: country.code,
      name: country.name,
      displayname: country.displayname,
      userid: country.userid,
      timestamp: new Date(),
    };

    // Soft delete
    country.isdeleted = true;
    await country.save();

    // Invalidate cache after successful deletion
    await lookupCacheService.invalidateCountryCache();
    await lookupCacheService.invalidateCountryCache(country._id.toString());
    await lookupCacheService.invalidateCountryCache(null, country.code);

    res.status(200).json({
      success: true,
      message: "Country deleted successfully",
      data: deletedCountry,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error deleting country:", error);
    return next(AppError.internalServerError("Failed to delete country"));
  }
};

/**
 * Search countries
 * GET /api/countries/search?q=searchTerm
 */
const searchCountries = async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return next(
        AppError.badRequest("Search query must be at least 2 characters")
      );
    }

    const searchTerm = q.trim();
    const countries = await Country.find({
      isdeleted: false,
      $or: [
        { displayname: { $regex: searchTerm, $options: "i" } },
        { code: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
      ],
    })
      .select("code name displayname callingCodes isactive")
      .sort({ displayname: 1 })
      .limit(20);

    res.status(200).json({
      success: true,
      data: countries,
      count: countries.length,
      searchTerm,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error searching countries:", error);
    return next(AppError.internalServerError("Failed to search countries"));
  }
};

module.exports = {
  getAllCountries,
  getCountryById,
  getCountryByCode,
  createCountry,
  updateCountry,
  deleteCountry,
  searchCountries,
};
