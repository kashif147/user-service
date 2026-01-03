const { publishDomainEvent, EVENT_TYPES } = require("../index");

/**
 * Publish Portal user created event
 * @param {Object} user - User document
 */
async function publishPortalUserCreated(user) {
  if (!user || user.userType !== "PORTAL") {
    console.log("⚠️ Skipping event publish - user is null or not PORTAL type:", {
      userExists: !!user,
      userType: user?.userType,
    });
    return;
  }

  try {
    const result = await publishDomainEvent(
      EVENT_TYPES.USER_PORTAL_CREATED,
      {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        userFullName: user.userFullName,
        userFirstName: user.userFirstName,
        userLastName: user.userLastName,
        userMobilePhone: user.userMobilePhone,
        userMemberNumber: user.userMemberNumber,
        userMicrosoftId: user.userMicrosoftId,
        tenantId: user.tenantId,
      },
      {
        tenantId: user.tenantId,
      }
    );
    
    if (result) {
      console.log("✅ Portal user created event published:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    } else {
      console.error("❌ Failed to publish Portal user created event - publishDomainEvent returned false:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    }
  } catch (error) {
    console.error("❌ Error publishing Portal user created event:", {
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
 * Publish Portal user updated event (only when relevant fields change)
 * @param {Object} user - User document
 * @param {Object} previousValues - Previous values of user fields
 */
async function publishPortalUserUpdated(user, previousValues = {}) {
  if (!user || user.userType !== "PORTAL") {
    return;
  }

  // Check if relevant fields changed (handles null/undefined cases)
  const emailChanged =
    previousValues.hasOwnProperty("userEmail") &&
    previousValues.userEmail !== user.userEmail;
  const fullNameChanged =
    previousValues.hasOwnProperty("userFullName") &&
    previousValues.userFullName !== user.userFullName;
  const firstNameChanged =
    previousValues.hasOwnProperty("userFirstName") &&
    previousValues.userFirstName !== user.userFirstName;
  const lastNameChanged =
    previousValues.hasOwnProperty("userLastName") &&
    previousValues.userLastName !== user.userLastName;
  const mobilePhoneChanged =
    previousValues.hasOwnProperty("userMobilePhone") &&
    previousValues.userMobilePhone !== user.userMobilePhone;
  const memberNumberChanged =
    previousValues.hasOwnProperty("userMemberNumber") &&
    previousValues.userMemberNumber !== user.userMemberNumber;

  if (!emailChanged && !fullNameChanged && !firstNameChanged && !lastNameChanged && !mobilePhoneChanged && !memberNumberChanged) {
    return;
  }

  try {
    const result = await publishDomainEvent(
      EVENT_TYPES.USER_PORTAL_UPDATED,
      {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        userFullName: user.userFullName,
        userFirstName: user.userFirstName,
        userLastName: user.userLastName,
        userMobilePhone: user.userMobilePhone,
        userMemberNumber: user.userMemberNumber,
        tenantId: user.tenantId,
      },
      {
        tenantId: user.tenantId,
      }
    );
    
    if (result) {
      console.log("✅ Portal user updated event published:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    } else {
      console.error("❌ Failed to publish Portal user updated event - publishDomainEvent returned false:", {
        userId: user._id.toString(),
        userEmail: user.userEmail,
        tenantId: user.tenantId,
      });
    }
  } catch (error) {
    console.error("❌ Error publishing Portal user updated event:", {
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

module.exports = {
  publishPortalUserCreated,
  publishPortalUserUpdated,
};


