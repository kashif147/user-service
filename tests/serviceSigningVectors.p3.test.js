/**
 * p5-svc-sig/1 shared vectors (verifier copy in user-service, services/serviceSignatureVerify.js).
 *
 *   contracts/p5-service-signing.v1.json                      byte-identical with account / events / profile-service
 *   contracts/p5-service-signing.tenant-creditor-profile.v1.json  byte-identical with profile-service (signer)
 *
 * Both files are SHA-256 pinned; every vector must reproduce exactly with this repo's canonicalString / HMAC, so
 * the verifier canonicalization is byte-for-byte the reviewed one.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const V = require("../services/serviceSignatureVerify");

const FILES = {
  "p5-service-signing.v1.json": "470d151d232a1acc00ae724afe05bc0986a0f5131fbc55861c3edd168383bf64",
  "p5-service-signing.tenant-creditor-profile.v1.json": "96cd8d33f87e261639e55ea0104e0323470c6f453f445b59fc475cf247e0991d",
};
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f));

test.each(Object.entries(FILES))("%s is pinned", (f, sha) => {
  expect(crypto.createHash("sha256").update(read(f)).digest("hex")).toBe(sha);
});

test.each(Object.keys(FILES))("%s: every vector reproduces (canonical string, body hash, signature)", (f) => {
  const c = JSON.parse(read(f).toString("utf8"));
  expect(c.vectors.length).toBeGreaterThan(0);
  for (const v of c.vectors) {
    const i = v.input;
    const body = V.sha256Hex(Buffer.from(i.body, "utf8"));
    const canonical = V.canonicalString({ aud: i.aud || c.audience, caller: i.caller, kid: i.kid, method: i.method, target: i.target, tenant: i.tenant, idem: i.idem, bodySha256: body, ts: i.ts, nonce: i.nonce });
    expect({ name: v.name, body, canonical, sig: V.signCanonical(v.secret, canonical) }).toEqual({ name: v.name, body: v.expect.bodySha256, canonical: v.expect.canonical, sig: v.expect.sig });
    expect(V.signaturesEqual(v.expect.sig, V.signCanonical(v.secret, canonical))).toBe(true);
  }
});

test("creditor-profile contract: operation, audience, caller, and the tenant header is bound", () => {
  const c = JSON.parse(read("p5-service-signing.tenant-creditor-profile.v1.json").toString("utf8"));
  expect([c.operation, c.audience, c.caller, c.maxSkewSeconds]).toEqual(["tenant_creditor_profile", "user-service", "profile-service", 60]);
  expect(V.AUDIENCE).toBe("user-service");
  expect(V.MAX_SKEW_SECONDS).toBe(60);
  expect(c.vectors[1].expect.sig).not.toBe(c.vectors[3].expect.sig);
  // default audience of this verifier is user-service
  const i = c.vectors[1].input;
  expect(V.canonicalString({ ...i, bodySha256: V.sha256Hex(Buffer.alloc(0)), aud: undefined })).toBe(c.vectors[1].expect.canonical);
});
