const ProductType = require("../models/productType.model");
const Product = require("../models/product.model");
const Pricing = require("../models/pricing.model");
const { AppError } = require("../errors/AppError");

const getAllProductTypes = async (req, res, next) => {
  try {
    const { tenantId } = req.user;

    const productTypes = await ProductType.find({
      tenantId,
      isDeleted: false,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    const formattedProductTypes = await Promise.all(
      productTypes.map(async (productType) => {
        const productsCount = await Product.countDocuments({
          productTypeId: productType._id,
          isDeleted: false,
        });

        return {
          _id: productType._id,
          name: productType.name,
          code: productType.code,
          description: productType.description,
          status: productType.status,
          isActive: productType.isActive,
          productsCount: productsCount,
          createdBy: productType.createdBy
            ? {
                _id: productType.createdBy._id,
                name: `${productType.createdBy.firstName} ${productType.createdBy.lastName}`,
                email: productType.createdBy.email,
              }
            : null,
          updatedBy: productType.updatedBy
            ? {
                _id: productType.updatedBy._id,
                name: `${productType.updatedBy.firstName} ${productType.updatedBy.lastName}`,
                email: productType.updatedBy.email,
              }
            : null,
          createdAt: productType.createdAt,
          updatedAt: productType.updatedAt,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: formattedProductTypes,
      count: formattedProductTypes.length,
    });
  } catch (error) {
    console.error("Error fetching product types:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    return next(
      AppError.internalServerError("Failed to retrieve product types")
    );
  }
};

const getProductType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { tenantId } = req.user;

    const productType = await ProductType.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");

    if (!productType) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    const productsCount = await Product.countDocuments({
      productTypeId: productType._id,
      isDeleted: false,
    });

    const formattedProductType = {
      _id: productType._id,
      name: productType.name,
      code: productType.code,
      description: productType.description,
      status: productType.status,
      isActive: productType.isActive,
      productsCount: productsCount,
      createdBy: productType.createdBy
        ? {
            _id: productType.createdBy._id,
            name: `${productType.createdBy.firstName} ${productType.createdBy.lastName}`,
            email: productType.createdBy.email,
          }
        : null,
      updatedBy: productType.updatedBy
        ? {
            _id: productType.updatedBy._id,
            name: `${productType.updatedBy.firstName} ${productType.updatedBy.lastName}`,
            email: productType.updatedBy.email,
          }
        : null,
      createdAt: productType.createdAt,
      updatedAt: productType.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: formattedProductType,
    });
  } catch (error) {
    console.error("Error fetching product type:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    return next(
      AppError.internalServerError("Failed to retrieve product type")
    );
  }
};

const createProductType = async (req, res, next) => {
  try {
    const { name, code, description, status } = req.body;
    const { userId, tenantId } = req.ctx;

    console.log(
      "ProductType creation - userId:",
      userId,
      "tenantId:",
      tenantId
    );
    console.log(
      "ProductType creation - req.ctx:",
      JSON.stringify(req.ctx, null, 2)
    );

    if (!name || !code) {
      return next(AppError.badRequest("Name and code are required"));
    }

    if (!userId) {
      return next(AppError.badRequest("User ID is required"));
    }

    // Check if code already exists for this tenant
    const existingProductType = await ProductType.findOne({
      code: code.toUpperCase(),
      tenantId,
      isDeleted: false,
    });

    if (existingProductType) {
      return next(AppError.badRequest("Product type code already exists"));
    }

    const productType = await ProductType.create({
      name,
      code: code.toUpperCase(),
      description,
      status: status || "Active",
      isActive: status === "Active",
      createdBy: userId,
      tenantId: tenantId,
    });

    const populatedProductType = await ProductType.findById(
      productType._id
    ).populate("createdBy", "firstName lastName email");

    res.status(201).json({
      success: true,
      data: {
        _id: populatedProductType._id,
        name: populatedProductType.name,
        code: populatedProductType.code,
        description: populatedProductType.description,
        status: populatedProductType.status,
        isActive: populatedProductType.isActive,
        productsCount: 0,
        createdBy: {
          _id: populatedProductType.createdBy._id,
          name: `${populatedProductType.createdBy.firstName} ${populatedProductType.createdBy.lastName}`,
          email: populatedProductType.createdBy.email,
        },
        createdAt: populatedProductType.createdAt,
        updatedAt: populatedProductType.updatedAt,
      },
      message: "Product type created successfully",
    });
  } catch (error) {
    console.error("Error creating product type:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Product type code must be unique"));
    }
    return next(AppError.internalServerError("Failed to create product type"));
  }
};

