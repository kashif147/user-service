/**
 * Membership check service - calls profile-service and subscription-service
 * to determine if a user (by email + tenantId) has an active profile and a
 * current subscription in Active status.
 */
const axios = require("axios");

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL || "http://localhost:3001";
const SUBSCRIPTION_SERVICE_URL =
  process.env.SUBSCRIPTION_SERVICE_URL || "http://localhost:3002";
const MEMBERSHIP_CHECK_TIMEOUT = parseInt(
  process.env.MEMBERSHIP_CHECK_TIMEOUT || "3000",
  10
);

/**
 * Check if user has active membership by email and tenantId
 * @param {string} email - User email
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<boolean>}
 */
async function hasActiveMembership(email, tenantId) {
  if (!email || !tenantId) return false;

  try {
    const profileRes = await axios.get(
      `${PROFILE_SERVICE_URL}/api/profile/internal/by-email`,
      {
        params: { email: email.trim().toLowerCase(), tenantId },
        headers: { "x-internal-request": "true" },
        timeout: MEMBERSHIP_CHECK_TIMEOUT,
        validateStatus: (s) => s >= 200 && s < 500,
      }
    );

    const profileData = profileRes.data?.data;
    if (!profileData?.profileId) return false;

    const subRes = await axios.get(
      `${SUBSCRIPTION_SERVICE_URL}/api/v1/subscriptions/profile/${profileData.profileId}/current`,
      {
        timeout: MEMBERSHIP_CHECK_TIMEOUT,
        validateStatus: (s) => s >= 200 && s < 500,
        headers: {
          "x-internal-request": "true",
          "x-tenant-id": tenantId,
        },
      }
    );

    const subData = subRes.data?.data;
    return !!(subData && subData.startDate);
  } catch (err) {
    console.warn(
      "[MEMBERSHIP_CHECK] Error checking active membership:",
      err.message,
      { email: email?.substring(0, 20) + "...", tenantId }
    );
    return false;
  }
}

module.exports = { hasActiveMembership };
