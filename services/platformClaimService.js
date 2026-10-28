/**
 * Phase B / Z1: decides whether a CRM Microsoft (Entra) sign-in gets the platform claim.
 *
 * The claim is issued ONLY after, in this order:
 *   1. the Microsoft ID token was verified (signature, issuer, audience, tid, nonce - AzureADHandler);
 *   2. identity binding: the ProjectShell user the sign-in resolved to is bound to that same oid;
 *   3. a PlatformPrincipal exists for the verified (issuer, oid), with tid = the token's tid;
 *   4. that principal's status is "active".
 * Nothing from the request body, query or headers is read. Email, names, tenant roles ("SU", "*"),
 * organisation codes and the tenant never influence the decision.
 *
 * Claim contract (JWT claim name `plat`), deliberately minimal - no permissions or other mutable state:
 *   { v: 1, pid: "<PlatformPrincipal _id>", rev: <principal revision at issue time> }
 * It lives inside the normal ProjectShell JWT and shares its exp. From Z2, every platform check
 * re-reads the principal by pid and requires status "active", revision === rev and the permission:
 * a disable or permission change takes effect at once, even for tokens that are still valid.
 *
 * PLATFORM_AUTH_MODE: off (default; also any unknown value) | shadow | enforce.
 *   off     - no lookup, no claim, no log line: sign-in exactly as before Z1.
 *   shadow  - lookup + claim + decision log. No route authorisation reads the claim (Z1).
 *   enforce - issuance identical to shadow; the difference is applied by the Z2 checks.
 * A lookup failure never fails the sign-in: it is logged and no claim is issued (fail closed).
 */
const PlatformPrincipal = require("../models/platformPrincipal.model");
const { auditClaimDecision } = require("./platformAuditService");

const CLAIM_NAME = "plat";
const CLAIM_VERSION = 1;
const MODES = Object.freeze(["off", "shadow", "enforce"]);

let warnedInvalidMode = false;
function platformAuthMode() {
  const raw = process.env.PLATFORM_AUTH_MODE;
  if (raw === undefined || raw === "") return "off";
  if (MODES.includes(raw)) return raw;
  if (!warnedInvalidMode) {
    warnedInvalidMode = true;
    console.warn("[platform-auth] PLATFORM_AUTH_MODE has an unknown value; treated as off");
  }
  return "off";
}

// Last 6 characters only: enough to correlate with the record, never the whole id in logs.
const mask = (v) => (v ? `…${String(v).slice(-6)}` : null);

function mfaSignal(amr) {
  if (!Array.isArray(amr)) return "unknown"; // Entra v2 ID tokens often omit amr: CA/MFA is enforced by Entra
  return amr.includes("mfa") ? "yes" : "no";
}

function logDecision(fields) {
  console.info("[platform-auth]", JSON.stringify({ event: "platform.claim.decision", ...fields }));
}

/**
 * @param {{ verifiedIdentity?: {issuer:string, oid:string, tid:string, amr?:string[]}, user: object }} input
 *   verifiedIdentity comes only from AzureADHandler's verified ID token payload.
 * @returns {Promise<{ claim: object|null, decision: string, mode: string }>}
 */
async function resolvePlatformClaim({ verifiedIdentity, user }) {
  const mode = platformAuthMode();
  if (mode === "off") return { claim: null, decision: "mode_off", mode };

  const base = { mode, userId: user && user._id ? String(user._id) : null, tenantId: user && user.tenantId ? String(user.tenantId) : null };
  const done = (decision, extra = {}, claim = null) => {
    logDecision({ ...base, decision, claimIssued: !!claim, ...extra });
    return { claim, decision, mode };
  };

  const id = verifiedIdentity || {};
  const issuerMatch = PlatformPrincipal.ENTRA_V2_ISSUER.exec(typeof id.issuer === "string" ? id.issuer : "");
  if (!issuerMatch || typeof id.oid !== "string" || !PlatformPrincipal.GUID.test(id.oid) || id.tid !== issuerMatch[1]) {
    return done("no_verified_identity");
  }
  // Identity binding: the ProjectShell user this sign-in resolved to must be bound to this oid.
  if (!user || String(user.userMicrosoftId || "") !== id.oid) {
    return done("binding_mismatch");
  }

  let principal;
  try {
    principal = await PlatformPrincipal.findOne({ issuer: id.issuer, oid: id.oid })
      .select({ _id: 1, tid: 1, status: 1, revision: 1, permissions: 1 })
      .lean();
  } catch (err) {
    return done("lookup_error", { error: err && err.name ? err.name : "Error" });
  }
  if (!principal) return done("not_principal");

  const extra = { principalId: mask(principal._id), mfa: mfaSignal(id.amr) };

  // Phase B / Z4: a sign-in that resolved to a REAL principal is a durable security event (issued or refused).
  const audit = (decision, more = {}) =>
    auditClaimDecision({ tenantId: base.tenantId, userId: base.userId, principalId: principal._id, decision, mode, mfa: extra.mfa, ...more });
  if (principal.tid !== id.tid) {
    audit("identity_mismatch");
    return done("identity_mismatch", extra);
  }
  if (principal.status !== "active") {
    audit("disabled");
    return done("disabled", extra);
  }

  const claim = { v: CLAIM_VERSION, pid: String(principal._id), rev: principal.revision };
  const permissionCount = (principal.permissions || []).length;
  audit("issued", { rev: principal.revision, permissionCount });
  return done("issued", { ...extra, rev: principal.revision, permissionCount }, claim);
}

module.exports = { resolvePlatformClaim, platformAuthMode, CLAIM_NAME, CLAIM_VERSION, MODES };
