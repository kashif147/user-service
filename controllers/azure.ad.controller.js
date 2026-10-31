const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { AppError } = require("../errors/AppError");
const { takeLoginTransaction } = require("../helpers/pkceStateStore");
const { loginOrganisationDisplay } = require("../helpers/loginOrganisationDisplay");
const { EntraConfigError } = require("../helpers/entraConfig");
const { microsoftErrorFields, isMicrosoftTokenError } = require("../helpers/microsoftErrorLog");
const { resolvePlatformClaim } = require("../services/platformClaimService");

/** The only user fields the CRM sign-in callback returns (see handleAzureADCallback). */
const CRM_CALLBACK_USER_FIELDS = ["userEmail", "userFirstName", "userLastName", "userFullName", "userType"];
function crmCallbackUser(user) {
  return {
    id: user._id,
    ...Object.fromEntries(CRM_CALLBACK_USER_FIELDS.map((k) => [k, user[k] ?? null])),
  };
}

// Handle GET request from Azure redirect
module.exports.handleAzureADRedirect = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return next(AppError.badRequest("Azure AD authentication error"));
    }

    if (!code) {
      return next(AppError.badRequest("Authorization code is required"));
    }

    // Redirect back to the test page with the authorization code
    // The test page will automatically complete the authentication
    const redirectUrl = `http://localhost:3000/azure-ad-test.html?code=${encodeURIComponent(
      code
    )}&state=${encodeURIComponent(state)}`;
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error("Azure AD Redirect Error:", error);
    return next(AppError.internalServerError("Azure AD redirect failed"));
  }
};

module.exports.CRM_CALLBACK_USER_FIELDS = CRM_CALLBACK_USER_FIELDS;

