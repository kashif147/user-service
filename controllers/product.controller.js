const Product = require("../models/product.model");
const ProductType = require("../models/productType.model");
const Pricing = require("../models/pricing.model");
const { AppError } = require("../errors/AppError");
const {
  shouldExposeMembershipCategoryToRequest,
} = require("../helpers/membershipCategoryPortal.helper");
const {
  publishProductCreated,
  publishProductUpdated,
  publishProductDeleted,
} = require("../rabbitMQ/publishers/product.publisher");
const mongoose = require("mongoose");

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getAllProducts = async (req, res, next) => {
  try {
    const { tenantId } = req.ctx;
    const { productTypeId, code } = req.query;

    let query = {
      tenantId,
      isDeleted: false,
    };

    // Filter by product type if provided
    if (productTypeId) {
      query.productTypeId = productTypeId;
    }
    // Exact code lookup - lets callers check for an existing product before
    // creating one (codes are unique per tenant).
    if (code) {
      query.code = String(code).toUpperCase();
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

// Shared by GET /products/by-type/:productTypeId and GET /products/by-type-code/:typeCode.
const findProductsOfType = (productType, tenantId, extraFilter = {}) =>
  Product.find({
    productTypeId: productType._id,
    tenantId,
    isDeleted: false,
    ...extraFilter,
  })
    .populate("createdBy", "firstName lastName email")
    .populate("updatedBy", "firstName lastName email")
    .populate("currentPricing")
    .sort({ name: 1 });

const formatProductsOfType = (products, productType) =>
  products.map((product) => ({
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

const sendProductsOfType = (req, res, productType, products) => {
  const formattedProducts = formatProductsOfType(products, productType);

  const productsForCaller = formattedProducts.filter((product) =>
    shouldExposeMembershipCategoryToRequest(req, product.name) &&
    shouldExposeMembershipCategoryToRequest(req, product.code),
  );

  res.status(200).json({
    success: true,
    data: {
      productType: {
        _id: productType._id,
        name: productType.name,
        code: productType.code,
        description: productType.description,
      },
      products: productsForCaller,
      count: productsForCaller.length,
    },
  });
};

const getProductsByType = async (req, res, next) => {
  try {
    const { productTypeId } = req.params;
    const { tenantId } = req.ctx;

    // Phase A / A10 (B-11): a malformed id is a 400, not a CastError 500.
    if (!mongoose.Types.ObjectId.isValid(productTypeId)) {
      return next(AppError.badRequest("Invalid product type ID"));
    }

    // Verify product type exists
    const productType = await ProductType.findOne({
      _id: productTypeId,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
    }

    const products = await findProductsOfType(productType, tenantId);

    sendProductsOfType(req, res, productType, products);
  } catch (error) {
    console.error("Error fetching products by type:", error);
    return next(AppError.internalServerError("Failed to retrieve products"));
  }
};

// Phase A / A10: product types and products addressed by stable code (codes may contain spaces,
// e.g. "CODE 005").
const PRODUCT_CODE_PATTERN = /^[A-Z0-9_ -]{1,20}$/;
const normalizeProductCode = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase();

/**
 * Phase A / A10: a tenant's products of one product type, addressed by the type's stable code.
 * GET /api/products/by-type-code/:typeCode[?productCode=CODE]
 *
 * Tenant: req.ctx.tenantId only (router-level requireTenant) - product types are tenant-owned, so a
 * code that exists only in another tenant is a 404 here; there is no global or cross-tenant fallback.
 * Response: the GET /products/by-type/:id envelope; unknown type -> 404 PRODUCT_TYPE_NOT_FOUND,
 * productCode with no match -> 404 PRODUCT_NOT_FOUND.
 */
const getProductsByTypeCode = async (req, res, next) => {
  try {
    const { tenantId } = req.ctx;
    const typeCode = normalizeProductCode(req.params.typeCode);
    const hasProductCode = req.query.productCode !== undefined;
    const productCode = normalizeProductCode(req.query.productCode);

    if (!PRODUCT_CODE_PATTERN.test(typeCode)) {
      return next(
        new AppError("Invalid product type code", 400, "INVALID_PRODUCT_TYPE_CODE")
      );
    }
    if (hasProductCode && !PRODUCT_CODE_PATTERN.test(productCode)) {
      return next(
        new AppError("Invalid product code", 400, "INVALID_PRODUCT_CODE")
      );
    }

    const productType = await ProductType.findOne({
      code: typeCode,
      tenantId,
      isDeleted: false,
    });

    if (!productType) {
      return next(
        new AppError("Product type not found", 404, "PRODUCT_TYPE_NOT_FOUND")
      );
    }

    const products = await findProductsOfType(
      productType,
      tenantId,
      hasProductCode ? { code: productCode } : {}
    );

    if (hasProductCode && products.length === 0) {
      return next(new AppError("Product not found", 404, "PRODUCT_NOT_FOUND"));
    }

    sendProductsOfType(req, res, productType, products);
  } catch (error) {
    console.error("Error fetching products by type code:", error);
    return next(AppError.internalServerError("Failed to retrieve products"));
  }
};

const getProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { tenantId } = req.ctx;
    const decodedId = decodeURIComponent(String(id || "")).trim();
    const escaped = escapeRegex(decodedId);
    const productLookup = mongoose.Types.ObjectId.isValid(decodedId)
      ? { _id: decodedId }
      : {
          $or: [
            { name: { $regex: new RegExp(`^${escaped}$`, "i") } },
            { code: { $regex: new RegExp(`^${escaped}$`, "i") } },
          ],
        };

    const product = await Product.findOne({
      ...productLookup,
      tenantId,
      isDeleted: false,
    })
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .populate("pricingHistory");

    if (!product) {
      return res.status(200).json({
        data: null,
        message: "Not found"
      });
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
    const { name, code, description, productTypeId, status, incomeAccountCode } = req.body;
    const { userId, tenantId } = req.ctx;

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
      incomeAccountCode: incomeAccountCode || null,
      createdBy: userId,
      tenantId,
    });

    const populatedProduct = await Product.findById(product._id)
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email");

    await publishProductCreated(populatedProduct);

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
    const { name, code, description, productTypeId, status, incomeAccountCode } = req.body;
    const { userId, tenantId } = req.ctx;

    const product = await Product.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return res.notFoundRecord("Product not found");
    }

    // Check if new code already exists for this tenant (excluding current record)
    if (code) {
      const existingProduct = await Product.findOne({
        code: code.toUpperCase(),
        tenantId,
        isDeleted: false,
        _id: { $ne: product._id },
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
    if (incomeAccountCode !== undefined) product.incomeAccountCode = incomeAccountCode;
    product.updatedBy = userId;

    await product.save();

    const updatedProduct = await Product.findById(product._id)
      .populate("productTypeId", "name code description")
      .populate("createdBy", "firstName lastName email")
      .populate("updatedBy", "firstName lastName email")
      .populate("currentPricing")
      .populate("pricingHistory");

    await publishProductUpdated(updatedProduct);

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
    const { userId, tenantId } = req.ctx;

    const product = await Product.findOne({
      _id: id,
      tenantId,
      isDeleted: false,
    });

    if (!product) {
      return res.notFoundRecord("Product not found");
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

    await publishProductDeleted(product);

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
  getProductsByTypeCode,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
};
