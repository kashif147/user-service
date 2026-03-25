// Main RabbitMQ module exports - Now using shared middleware
const {
  init,
  publisher,
  consumer,
  EVENT_TYPES: MIDDLEWARE_EVENT_TYPES,
  shutdown,
} = require("@projectShell/rabbitmq-middleware");

// Track initialization state
let isInitialized = false;

// Initialize event system
async function initEventSystem() {
  try {
    const rabbitUrl = process.env.RABBITMQ_URL || process.env.RABBIT_URL;
    
    if (!rabbitUrl) {
      console.warn("⚠️  RABBITMQ_URL not set, skipping RabbitMQ initialization");
      return;
    }
    
    await init({
      url: rabbitUrl,
      logger: console,
      prefetch: 10,
      connectionName: "user-service",
      serviceName: "user-service",
    });
    
    // Add exchange mapping for CRM and Portal user events
    publisher.setExchangeMapping({
      "user.crm.created.v1": "user.events",
      "user.crm.updated.v1": "user.events",
      "user.portal.created.v1": "user.events",
      "user.portal.updated.v1": "user.events",
      "product.type.created.v1": "product.events",
      "product.type.updated.v1": "product.events",
      "product.type.deleted.v1": "product.events",
      "product.created.v1": "product.events",
      "product.updated.v1": "product.events",
      "product.deleted.v1": "product.events",
      "pricing.created.v1": "product.events",
      "pricing.updated.v1": "product.events",
      "pricing.deleted.v1": "product.events",
    });
    
    isInitialized = true;
    console.log("✅ Event system initialized with middleware");
  } catch (error) {
    console.error("❌ Failed to initialize event system:", error.message);
    console.error("❌ Stack trace:", error.stack);
    isInitialized = false;
    // Don't throw - allow service to continue without RabbitMQ
    // This prevents service crash if RabbitMQ is unavailable
    // Service can function without RabbitMQ, just without event publishing/consuming
  }
}

// Publish domain events using middleware
async function publishDomainEvent(eventType, data, metadata = {}) {
  try {
    // Check if RabbitMQ is initialized
    const rabbitUrl = process.env.RABBITMQ_URL || process.env.RABBIT_URL;
    if (!rabbitUrl) {
      console.warn("⚠️ RABBITMQ_URL not set, cannot publish event:", eventType);
      return false;
    }

    if (!isInitialized) {
      console.warn("⚠️ RabbitMQ not initialized yet, cannot publish event:", eventType);
      return false;
    }

    const result = await publisher.publish(eventType, data, {
      tenantId: metadata.tenantId,
      correlationId: metadata.correlationId || generateEventId(),
      metadata: {
        service: "user-service",
        version: "1.0",
        ...metadata,
      },
    });

    if (result.success) {
      console.log("✅ Domain event published:", {
        eventType,
        eventId: result.eventId,
        tenantId: metadata.tenantId,
      });
    } else {
      console.error(
        "❌ Failed to publish domain event:",
        {
          eventType,
          error: result.error,
          eventId: result.eventId,
          tenantId: metadata.tenantId,
        }
      );
    }

    return result.success;
  } catch (error) {
    console.error("❌ Error publishing domain event:", {
      eventType,
      error: error.message,
      stack: error.stack,
      tenantId: metadata.tenantId,
    });
    // Return false instead of throwing to prevent service crash
    return false;
  }
}

// Import application approval listener
const {
  APPLICATION_REVIEW_APPROVED,
  handleApplicationApproved,
} = require("./listeners/application.approval.listener.js");
const {
  SUBSCRIPTION_RESIGNED,
  SUBSCRIPTION_CANCEL_GRACE_ENDED,
  handlePortalMemberDemotion,
} = require("./listeners/subscription.membership.demotion.listener.js");

