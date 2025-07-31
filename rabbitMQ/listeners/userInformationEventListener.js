// const { subscribeToEvent } = require("message-bus/src/subscriber");
// const User = require("../models/user");
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

//   async handlePersonalDetailsCreated(eventData) {
//     try {
//       const userId = eventData.userId;
//       const personalDetails = eventData.data;

//       // Update user with personal details information
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

//       await User.findByIdAndUpdate(userId, updateData, { new: true });
//       console.log("User data synced with personal details created");
//     } catch (error) {
//       console.error("Error syncing user data with personal details created:", error);
//     }
//   }

//   async handlePersonalDetailsUpdated(eventData) {
//     try {
//       const userId = eventData.userId;
//       const personalDetails = eventData.data;

//       // Update user with personal details information
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

//       await User.findByIdAndUpdate(userId, updateData, { new: true });
//       console.log("User data synced with personal details updated");
//     } catch (error) {
//       console.error("Error syncing user data with personal details updated:", error);
//     }
//   }

//   async handleUserInformationSubmitted(eventData) {
//     try {
//       const userId = eventData.userId;
//       const userInformation = eventData.data;

//       if (userInformation.personalDetails) {
//         const personalDetails = userInformation.personalDetails;

//         // Update user with complete information
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

//         await User.findByIdAndUpdate(userId, updateData, { new: true });
//         console.log("User data synced with complete user information submitted");
//       }
//     } catch (error) {
//       console.error("Error syncing user data with user information submitted:", error);
//     }
//   }

//   async handleUserInformationUpdated(eventData) {
//     try {
//       const userId = eventData.userId;
//       const userInformation = eventData.data;

//       if (userInformation.personalDetails) {
//         const personalDetails = userInformation.personalDetails;

//         // Update user with complete information
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

//         await User.findByIdAndUpdate(userId, updateData, { new: true });
//         console.log("User data synced with complete user information updated");
//       }
//     } catch (error) {
//       console.error("Error syncing user data with user information updated:", error);
//     }
//   }
// }

// // module.exports = new UserInformationEventListener();
