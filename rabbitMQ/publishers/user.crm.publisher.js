const { publishDomainEvent, EVENT_TYPES } = require("../index");

/**
 * Publish CRM user created event
 * @param {Object} user - User document
 */
async function publishCrmUserCreated(user) {
  if (!user || user.userType !== "CRM") {
    return;
  }

  try {
    await publishDomainEvent(
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
    console.log("✅ CRM user created event published:", user._id);
  } catch (error) {
    console.error("❌ Error publishing CRM user created event:", error.message);
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

