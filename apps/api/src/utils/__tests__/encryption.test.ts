import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt } from '../encryption.js';

// AES-256-GCM key: 32 bytes = 64 hex chars
const TEST_KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env['ENCRYPTION_KEY'] = TEST_KEY;
});

describe('encrypt', () => {
  it('returns hex ciphertext with no colon separator', () => {
    const { ciphertext } = encrypt('hello');
    expect(ciphertext).not.toContain(':');
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('returns a 32-char hex IV', () => {
    const { iv } = encrypt('hello');
    expect(iv).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const { ciphertext: a } = encrypt('same');
    const { ciphertext: b } = encrypt('same');
    expect(a).not.toBe(b);
  });
});

describe('decrypt (new format)', () => {
  it('round-trips ASCII text', () => {
    const { ciphertext, iv } = encrypt('hello world');
    expect(decrypt(ciphertext, iv)).toBe('hello world');
  });

  it('round-trips Unicode text', () => {
    const { ciphertext, iv } = encrypt('Shopify token: شعاع ✓');
    expect(decrypt(ciphertext, iv)).toBe('Shopify token: شعاع ✓');
  });

  it('round-trips an empty string', () => {
    const { ciphertext, iv } = encrypt('');
    expect(decrypt(ciphertext, iv)).toBe('');
  });

  it('throws on auth tag tampering', () => {
    const { ciphertext, iv } = encrypt('secret');
    // Flip the last hex char to corrupt the tag
    const corrupted = ciphertext.slice(0, -1) + (ciphertext.endsWith('0') ? '1' : '0');
    expect(() => decrypt(corrupted, iv)).toThrow();
  });

  it('throws on ciphertext that is too short', () => {
    expect(() => decrypt('deadbeef', 'a'.repeat(32))).toThrow('too short');
  });
});

describe('decrypt (legacy colon format)', () => {
  it('still decrypts old colon-separated ciphertexts', () => {
    // Manually construct a legacy-format ciphertext by splitting what encrypt() makes
    const { ciphertext: newFmt, iv } = encrypt('legacy test');
    // New format: last 32 chars = tag; convert to legacy by inserting colon
    const legacyFmt = newFmt.slice(0, -32) + ':' + newFmt.slice(-32);
    expect(decrypt(legacyFmt, iv)).toBe('legacy test');
  });
});
