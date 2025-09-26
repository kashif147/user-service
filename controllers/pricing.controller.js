const Pricing = require("../models/pricing.model");
const Product = require("../models/product.model");
const { AppError } = require("../errors/AppError");

const getAllPricing = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { productId } = req.query;

    let query = {
      tenantId,
      isDeleted: false,
    };

    // Filter by product if provided
    if (productId) {
      query.productId = productId;
    }

    const pricing = await Pricing.find(query)
      .populate("productId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .sort({ effectiveFrom: -1 });

    const formattedPricing = pricing.map((pricingItem) => ({
      _id: pricingItem._id,
      product: pricingItem.productId
        ? {
            _id: pricingItem.productId._id,
            name: pricingItem.productId.name,
            code: pricingItem.productId.code,
            description: pricingItem.productId.description,
          }
        : null,
      currency: pricingItem.currency,
      price: pricingItem.price,
      effectiveFrom: pricingItem.effectiveFrom,
      effectiveTo: pricingItem.effectiveTo,
      status: pricingItem.status,
      isActive: pricingItem.isActive,
      createdBy: pricingItem.createdBy
        ? {
            _id: pricingItem.createdBy._id,
            name: `${pricingItem.createdBy.firstName} ${pricingItem.createdBy.lastName}`,
            email: pricingItem.createdBy.email,
          }
        : null,
      updatedBy: pricingItem.updatedBy
        ? {
            _id: pricingItem.updatedBy._id,
            name: `${pricingItem.updatedBy.firstName} ${pricingItem.updatedBy.lastName}`,
            email: pricingItem.updatedBy.email,
          }
        : null,
      createdAt: pricingItem.createdAt,
      updatedAt: pricingItem.updatedAt,
    }));

    res.status(200).json({
      success: true,
      data: formattedPricing,
      count: formattedPricing.length,
    });
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return next(AppError.internalServerError("Failed to retrieve pricing"));
  }
};

const getPricingByProduct = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { tenantId } = req.user;

    // Verify product exists
    const product = await Product.findOne({
      _id: productId,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return next(AppError.notFound("Product not found"));
    }

    const pricing = await Pricing.find({
      productId,
      tenantId,
      isDeleted: false,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .sort({ effectiveFrom: -1 });

    const formattedPricing = pricing.map((pricingItem) => ({
      _id: pricingItem._id,
      product: {
        _id: product._id,
        name: product.name,
        code: product.code,
        description: product.description,
      },
      currency: pricingItem.currency,
      price: pricingItem.price,
      effectiveFrom: pricingItem.effectiveFrom,
      effectiveTo: pricingItem.effectiveTo,
      status: pricingItem.status,
      isActive: pricingItem.isActive,
      createdBy: pricingItem.createdBy
        ? {
            _id: pricingItem.createdBy._id,
            name: `${pricingItem.createdBy.firstName} ${pricingItem.createdBy.lastName}`,
            email: pricingItem.createdBy.email,
          }
        : null,
      updatedBy: pricingItem.updatedBy
        ? {
            _id: pricingItem.updatedBy._id,
            name: `${pricingItem.updatedBy.firstName} ${pricingItem.updatedBy.lastName}`,
            email: pricingItem.updatedBy.email,
          }
        : null,
      createdAt: pricingItem.createdAt,
      updatedAt: pricingItem.updatedAt,
    }));

    res.status(200).json({
      success: true,
      data: {
        product: {
          _id: product._id,
          name: product.name,
          code: product.code,
          description: product.description,
        },
        pricing: formattedPricing,
        count: formattedPricing.length,
      },
    });
  } catch (error) {
    console.error("Error fetching pricing by product:", error);
    return next(AppError.internalServerError("Failed to retrieve pricing"));
  }
};

const getCurrentPricing = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { tenantId } = req.user;

    // Verify product exists
    const product = await Product.findOne({
      _id: productId,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return next(AppError.notFound("Product not found"));
    }

    const currentPricing = await Pricing.getCurrentPricing(productId);

    if (!currentPricing) {
      return res.status(200).json({
        success: true,
        data: {
          product: {
            _id: product._id,
            name: product.name,
            code: product.code,
            description: product.description,
          },
          currentPricing: null,
          message: "No current pricing found for this product",
        },
      });
    }

    const formattedPricing = {
      _id: currentPricing._id,
      product: {
        _id: product._id,
        name: product.name,
        code: product.code,
        description: product.description,
      },
      currency: currentPricing.currency,
      price: currentPricing.price,
      effectiveFrom: currentPricing.effectiveFrom,
      effectiveTo: currentPricing.effectiveTo,
      status: currentPricing.status,
      isActive: currentPricing.isActive,
      createdAt: currentPricing.createdAt,
      updatedAt: currentPricing.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: formattedPricing,
    });
  } catch (error) {
    console.error("Error fetching current pricing:", error);
    return next(
      AppError.internalServerError("Failed to retrieve current pricing")
    );
  }
};

