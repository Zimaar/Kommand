import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env['ENCRYPTION_KEY'];
  if (!hex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns ciphertext and IV as hex strings. The auth tag is appended to
 * ciphertext separated by ':' so the stores table only needs two columns
 * (accessToken = "ciphertext:tag", tokenIv = iv).
 */
export function encrypt(plaintext: string): { ciphertext: string; iv: string } {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: `${encrypted}:${tag}`,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt a ciphertext string previously produced by encrypt().
 * @param ciphertext  "encryptedHex:tagHex"
 * @param iv          hex-encoded IV
 */
export function decrypt(ciphertext: string, iv: string): string {
  const key = getKey();
  const colonIdx = ciphertext.lastIndexOf(':');
  if (colonIdx === -1) throw new Error('Invalid ciphertext format — missing auth tag');
  const encrypted = ciphertext.slice(0, colonIdx);
  const tag = ciphertext.slice(colonIdx + 1);

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
