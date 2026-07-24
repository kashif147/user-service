# Azure AD B2C login

`controllers/b2c.users.controller.js` (`/azure-portal`) and `controllers/azure.ad.controller.js`
(`/azure-crm`) **are** the actual login endpoints — they handle the OAuth redirect/callback and do an
atomic `findOneAndUpdate(..., {upsert:true})` on `User`, so first-login provisioning and every
subsequent login go through the exact same code path; there is no separate "sync" step.
`controllers/auth.controller.js` only covers post-login token lifecycle (`/auth/refresh`,
`/auth/revoke`, `/auth/revoke-all`) — it doesn't provision anything.

**`"controllers/b2c.users.controller copy.js"` (literal " copy" in the filename) is confirmed dead
code** — nothing requires it anywhere in the repo; it's an earlier draft with hardcoded
`localhost:3000` redirects. Safe to ignore or delete.
