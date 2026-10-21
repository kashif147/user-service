/**
 * JWT_SECRET is the JWT signing/verification key only. Login responses return the signed JWT
 * itself; nothing encrypts tokens for clients to decrypt, because that meant shipping JWT_SECRET
 * in client bundles (portal/mobile). Guards against the helper or a JWT_SECRET-derived cipher
 * key coming back.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", "tests", ".git", "logs", "coverage"]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no JWT_SECRET-derived token encryption", () => {
  const files = sourceFiles(ROOT);

  test("helpers/tokenEncryption.js no longer exists", () => {
    expect(fs.existsSync(path.join(ROOT, "helpers", "tokenEncryption.js"))).toBe(false);
  });

  test("no source file requires a token-encryption helper", () => {
    const offenders = files.filter((f) => /tokenEncryption|encryptToken|decryptToken/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test("no source file builds a cipher or derives a key (JWT_SECRET is signing-only)", () => {
    const offenders = files.filter((f) => /createCipheriv|createDecipheriv|pbkdf2/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
