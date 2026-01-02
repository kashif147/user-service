const { publishDomainEvent, EVENT_TYPES } = require("../index");

/**
 * Publish CRM user created event
 * @param {Object} user - User document
 */
async function publishCrmUserCreated(user) {
  if (!user || user.userType !== "CRM") {
    console.log("⚠️ Skipping event publish - user is null or not CRM type:", {
      userExists: !!user,
      userType: user?.userType,
    });
    return;
  }

  try {
    const result = await publishDomainEvent(
      EVENT_TYPES.USER_CRM_CREATED,
      {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        userFullName: user.userFullName,
        tenantId: user.tenantId,
      },
      {
        tenantId: user.tenantId,
      }
    );
    
    if (result) {
      console.log("✅ CRM user created event published:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    } else {
      console.error("❌ Failed to publish CRM user created event - publishDomainEvent returned false:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    }
  } catch (error) {
    console.error("❌ Error publishing CRM user created event:", {
      error: error.message,
      stack: error.stack,
      userId: user._id?.toString(),
      userEmail: user.userEmail,
      tenantId: user.tenantId,
    });
    // Re-throw to allow caller to handle if needed
    throw error;
  }
}

/**
 * Publish CRM user updated event (only when email or fullName changes)
 * @param {Object} user - User document
 * @param {Object} previousValues - Previous values of userEmail and userFullName
 */
async function publishCrmUserUpdated(user, previousValues = {}) {
  if (!user || user.userType !== "CRM") {
    return;
  }

  // Check if email or fullName changed (handles null/undefined cases)
  const emailChanged =
    previousValues.hasOwnProperty("userEmail") &&
    previousValues.userEmail !== user.userEmail;
  const fullNameChanged =
    previousValues.hasOwnProperty("userFullName") &&
    previousValues.userFullName !== user.userFullName;

  if (!emailChanged && !fullNameChanged) {
    return;
  }

  try {
    await publishDomainEvent(
      EVENT_TYPES.USER_CRM_UPDATED,
      {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        userFullName: user.userFullName,
        tenantId: user.tenantId,
      },
      {
        tenantId: user.tenantId,
      }
    );
    console.log("✅ CRM user updated event published:", user._id);
  } catch (error) {
    console.error("❌ Error publishing CRM user updated event:", error.message);
  }
}

module.exports = {
  publishCrmUserCreated,
  publishCrmUserUpdated,
};

