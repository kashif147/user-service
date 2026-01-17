const { publishDomainEvent, EVENT_TYPES } = require("../index");

function buildProductTypePayload(productType) {
  return {
    productTypeId: productType._id.toString(),
    name: productType.name,
    code: productType.code,
    description: productType.description,
    status: productType.status,
    isActive: productType.isActive,
    isDeleted: productType.isDeleted,
    tenantId: productType.tenantId,
    createdBy: productType.createdBy?.toString?.() || productType.createdBy,
    updatedBy: productType.updatedBy?.toString?.() || productType.updatedBy,
    createdAt: productType.createdAt,
    updatedAt: productType.updatedAt,
  };
}

function buildProductPayload(product) {
  return {
    productId: product._id.toString(),
    name: product.name,
    code: product.code,
    description: product.description,
    productTypeId: product.productTypeId?.toString?.() || product.productTypeId,
    status: product.status,
    isActive: product.isActive,
    isDeleted: product.isDeleted,
    tenantId: product.tenantId,
    createdBy: product.createdBy?.toString?.() || product.createdBy,
    updatedBy: product.updatedBy?.toString?.() || product.updatedBy,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function buildPricingPayload(pricing) {
  return {
    pricingId: pricing._id.toString(),
    productId: pricing.productId?.toString?.() || pricing.productId,
    currency: pricing.currency,
    price: pricing.price,
    memberPrice: pricing.memberPrice,
    nonMemberPrice: pricing.nonMemberPrice,
    effectiveFrom: pricing.effectiveFrom,
    effectiveTo: pricing.effectiveTo,
    status: pricing.status,
    isActive: pricing.isActive,
    isDeleted: pricing.isDeleted,
    tenantId: pricing.tenantId,
    createdBy: pricing.createdBy?.toString?.() || pricing.createdBy,
    updatedBy: pricing.updatedBy?.toString?.() || pricing.updatedBy,
    createdAt: pricing.createdAt,
    updatedAt: pricing.updatedAt,
  };
}

async function publishProductTypeCreated(productType) {
  const payload = buildProductTypePayload(productType);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_TYPE_CREATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product type created event");
  }
}

async function publishProductTypeUpdated(productType) {
  const payload = buildProductTypePayload(productType);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_TYPE_UPDATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product type updated event");
  }
}

async function publishProductTypeDeleted(productType) {
  const payload = buildProductTypePayload(productType);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_TYPE_DELETED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product type deleted event");
  }
}

async function publishProductCreated(product) {
  const payload = buildProductPayload(product);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_CREATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product created event");
  }
}

async function publishProductUpdated(product) {
  const payload = buildProductPayload(product);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_UPDATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product updated event");
  }
}

async function publishProductDeleted(product) {
  const payload = buildProductPayload(product);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRODUCT_DELETED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish product deleted event");
  }
}

async function publishPricingCreated(pricing) {
  const payload = buildPricingPayload(pricing);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRICING_CREATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish pricing created event");
  }
}

async function publishPricingUpdated(pricing) {
  const payload = buildPricingPayload(pricing);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRICING_UPDATED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish pricing updated event");
  }
}

async function publishPricingDeleted(pricing) {
  const payload = buildPricingPayload(pricing);
  const result = await publishDomainEvent(
    EVENT_TYPES.PRICING_DELETED,
    payload,
    { tenantId: payload.tenantId }
  );

  if (!result) {
    throw new Error("Failed to publish pricing deleted event");
  }
}

module.exports = {
  publishProductTypeCreated,
  publishProductTypeUpdated,
  publishProductTypeDeleted,
  publishProductCreated,
  publishProductUpdated,
  publishProductDeleted,
  publishPricingCreated,
  publishPricingUpdated,
  publishPricingDeleted,
};
