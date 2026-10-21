# Azure AD B2C login

`controllers/b2c.users.controller.js` (`/azure-portal`) and `controllers/azure.ad.controller.js`
(`/azure-crm`) **are** the actual login endpoints — they handle the OAuth redirect/callback and do an
atomic `findOneAndUpdate(..., {upsert:true})` on `User`, so first-login provisioning and every
subsequent login go through the exact same code path; there is no separate "sync" step.
`controllers/auth.controller.js` only covers post-login token lifecycle (`/auth/refresh`,
`/auth/revoke`, `/auth/revoke-all`) — it doesn't provision anything.

**Login tokens are returned as the signed JWT, never encrypted.** There is no token-encryption
helper: the old `helpers/tokenEncryption.js` (AES-256-GCM keyed off `JWT_SECRET`) and its only
caller, the dead draft `controllers/b2c.users.controller copy.js`, were deleted because decrypting
on the client meant shipping `JWT_SECRET`. `JWT_SECRET` is for signing/verifying JWTs only - never
derive another key from it or hand it to a client (`tests/tokenEncryption.removed.test.js`).