const getPricing = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { tenantId } = req.user;

    const pricing = await Pricing.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    })
      .populate("productId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");

    if (!pricing) {
      return next(AppError.notFound("Pricing not found"));
    }

    const formattedPricing = {
      _id: pricing._id,
      product: pricing.productId
        ? {
            _id: pricing.productId._id,
            name: pricing.productId.name,
            code: pricing.productId.code,
            description: pricing.productId.description,
          }
        : null,
      currency: pricing.currency,
      price: pricing.price,
      effectiveFrom: pricing.effectiveFrom,
      effectiveTo: pricing.effectiveTo,
      status: pricing.status,
      isActive: pricing.isActive,
      createdBy: pricing.createdBy
        ? {
            _id: pricing.createdBy._id,
            name: `${pricing.createdBy.firstName} ${pricing.createdBy.lastName}`,
            email: pricing.createdBy.email,
          }
        : null,
      updatedBy: pricing.updatedBy
        ? {
            _id: pricing.updatedBy._id,
            name: `${pricing.updatedBy.firstName} ${pricing.updatedBy.lastName}`,
            email: pricing.updatedBy.email,
          }
        : null,
      createdAt: pricing.createdAt,
      updatedAt: pricing.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: formattedPricing,
    });
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return next(AppError.internalServerError("Failed to retrieve pricing"));
  }
};

