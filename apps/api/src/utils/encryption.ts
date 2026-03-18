import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

// AES-256-GCM auth tag is always exactly 16 bytes → 32 hex chars
const TAG_HEX_LEN = 32;

function getKey(): Buffer {
  const hex = process.env['ENCRYPTION_KEY'];
  if (!hex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns ciphertext and IV as hex strings.
 *
 * Format: ciphertext = encryptedHex + tagHex (tag is always the last TAG_HEX_LEN chars).
 * This avoids delimiter ambiguity — hex strings never contain colons and the
 * auth tag length is fixed (16 bytes = 32 hex chars), so the split is deterministic.
 */
export function encrypt(plaintext: string): { ciphertext: string; iv: string } {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted + tag,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt a ciphertext string previously produced by encrypt().
 * @param ciphertext  encryptedHex + tagHex  (new format, no separator)
 *                    OR "encryptedHex:tagHex" (legacy format, auto-detected)
 * @param iv          hex-encoded IV
 */
export function decrypt(ciphertext: string, iv: string): string {
  const key = getKey();

  let encrypted: string;
  let tag: string;

  if (ciphertext.includes(':')) {
    // Legacy colon-delimited format — hex never contains ':', so this is unambiguous
    const colonIdx = ciphertext.lastIndexOf(':');
    encrypted = ciphertext.slice(0, colonIdx);
    tag = ciphertext.slice(colonIdx + 1);
  } else {
    // New fixed-length format: tag is always the last TAG_HEX_LEN chars
    if (ciphertext.length < TAG_HEX_LEN) {
      throw new Error('Invalid ciphertext format — too short');
    }
    encrypted = ciphertext.slice(0, -TAG_HEX_LEN);
    tag = ciphertext.slice(-TAG_HEX_LEN);
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