module.exports.handleAzureADCallback = async (req, res, next) => {
  try {
    // Only these are read from the body. A `redirectUri` (or the Origin/Referer header) is
    // ignored: the redirect URI is the trusted one of the server-side app registration, the same
    // one the authorize request used (helpers/authAppRegistry.js).
    const { code, codeVerifier, state } = req.body;

    if (!code || !codeVerifier) {
      return next(
        AppError.badRequest("Authorization code and codeVerifier are required")
      );
    }

    // `state` must be the value returned by GET /pkce (authorizationUrls.azureAD's own
    // `state` param) so the nonce this server generated for that authorize request can be
    // recovered and checked against the ID token's `nonce` claim. Required, not optional:
    // without it there is no way to detect a replayed ID token.
    if (!state) {
      return next(AppError.badRequest("state is required"));
    }
    // The same single-use read also restores the ProjectShell tenant the login was started for
    // (GET /pkce/generate?tenant=...). A tenantId in the body/query/headers is never read here.
    const transaction = takeLoginTransaction(state);
    const expectedNonce = transaction?.nonce;
    if (!expectedNonce) {
      return next(
        AppError.badRequest("Unknown or expired state; restart the login flow")
      );
    }

    console.log("Processing Azure AD authentication...");
    const { user, verifiedIdentity, loginHint } = await AzureADHandler.handleAzureADAuth(
      code,
      codeVerifier,
      expectedNonce,
      transaction.loginContext
    );

    // Phase B / Z1: the platform claim, only for an active PlatformPrincipal bound to the verified
    // Entra identity (never from the request). Tenant claims are unaffected; off = no lookup.
    const { claim: platformClaim } = await resolvePlatformClaim({ verifiedIdentity, user });

    // Use the new JWT helper that includes roles and permissions
    const tokenData = platformClaim
      ? await jwtHelper.generateToken(user, { platformClaim })
      : await jwtHelper.generateToken(user);

    // Minimal, display-only user data. The CRM operates on the ProjectShell JWT alone: no Microsoft
    // token (ID / access / refresh) and no Microsoft identity metadata (oid, sub, audience, issuer,
    // token times / version, policy) is returned to the browser.
    const userResponse = crmCallbackUser(user);

    console.log(`Azure AD authentication successful: user ${user._id}, tenant ${user.tenantId}`);

    // Display-only { code, name } of the session's own organisation, for the CRM's remembered
    // sign-in screen (omitted when it cannot be determined safely; sign-in is unaffected).
    const organisation = await loginOrganisationDisplay(user, transaction.loginContext);

    // Returned as the signed JWT itself. It used to be AES-encrypted with a key derived from
    // JWT_SECRET, which forced the CRM to ship JWT_SECRET (REACT_APP_JWT_SECRET) in its public
    // bundle to decrypt it - that leaked the secret the gateway verifies tokens with. TLS
    // protects the token in transit. (The portal's /azure-portal in b2c.users.controller.js
    // still encrypts, until the portal client is updated.)
    return res.status(200).json({
      success: true,
      message: "Azure AD authentication successful",
      user: userResponse,
      accessToken: tokenData.token,
      ...(organisation ? { organisation } : {}),
      // Opaque Microsoft `login_hint`. The CRM appends it as `logout_hint` to the Entra logout
      // URL in the browser (never sent back to ProjectShell), so sign-out ends this account's
      // Microsoft session without showing the account picker.
      // Not a credential. Omitted when the app registration doesn't emit the claim.
      ...(loginHint ? { logoutHint: loginHint } : {}),
    });
  } catch (error) {
    // Deliberate refusals from the handler (e.g. identity not provisioned in any tenant that
    // trusts this directory) already carry their public status/message.
    if (error instanceof AppError) return next(error);
    if (error instanceof EntraConfigError) {
      console.error(error.message); // variable names only, never values
      return next(AppError.internalServerError("Microsoft sign-in is not configured"));
    }
    console.error("=== Azure AD Authentication Error ===");
    if (isMicrosoftTokenError(error)) {
      // Its message embeds Microsoft's error_description: explicit fields only.
      console.error(
        "Error: token exchange failed",
        microsoftErrorFields(error.statusCode, error.azureError),
      );
    } else {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }

    // Handle Azure AD specific errors
    if (error.response) {
      // Explicit fields only, never the raw response.
      console.error(
        "Azure AD response error:",
        microsoftErrorFields(error.response.status, error.response.data),
      );

      const azureError = error.response.data;
      if (azureError.error) {
        const errorMessage = azureError.error_description || azureError.error;
        if (azureError.error === "invalid_grant") {
          return next(
            AppError.badRequest("Invalid authorization code or code verifier")
          );
        }
        if (azureError.error === "invalid_client") {
          return next(
            AppError.internalServerError("Azure AD client configuration error")
          );
        }
        // Phase 1C-2W: Azure's error_description (AADSTS text) is never returned to the client,
        // and is not logged either (only the error codes and trace/correlation ids, above).
        return next(AppError.internalServerError("Azure AD authentication failed"));
      }
    }

    // Handle validation errors
    if (
      error.message.includes("Email not found") ||
      error.message.includes("Tenant ID not found")
    ) {
      return next(AppError.badRequest(error.message));
    }

    // ID token failed cryptographic/claim verification (bad signature, wrong issuer,
    // wrong audience, wrong tenant, nonce mismatch, expired, not-yet-valid, unsupported
    // algorithm - anything jose's jwtVerify or the explicit tid/nonce checks reject).
    // Surface as 401, not 500: this is an authentication failure, not a server error.
    const isTokenVerificationFailure =
      error.message.includes("nonce") ||
      error.message.includes("tenant mismatch") ||
      error.message.includes("missing expected nonce") ||
      error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ||
      error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
      error.code === "ERR_JWT_EXPIRED" ||
      error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
      error.code === "ERR_JWKS_NO_MATCHING_KEY";
    if (isTokenVerificationFailure) {
      console.error("Azure AD ID token verification failed:", error.code || error.message);
      return next(AppError.unauthorized("Azure AD authentication failed"));
    }

    // Never serialise the whole error: an HTTP client error carries the token request (client
    // secret, authorization code, PKCE verifier) in its config.
    console.error("Azure AD authentication error:", { name: error.name, code: error.code || null });

    // Phase 1C-2W: generic public message; the full error is logged above.
    return next(AppError.internalServerError("Azure AD authentication failed"));
  }
};
