/**
 * Maps Microsoft OAuth token response fields into User.tokens.
 * `refresh_token_expires_in` is remaining lifetime in seconds (not a Unix timestamp).
 * @see https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow#successful-response-1
 */
function buildUserTokensSubdocument(tokens) {
  if (!tokens) {
    return {
      id_token: null,
      refresh_token: null,
      id_token_expires_in: null,
      refresh_token_expires_in: null,
      refresh_token_expires_at: null,
    };
  }

  const refresh = tokens.refresh_token || null;
  const relRaw = tokens.refresh_token_expires_in;
  const rel =
    relRaw != null && relRaw !== ""
      ? Number(relRaw)
      : null;
  const relValid = Number.isFinite(rel) && rel > 0;

  return {
    id_token: tokens.id_token || null,
    refresh_token: refresh,
    id_token_expires_in: tokens.expires_in ?? null,
    refresh_token_expires_in: relValid ? rel : null,
    refresh_token_expires_at:
      refresh && relValid ? Date.now() + rel * 1000 : null,
  };
}

module.exports = { buildUserTokensSubdocument };
