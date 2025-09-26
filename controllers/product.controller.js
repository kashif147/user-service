const Product = require("../models/product.model");
const ProductType = require("../models/productType.model");
const Pricing = require("../models/pricing.model");
const { AppError } = require("../errors/AppError");

const getAllProducts = async (req, res, next) => {
  try {
    const { tenantId } = req.user;
    const { productTypeId } = req.query;

    let query = {
      tenantId,
      isDeleted: false,
    };

    // Filter by product type if provided
    if (productTypeId) {
      query.productTypeId = productTypeId;
    }

    const products = await Product.find(query)
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .sort({ createdAt: -1 });

    const formattedProducts = products.map((product) => ({
      _id: product._id,
      name: product.name,
      code: product.code,
      description: product.description,
      productType: product.productTypeId
        ? {
            _id: product.productTypeId._id,
            name: product.productTypeId.name,
            code: product.productTypeId.code,
            description: product.productTypeId.description,
          }
        : null,
      status: product.status,
      isActive: product.isActive,
      currentPricing: product.currentPricing
        ? {
            _id: product.currentPricing._id,
            currency: product.currentPricing.currency,
            price: product.currentPricing.price,
            effectiveFrom: product.currentPricing.effectiveFrom,
            effectiveTo: product.currentPricing.effectiveTo,
          }
        : null,
      createdBy: product.createdBy
        ? {
            _id: product.createdBy._id,
            name: `${product.createdBy.firstName} ${product.createdBy.lastName}`,
            email: product.createdBy.email,
          }
        : null,
      updatedBy: product.updatedBy
        ? {
            _id: product.updatedBy._id,
            name: `${product.updatedBy.firstName} ${product.updatedBy.lastName}`,
            email: product.updatedBy.email,
          }
        : null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    }));

    res.status(200).json({
      success: true,
      data: formattedProducts,
      count: formattedProducts.length,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return next(AppError.internalServerError("Failed to retrieve products"));
  }
};

const getProductsByType = async (req, res, next) => {
  try {
    const { productTypeId } = req.params;
    const { tenantId } = req.user;

    // Verify product type exists
    const productType = await ProductType.findOne({
      _id: productTypeId,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return next(AppError.notFound("Product type not found"));
    }

    const products = await Product.find({
      productTypeId,
      tenantId,
      isDeleted: false,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .sort({ createdAt: -1 });

    const formattedProducts = products.map((product) => ({
      _id: product._id,
      name: product.name,
      code: product.code,
      description: product.description,
      productType: {
        _id: productType._id,
        name: productType.name,
        code: productType.code,
        description: productType.description,
      },
      status: product.status,
      isActive: product.isActive,
      currentPricing: product.currentPricing
        ? {
            _id: product.currentPricing._id,
            currency: product.currentPricing.currency,
            price: product.currentPricing.price,
            effectiveFrom: product.currentPricing.effectiveFrom,
            effectiveTo: product.currentPricing.effectiveTo,
          }
        : null,
      createdBy: product.createdBy
        ? {
            _id: product.createdBy._id,
            name: `${product.createdBy.firstName} ${product.createdBy.lastName}`,
            email: product.createdBy.email,
          }
        : null,
      updatedBy: product.updatedBy
        ? {
            _id: product.updatedBy._id,
            name: `${product.updatedBy.firstName} ${product.updatedBy.lastName}`,
            email: product.updatedBy.email,
          }
        : null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    }));

    res.status(200).json({
      success: true,
      data: {
        productType: {
          _id: productType._id,
          name: productType.name,
          code: productType.code,
          description: productType.description,
        },
        products: formattedProducts,
        count: formattedProducts.length,
      },
    });
  } catch (error) {
    console.error("Error fetching products by type:", error);
    return next(AppError.internalServerError("Failed to retrieve products"));
  }
};

const getProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { tenantId } = req.user;

    const product = await Product.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    })
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .populate("pricingHistory");

    if (!product) {
      return next(AppError.notFound("Product not found"));
    }

    const formattedProduct = {
      _id: product._id,
      name: product.name,
      code: product.code,
      description: product.description,
      productType: product.productTypeId
        ? {
            _id: product.productTypeId._id,
            name: product.productTypeId.name,
            code: product.productTypeId.code,
            description: product.productTypeId.description,
          }
        : null,
      status: product.status,
      isActive: product.isActive,
      currentPricing: product.currentPricing
        ? {
            _id: product.currentPricing._id,
            currency: product.currentPricing.currency,
            price: product.currentPricing.price,
            effectiveFrom: product.currentPricing.effectiveFrom,
            effectiveTo: product.currentPricing.effectiveTo,
          }
        : null,
      pricingHistory: product.pricingHistory
        ? product.pricingHistory.map((pricing) => ({
            _id: pricing._id,
            currency: pricing.currency,
            price: pricing.price,
            effectiveFrom: pricing.effectiveFrom,
            effectiveTo: pricing.effectiveTo,
            status: pricing.status,
            isActive: pricing.isActive,
            createdAt: pricing.createdAt,
          }))
        : [],
      createdBy: product.createdBy
        ? {
            _id: product.createdBy._id,
            name: `${product.createdBy.firstName} ${product.createdBy.lastName}`,
            email: product.createdBy.email,
          }
        : null,
      updatedBy: product.updatedBy
        ? {
            _id: product.updatedBy._id,
            name: `${product.updatedBy.firstName} ${product.updatedBy.lastName}`,
            email: product.updatedBy.email,
          }
        : null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };

    res.status(200).json({
      success: true,
      data: formattedProduct,
    });
  } catch (error) {
    console.error("Error fetching product:", error);
    return next(AppError.internalServerError("Failed to retrieve product"));
  }
};

const createProduct = async (req, res, next) => {
  try {
    const { name, code, description, productTypeId, status } = req.body;
    const { userId, tenantId } = req.user;

    if (!name || !code || !productTypeId) {
      return next(
        AppError.badRequest("Name, code, and product type are required")
      );
    }

    // Verify product type exists
    const productType = await ProductType.findOne({
      _id: productTypeId,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return next(AppError.badRequest("Invalid product type"));
    }

    // Check if code already exists for this tenant
    const existingProduct = await Product.findOne({
      code: code.toUpperCase(),
      tenantId,
      isDeleted: false,
    });

    if (existingProduct) {
      return next(AppError.badRequest("Product code already exists"));
    }

    const product = await Product.create({
      name,
      code: code.toUpperCase(),
      description,
      productTypeId,
      status: status || "Active",
      isActive: status === "Active",
      createdBy: userId,
      tenantId,
    });

    const populatedProduct = await Product.findById(product._id)
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email");

    res.status(201).json({
      success: true,
      data: {
        _id: populatedProduct._id,
        name: populatedProduct.name,
        code: populatedProduct.code,
        description: populatedProduct.description,
        productType: {
          _id: populatedProduct.productTypeId._id,
          name: populatedProduct.productTypeId.name,
          code: populatedProduct.productTypeId.code,
          description: populatedProduct.productTypeId.description,
        },
        status: populatedProduct.status,
        isActive: populatedProduct.isActive,
        currentPricing: null,
        pricingHistory: [],
        createdBy: {
          _id: populatedProduct.createdBy._id,
          name: `${populatedProduct.createdBy.firstName} ${populatedProduct.createdBy.lastName}`,
          email: populatedProduct.createdBy.email,
        },
        createdAt: populatedProduct.createdAt,
        updatedAt: populatedProduct.updatedAt,
      },
      message: "Product created successfully",
    });
  } catch (error) {
    console.error("Error creating product:", error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Product code must be unique"));
    }
    return next(AppError.internalServerError("Failed to create product"));
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, code, description, productTypeId, status } = req.body;
    const { userId, tenantId } = req.user;

    const product = await Product.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return next(AppError.notFound("Product not found"));
    }

    // Check if new code already exists for this tenant (excluding current record)
    if (code && code.toUpperCase() !== product.code) {
      const existingProduct = await Product.findOne({
        code: code.toUpperCase(),
        tenantId,
        isDeleted: false,
        _id: { $ne: id },
      });

      if (existingProduct) {
        return next(AppError.badRequest("Product code already exists"));
      }
    }

    // Verify product type exists if provided
    if (productTypeId && productTypeId !== product.productTypeId.toString()) {
      const productType = await ProductType.findOne({
        _id: productTypeId,
        tenantId,
        isDeleted: false,
      });

      if (!productType) {
        return next(AppError.badRequest("Invalid product type"));
      }
    }

    // Update fields
    if (name) product.name = name;
    if (code) product.code = code.toUpperCase();
    if (description !== undefined) product.description = description;
    if (productTypeId) product.productTypeId = productTypeId;
    if (status) {
      product.status = status;
      product.isActive = status === "Active";
    }
    product.updatedBy = userId;

    await product.save();

    const updatedProduct = await Product.findById(product._id)
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .populate("pricingHistory");

    res.status(200).json({
      success: true,
      data: {
        _id: updatedProduct._id,
        name: updatedProduct.name,
        code: updatedProduct.code,
        description: updatedProduct.description,
        productType: updatedProduct.productTypeId
          ? {
              _id: updatedProduct.productTypeId._id,
              name: updatedProduct.productTypeId.name,
              code: updatedProduct.productTypeId.code,
              description: updatedProduct.productTypeId.description,
            }
          : null,
        status: updatedProduct.status,
        isActive: updatedProduct.isActive,
        currentPricing: updatedProduct.currentPricing
          ? {
              _id: updatedProduct.currentPricing._id,
              currency: updatedProduct.currentPricing.currency,
              price: updatedProduct.currentPricing.price,
              effectiveFrom: updatedProduct.currentPricing.effectiveFrom,
              effectiveTo: updatedProduct.currentPricing.effectiveTo,
            }
          : null,
        pricingHistory: updatedProduct.pricingHistory
          ? updatedProduct.pricingHistory.map((pricing) => ({
              _id: pricing._id,
              currency: pricing.currency,
              price: pricing.price,
              effectiveFrom: pricing.effectiveFrom,
              effectiveTo: pricing.effectiveTo,
              status: pricing.status,
              isActive: pricing.isActive,
              createdAt: pricing.createdAt,
            }))
          : [],
        createdBy: updatedProduct.createdBy
          ? {
              _id: updatedProduct.createdBy._id,
              name: `${updatedProduct.createdBy.firstName} ${updatedProduct.createdBy.lastName}`,
              email: updatedProduct.createdBy.email,
            }
          : null,
        updatedBy: updatedProduct.updatedBy
          ? {
              _id: updatedProduct.updatedBy._id,
              name: `${updatedProduct.updatedBy.firstName} ${updatedProduct.updatedBy.lastName}`,
              email: updatedProduct.updatedBy.email,
            }
          : null,
        createdAt: updatedProduct.createdAt,
        updatedAt: updatedProduct.updatedAt,
      },
      message: "Product updated successfully",
    });
  } catch (error) {
    console.error("Error updating product:", error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.code === 11000) {
      return next(AppError.badRequest("Product code must be unique"));
    }
    return next(AppError.internalServerError("Failed to update product"));
  }
};

const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, tenantId } = req.user;

    const product = await Product.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return next(AppError.notFound("Product not found"));
    }

    // Check if there are any active pricing records
    const activePricingCount = await Pricing.countDocuments({
      productId: id,
      isDeleted: false,
    });

    if (activePricingCount > 0) {
      return next(
        AppError.badRequest(
          `Cannot delete product. ${activePricingCount} pricing record(s) are associated with it.`
        )
      );
    }

    // Soft delete
    product.isDeleted = true;
    product.isActive = false;
    product.status = "Inactive";
    product.updatedBy = userId;
    await product.save();

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    return next(AppError.internalServerError("Failed to delete product"));
  }
};

module.exports = {
  getAllProducts,
  getProductsByType,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
};