// Set up consumers using middleware
async function setupConsumers() {
  try {
    console.log("🔧 Setting up RabbitMQ consumers...");

    const rabbitUrl = process.env.RABBITMQ_URL || process.env.RABBIT_URL;
    if (!rabbitUrl) {
      console.log("⏭️  Skipping consumer setup - RABBITMQ_URL not set");
      return;
    }

    // Application approval events queue - upgrade Non-Member to Member when application is approved
    const APPLICATION_QUEUE = "users.application.events";
    console.log("🔧 [SETUP] Creating application events queue...");
    console.log("   Queue:", APPLICATION_QUEUE);
    console.log("   Exchange: application.events");
    console.log("   Routing Key:", APPLICATION_REVIEW_APPROVED);

    await consumer.createQueue(APPLICATION_QUEUE, {
      durable: true,
      messageTtl: 3600000, // 1 hour
    });

    await consumer.bindQueue(APPLICATION_QUEUE, "application.events", [
      APPLICATION_REVIEW_APPROVED,
    ]);

    consumer.registerHandler(APPLICATION_REVIEW_APPROVED, async (payload) => {
      await handleApplicationApproved(payload);
    });

    await consumer.consume(APPLICATION_QUEUE, { prefetch: 10 });
    console.log("✅ Application approval consumer ready:", APPLICATION_QUEUE);

    const MEMBERSHIP_DEMOTION_QUEUE = "users.membership.demotion.events";
    console.log("🔧 [SETUP] Creating membership demotion queue...");
    console.log("   Queue:", MEMBERSHIP_DEMOTION_QUEUE);
    console.log("   Exchange: membership.events");
    console.log(
      "   Routing Keys:",
      SUBSCRIPTION_RESIGNED,
      ",",
      SUBSCRIPTION_CANCEL_GRACE_ENDED
    );

    await consumer.createQueue(MEMBERSHIP_DEMOTION_QUEUE, {
      durable: true,
      messageTtl: 3600000,
    });

    await consumer.bindQueue(MEMBERSHIP_DEMOTION_QUEUE, "membership.events", [
      SUBSCRIPTION_RESIGNED,
      SUBSCRIPTION_CANCEL_GRACE_ENDED,
    ]);

    const demotionHandler = async (payload, ctx) => {
      await handlePortalMemberDemotion(payload, ctx);
    };
    consumer.registerHandler(SUBSCRIPTION_RESIGNED, demotionHandler);
    consumer.registerHandler(SUBSCRIPTION_CANCEL_GRACE_ENDED, demotionHandler);

    await consumer.consume(MEMBERSHIP_DEMOTION_QUEUE, { prefetch: 10 });
    console.log(
      "✅ Membership demotion consumer ready:",
      MEMBERSHIP_DEMOTION_QUEUE
    );

    console.log("✅ All consumers set up successfully");
  } catch (error) {
    console.error("❌ Failed to set up consumers:", error.message);
    console.error("❌ Stack trace:", error.stack);
    throw error;
  }
}

// Graceful shutdown using middleware
async function shutdownEventSystem() {
  try {
    await shutdown();
    console.log("✅ Event system shutdown complete");
  } catch (error) {
    console.error("❌ Error during event system shutdown:", error.message);
  }
}

// Utility function
function generateEventId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Export event types (merge middleware and local events)
const EVENT_TYPES = {
  ...MIDDLEWARE_EVENT_TYPES,
  USER_CRM_CREATED: "user.crm.created.v1",
  USER_CRM_UPDATED: "user.crm.updated.v1",
  USER_PORTAL_CREATED: "user.portal.created.v1",
  USER_PORTAL_UPDATED: "user.portal.updated.v1",
  PRODUCT_TYPE_CREATED: "product.type.created.v1",
  PRODUCT_TYPE_UPDATED: "product.type.updated.v1",
  PRODUCT_TYPE_DELETED: "product.type.deleted.v1",
  PRODUCT_CREATED: "product.created.v1",
  PRODUCT_UPDATED: "product.updated.v1",
  PRODUCT_DELETED: "product.deleted.v1",
  PRICING_CREATED: "pricing.created.v1",
  PRICING_UPDATED: "pricing.updated.v1",
  PRICING_DELETED: "pricing.deleted.v1",
};

module.exports = {
  // Middleware functions
  init,
  publisher,
  consumer,
  shutdown,

  // Service functions
  EVENT_TYPES,
  initEventSystem,
  publishDomainEvent,
  setupConsumers,
  shutdownEventSystem,
};

