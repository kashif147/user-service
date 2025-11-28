const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 16 bytes for AES
const AUTH_TAG_LENGTH = 16; // 16 bytes for GCM authentication tag
const SALT_LENGTH = 64; // 64 bytes for key derivation

function deriveKey() {
  const secret = process.env.JWT_SECRET;
  
  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY or JWT_SECRET environment variable is required for token encryption"
    );
  }

  const salt = crypto
    .createHash("sha256")
    .update(secret)
    .digest()
    .slice(0, SALT_LENGTH);

  return crypto.pbkdf2Sync(secret, salt, 100000, 32, "sha256");
}

function encryptToken(token) {
  try {
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(token, "utf8", "base64");
    encrypted += cipher.final("base64");
    const authTag = cipher.getAuthTag();

    const encryptedToken = [
      iv.toString("base64"),
      authTag.toString("base64"),
      encrypted,
    ].join(":");

    return encryptedToken;
  } catch (error) {
    console.error("Token encryption error:", error.message);
    throw new Error(`Failed to encrypt token: ${error.message}`);
  }
}

function decryptToken(encryptedToken) {
  try {
    const parts = encryptedToken.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted token format");
    }

    const [ivBase64, authTagBase64, encrypted] = parts;
    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");
    const key = deriveKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Token decryption error:", error.message);
    throw new Error(`Failed to decrypt token: ${error.message}`);
  }
}

module.exports = {
  encryptToken,
  decryptToken,
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
};