const createPricing = async (req, res, next) => {
  try {
    const { productId, currency, price, effectiveFrom, effectiveTo, status } =
      req.body;
    const { userId, tenantId } = req.user;

    if (!productId || !currency || !price || !effectiveFrom) {
      return next(
        AppError.badRequest(
          "Product ID, currency, price, and effective from date are required"
        )
      );
    }

    // Verify product exists
    const product = await Product.findOne({
      _id: productId,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return next(AppError.badRequest("Invalid product"));
    }

    // Check for overlapping pricing periods
    const overlappingPricing = await Pricing.findOne({
      productId,
      tenantId,
      isDeleted: false,
      $or: [
        {
          effectiveFrom: { $lte: new Date(effectiveTo || "2099-12-31") },
          $or: [
            { effectiveTo: { $gte: new Date(effectiveFrom) } },
            { effectiveTo: null },
          ],
        },
      ],
    });

    if (overlappingPricing) {
      return next(
        AppError.badRequest("Pricing period overlaps with existing pricing")
      );
    }

    const pricing = await Pricing.create({
      productId,
      currency: currency.toUpperCase(),
      price,
      effectiveFrom: new Date(effectiveFrom),
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      status: status || "Active",
      isActive: status === "Active",
      createdBy: userId,
      tenantId,
    });

    const populatedPricing = await Pricing.findById(pricing._id)
      .populate("productId", "name code description")
      .populate("createdBy", "firstName lastName email");

    res.status(201).json({
      success: true,
      data: {
        _id: populatedPricing._id,
        product: {
          _id: populatedPricing.productId._id,
          name: populatedPricing.productId.name,
          code: populatedPricing.productId.code,
          description: populatedPricing.productId.description,
        },
        currency: populatedPricing.currency,
        price: populatedPricing.price,
        effectiveFrom: populatedPricing.effectiveFrom,
        effectiveTo: populatedPricing.effectiveTo,
        status: populatedPricing.status,
        isActive: populatedPricing.isActive,
        createdBy: {
          _id: populatedPricing.createdBy._id,
          name: `${populatedPricing.createdBy.firstName} ${populatedPricing.createdBy.lastName}`,
          email: populatedPricing.createdBy.email,
        },
        createdAt: populatedPricing.createdAt,
        updatedAt: populatedPricing.updatedAt,
      },
      message: "Pricing created successfully",
    });
  } catch (error) {
    console.error("Error creating pricing:", error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError("Failed to create pricing"));
  }
};

const updatePricing = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { currency, price, effectiveFrom, effectiveTo, status } = req.body;
    const { userId, tenantId } = req.user;

    const pricing = await Pricing.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!pricing) {
      return next(AppError.notFound("Pricing not found"));
    }

    // Check for overlapping pricing periods (excluding current record)
    if (effectiveFrom || effectiveTo) {
      const newEffectiveFrom = effectiveFrom
        ? new Date(effectiveFrom)
        : pricing.effectiveFrom;
      const newEffectiveTo = effectiveTo
        ? new Date(effectiveTo)
        : pricing.effectiveTo;

      const overlappingPricing = await Pricing.findOne({
        productId: pricing.productId,
        tenantId,
        isDeleted: false,
        _id: { $ne: id },
        $or: [
          {
            effectiveFrom: { $lte: newEffectiveTo || new Date("2099-12-31") },
            $or: [
              { effectiveTo: { $gte: newEffectiveFrom } },
              { effectiveTo: null },
            ],
          },
        ],
      });

      if (overlappingPricing) {
        return next(
          AppError.badRequest("Pricing period overlaps with existing pricing")
        );
      }
    }

    // Update fields
    if (currency) pricing.currency = currency.toUpperCase();
    if (price !== undefined) pricing.price = price;
    if (effectiveFrom) pricing.effectiveFrom = new Date(effectiveFrom);
    if (effectiveTo !== undefined)
      pricing.effectiveTo = effectiveTo ? new Date(effectiveTo) : null;
    if (status) {
      pricing.status = status;
      pricing.isActive = status === "Active";
    }
    pricing.updatedBy = userId;

    await pricing.save();

    const updatedPricing = await Pricing.findById(pricing._id)
      .populate("productId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");

    res.status(200).json({
      success: true,
      data: {
        _id: updatedPricing._id,
        product: updatedPricing.productId
          ? {
              _id: updatedPricing.productId._id,
              name: updatedPricing.productId.name,
              code: updatedPricing.productId.code,
              description: updatedPricing.productId.description,
            }
          : null,
        currency: updatedPricing.currency,
        price: updatedPricing.price,
        effectiveFrom: updatedPricing.effectiveFrom,
        effectiveTo: updatedPricing.effectiveTo,
        status: updatedPricing.status,
        isActive: updatedPricing.isActive,
        createdBy: updatedPricing.createdBy
          ? {
              _id: updatedPricing.createdBy._id,
              name: `${updatedPricing.createdBy.firstName} ${updatedPricing.createdBy.lastName}`,
              email: updatedPricing.createdBy.email,
            }
          : null,
        updatedBy: updatedPricing.updatedBy
          ? {
              _id: updatedPricing.updatedBy._id,
              name: `${updatedPricing.updatedBy.firstName} ${updatedPricing.updatedBy.lastName}`,
              email: updatedPricing.updatedBy.email,
            }
          : null,
        createdAt: updatedPricing.createdAt,
        updatedAt: updatedPricing.updatedAt,
      },
      message: "Pricing updated successfully",
    });
  } catch (error) {
    console.error("Error updating pricing:", error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError("Failed to update pricing"));
  }
};

const deletePricing = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, tenantId } = req.user;

    const pricing = await Pricing.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!pricing) {
      return next(AppError.notFound("Pricing not found"));
    }

    // Soft delete
    pricing.isDeleted = true;
    pricing.isActive = false;
    pricing.status = "Inactive";
    pricing.updatedBy = userId;
    await pricing.save();

    res.status(200).json({
      success: true,
      message: "Pricing deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting pricing:", error);
    return next(AppError.internalServerError("Failed to delete pricing"));
  }
};

module.exports = {
  getAllPricing,
  getPricingByProduct,
  getCurrentPricing,
  getPricing,
  createPricing,
  updatePricing,
  deletePricing,
};
