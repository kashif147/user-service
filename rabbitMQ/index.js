// Main RabbitMQ module exports - Now using shared middleware
const {
  init,
  publisher,
  consumer,
  EVENT_TYPES: MIDDLEWARE_EVENT_TYPES,
  shutdown,
} = require("@projectShell/rabbitmq-middleware");

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
    
    // Add exchange mapping for CRM user events
    publisher.setExchangeMapping({
      "user.crm.created.v1": "user.events",
      "user.crm.updated.v1": "user.events",
    });
    
    console.log("✅ Event system initialized with middleware");
  } catch (error) {
    console.error("❌ Failed to initialize event system:", error.message);
    console.error("❌ Stack trace:", error.stack);
    // Don't throw - allow service to continue without RabbitMQ
    // This prevents service crash if RabbitMQ is unavailable
    // Service can function without RabbitMQ, just without event publishing/consuming
  }
}

// Publish domain events using middleware
async function publishDomainEvent(eventType, data, metadata = {}) {
  try {
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
      console.log("✅ Domain event published:", eventType, result.eventId);
    } else {
      console.error(
        "❌ Failed to publish domain event:",
        eventType,
        result.error
      );
    }

    return result.success;
  } catch (error) {
    console.error("❌ Error publishing domain event:", eventType, error.message);
    // Return false instead of throwing to prevent service crash
    return false;
  }
}

// Set up consumers using middleware
async function setupConsumers() {
  try {
    console.log("🔧 Setting up RabbitMQ consumers...");
    // Currently no consumers needed for user-service
    console.log("✅ All consumers set up successfully (none configured yet)");
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

