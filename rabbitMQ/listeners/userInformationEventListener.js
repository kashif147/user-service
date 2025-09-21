// const { subscribeToEvent } = require("message-bus/src/subscriber");
// const User = require("../models/user.model");
// const { USER_INFORMATION_EVENTS } = require("message-bus/src/events/userInformationEvents");

// class UserInformationEventListener {
//   constructor() {
//     this.setupEventListeners();
//   }

//   setupEventListeners() {
//     // Listen to personal details events to sync user data
//     subscribeToEvent(USER_INFORMATION_EVENTS.PERSONAL_DETAILS_CREATED, this.handlePersonalDetailsCreated.bind(this));
//     subscribeToEvent(USER_INFORMATION_EVENTS.PERSONAL_DETAILS_UPDATED, this.handlePersonalDetailsUpdated.bind(this));

//     // Listen to complete user information events
//     subscribeToEvent(USER_INFORMATION_EVENTS.USER_INFORMATION_SUBMITTED, this.handleUserInformationSubmitted.bind(this));
//     subscribeToEvent(USER_INFORMATION_EVENTS.USER_INFORMATION_UPDATED, this.handleUserInformationUpdated.bind(this));
//   }

//   // Helper function to verify tenantId in event data
//   verifyTenantId(eventData, headers) {
//     const tenantId = eventData.tenantId || headers['x-tenant-id'];
//     if (!tenantId) {
//       throw new Error('TenantId is required for all events');
//     }
//     return tenantId;
//   }

//   async handlePersonalDetailsCreated(eventData, headers) {
//     try {
//       const tenantId = this.verifyTenantId(eventData, headers);
//       const userId = eventData.userId;
//       const personalDetails = eventData.data;

//       // Update user with personal details information - include tenantId for isolation
//       const updateData = {
//         userFullName: `${personalDetails.personalInfo?.forename || ""} ${personalDetails.personalInfo?.surname || ""}`.trim(),
//         userMobilePhone: personalDetails.contactInfo?.mobile || null,
//         userLastLogin: new Date(),
//       };

//       // Add email if available
//       if (personalDetails.contactInfo?.emailWork) {
//         updateData.userEmail = personalDetails.contactInfo.emailWork;
//       } else if (personalDetails.contactInfo?.emailPersonal) {
//         updateData.userEmail = personalDetails.contactInfo.emailPersonal;
//       }

//       await User.findOneAndUpdate({ _id: userId, tenantId }, updateData, { new: true });
//       console.log(`User data synced with personal details created for tenant ${tenantId}`);
//     } catch (error) {
//       console.error("Error syncing user data with personal details created:", error);
//     }
//   }

//   async handlePersonalDetailsUpdated(eventData, headers) {
//     try {
//       const tenantId = this.verifyTenantId(eventData, headers);
//       const userId = eventData.userId;
//       const personalDetails = eventData.data;

//       // Update user with personal details information - include tenantId for isolation
//       const updateData = {
//         userFullName: `${personalDetails.personalInfo?.forename || ""} ${personalDetails.personalInfo?.surname || ""}`.trim(),
//         userMobilePhone: personalDetails.contactInfo?.mobile || null,
//         userLastLogin: new Date(),
//       };

//       // Add email if available
//       if (personalDetails.contactInfo?.emailWork) {
//         updateData.userEmail = personalDetails.contactInfo.emailWork;
//       } else if (personalDetails.contactInfo?.emailPersonal) {
//         updateData.userEmail = personalDetails.contactInfo.emailPersonal;
//       }

//       await User.findOneAndUpdate({ _id: userId, tenantId }, updateData, { new: true });
//       console.log(`User data synced with personal details updated for tenant ${tenantId}`);
//     } catch (error) {
//       console.error("Error syncing user data with personal details updated:", error);
//     }
//   }

//   async handleUserInformationSubmitted(eventData, headers) {
//     try {
//       const tenantId = this.verifyTenantId(eventData, headers);
//       const userId = eventData.userId;
//       const userInformation = eventData.data;

//       if (userInformation.personalDetails) {
//         const personalDetails = userInformation.personalDetails;

//         // Update user with complete information - include tenantId for isolation
//         const updateData = {
//           userFullName: `${personalDetails.personalInfo?.forename || ""} ${personalDetails.personalInfo?.surname || ""}`.trim(),
//           userMobilePhone: personalDetails.contactInfo?.mobile || null,
//           userLastLogin: new Date(),
//         };

//         // Add email if available
//         if (personalDetails.contactInfo?.emailWork) {
//           updateData.userEmail = personalDetails.contactInfo.emailWork;
//         } else if (personalDetails.contactInfo?.emailPersonal) {
//           updateData.userEmail = personalDetails.contactInfo.emailPersonal;
//         }

//         // Add member number if available from subscription
//         if (userInformation.subscriptionDetails?.membershipNo) {
//           updateData.userMemberNumber = userInformation.subscriptionDetails.membershipNo;
//         }

//         await User.findOneAndUpdate({ _id: userId, tenantId }, updateData, { new: true });
//         console.log(`User data synced with complete user information submitted for tenant ${tenantId}`);
//       }
//     } catch (error) {
//       console.error("Error syncing user data with user information submitted:", error);
//     }
//   }

//   async handleUserInformationUpdated(eventData, headers) {
//     try {
//       const tenantId = this.verifyTenantId(eventData, headers);
//       const userId = eventData.userId;
//       const userInformation = eventData.data;

//       if (userInformation.personalDetails) {
//         const personalDetails = userInformation.personalDetails;

//         // Update user with complete information - include tenantId for isolation
//         const updateData = {
//           userFullName: `${personalDetails.personalInfo?.forename || ""} ${personalDetails.personalInfo?.surname || ""}`.trim(),
//           userMobilePhone: personalDetails.contactInfo?.mobile || null,
//           userLastLogin: new Date(),
//         };

//         // Add email if available
//         if (personalDetails.contactInfo?.emailWork) {
//           updateData.userEmail = personalDetails.contactInfo.emailWork;
//         } else if (personalDetails.contactInfo?.emailPersonal) {
//           updateData.userEmail = personalDetails.contactInfo.emailPersonal;
//         }

//         // Add member number if available from subscription
//         if (userInformation.subscriptionDetails?.membershipNo) {
//           updateData.userMemberNumber = userInformation.subscriptionDetails.membershipNo;
//         }

//         await User.findOneAndUpdate({ _id: userId, tenantId }, updateData, { new: true });
//         console.log(`User data synced with complete user information updated for tenant ${tenantId}`);
//       }
//     } catch (error) {
//       console.error("Error syncing user data with user information updated:", error);
//     }
//   }
// }

// // module.exports = new UserInformationEventListener();