const updateProductType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, code, description, status } = req.body;
    const { userId, tenantId } = req.ctx;

    const productType = await ProductType.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return next(AppError.notFound("Product type not found"));
    }

    // Check if new code already exists for this tenant (excluding current record)
    if (code) {
      console.log("Checking for duplicate code:", {
        newCode: code.toUpperCase(),
        currentCode: productType.code,
        tenantId,
        currentId: id,
        productTypeId: productType._id,
      });

      const existingProductType = await ProductType.findOne({
        code: code.toUpperCase(),
        tenantId,
        isDeleted: false,
        _id: { $ne: productType._id },
      });

      console.log("Duplicate check result:", existingProductType);

      if (existingProductType) {
        return next(AppError.badRequest("Product type code already exists"));
      }
    }

    // Update fields
    if (name) productType.name = name;
    if (code) productType.code = code.toUpperCase();
    if (description !== undefined) productType.description = description;
    if (status) {
      productType.status = status;
      productType.isActive = status === "Active";
    }
    productType.updatedBy = userId;

    await productType.save();

    const updatedProductType = await ProductType.findById(productType._id)
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email");

    const productsCount = await Product.countDocuments({
      productTypeId: updatedProductType._id,
      isDeleted: false,
    });

    res.status(200).json({
      success: true,
      data: {
        _id: updatedProductType._id,
        name: updatedProductType.name,
        code: updatedProductType.code,
        description: updatedProductType.description,
        status: updatedProductType.status,
        isActive: updatedProductType.isActive,
        productsCount: productsCount,
        createdBy: updatedProductType.createdBy
          ? {
              _id: updatedProductType.createdBy._id,
              name: `${updatedProductType.createdBy.firstName} ${updatedProductType.createdBy.lastName}`,
              email: updatedProductType.createdBy.email,
            }
          : null,
        updatedBy: updatedProductType.updatedBy
          ? {
              _id: updatedProductType.updatedBy._id,
              name: `${updatedProductType.updatedBy.firstName} ${updatedProductType.updatedBy.lastName}`,
              email: updatedProductType.updatedBy.email,
            }
          : null,
        createdAt: updatedProductType.createdAt,
        updatedAt: updatedProductType.updatedAt,
      },
      message: "Product type updated successfully",
    });
  } catch (error) {
    console.error("Error updating product type:", error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Product type code must be unique"));
    }
    return next(AppError.internalServerError("Failed to update product type"));
  }
};

const deleteProductType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, tenantId } = req.ctx;

    const productType = await ProductType.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return next(AppError.notFound("Product type not found"));
    }

    // Check if there are any products associated with this product type
    const productsCount = await Product.countDocuments({
      productTypeId: id,
      isDeleted: false,
    });

    if (productsCount > 0) {
      return next(
        AppError.badRequest(
          `Cannot delete product type. ${productsCount} product(s) are associated with it.`
        )
      );
    }

    // Soft delete
    productType.isDeleted = true;
    productType.isActive = false;
    productType.status = "Inactive";
    productType.updatedBy = userId;
    await productType.save();

    res.status(200).json({
      success: true,
      message: "Product type deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting product type:", error);
    return next(AppError.internalServerError("Failed to delete product type"));
  }
};

const getAllProductTypesWithProducts = async (req, res, next) => {
  try {
    if (!req.user || !req.user.tenantId) {
      return next(AppError.unauthorized("User authentication required"));
    }

    const { tenantId } = req.user;

    const productTypes = await ProductType.find({
      tenantId,
      isDeleted: false,
    }).sort({ createdAt: -1 });

    const result = await Promise.all(
      productTypes.map(async (productType) => {
        const products = await Product.find({
          productTypeId: productType._id,
          tenantId,
          isDeleted: false,
        }).sort({ createdAt: -1 });

        const productsWithPricing = await Promise.all(
          products.map(async (product) => {
            const currentDate = new Date();
            const currentPricing = await Pricing.findOne({
              productId: product._id,
              tenantId,
              isActive: true,
              isDeleted: false,
              effectiveFrom: { $lte: currentDate },
              $or: [
                { effectiveTo: { $gte: currentDate } },
                { effectiveTo: null },
              ],
            })
              .select(
                "price memberPrice nonMemberPrice currency effectiveFrom effectiveTo productType status"
              )
              .sort({ effectiveFrom: -1 });

            return {
              _id: product._id,
              name: product.name,
              code: product.code,
              description: product.description,
              status: product.status,
              isActive: product.isActive,
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
              currentPricing: currentPricing,
            };
          })
        );

        return {
          _id: productType._id,
          name: productType.name,
          code: productType.code,
          description: productType.description,
          status: productType.status,
          isActive: productType.isActive,
          createdAt: productType.createdAt,
          updatedAt: productType.updatedAt,
          products: productsWithPricing,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: result,
      count: result.length,
    });
  } catch (error) {
    console.error("Error fetching product types with products:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    return next(
      AppError.internalServerError(
        "Failed to retrieve product types with products and pricing"
      )
    );
  }
};

module.exports = {
  getAllProductTypes,
  getProductType,
  createProductType,
  updateProductType,
  deleteProductType,
  getAllProductTypesWithProducts,
};
