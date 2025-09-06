// const { publishEvent } = require("message-bus");

// function emitMicrosoftAuthEvent(data, tenantId) {
//   const eventData = {
//     ...data,
//     tenantId: tenantId,
//     timestamp: new Date().toISOString(),
//   };

//   publishEvent("user.microsoftAuthenticated", eventData, {
//     headers: {
//       'x-tenant-id': tenantId,
//       'x-event-type': 'user.microsoftAuthenticated',
//       'x-timestamp': new Date().toISOString()
//     }
//   });
// }

// function emitUserCreatedEvent(userData, tenantId) {
//   const eventData = {
//     ...userData,
//     tenantId: tenantId,
//     timestamp: new Date().toISOString(),
//   };

//   publishEvent("user.created", eventData, {
//     headers: {
//       'x-tenant-id': tenantId,
//       'x-event-type': 'user.created',
//       'x-timestamp': new Date().toISOString()
//     }
//   });
// }

// function emitUserUpdatedEvent(userData, tenantId) {
//   const eventData = {
//     ...userData,
//     tenantId: tenantId,
//     timestamp: new Date().toISOString(),
//   };

//   publishEvent("user.updated", eventData, {
//     headers: {
//       'x-tenant-id': tenantId,
//       'x-event-type': 'user.updated',
//       'x-timestamp': new Date().toISOString()
//     }
//   });
// }

// function emitUserLoginEvent(userData, tenantId) {
//   const eventData = {
//     ...userData,
//     tenantId: tenantId,
//     timestamp: new Date().toISOString(),
//   };

//   publishEvent("user.login", eventData, {
//     headers: {
//       'x-tenant-id': tenantId,
//       'x-event-type': 'user.login',
//       'x-timestamp': new Date().toISOString()
//     }
//   });
// }

// module.exports = {
//   emitMicrosoftAuthEvent,
//   emitUserCreatedEvent,
//   emitUserUpdatedEvent,
//   emitUserLoginEvent
// };
