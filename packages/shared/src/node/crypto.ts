// AES-256-GCM helper for app credentials at rest (auth_config_enc).
// Node-only — exposed as the `@vyzus/shared/crypto` subpath (NOT the root
// index) so browser consumers never touch node:crypto. The API encrypts on
// write; the worker decrypts at run time (02-architecture §7).
// Format: base64(iv).base64(authTag).base64(ciphertext); key = 64-hex-char
// ENCRYPTION_KEY (32 bytes). Blobs are unreadable if the key is lost/rotated.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // 96-bit nonce recommended for GCM
const ALGO = 'aes-256-gcm';

function keyBuffer(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return key;
}

export function encryptJson(value: unknown, hexKey: string): string {
  const key = keyBuffer(hexKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptJson<T = unknown>(blob: string, hexKey: string): T {
  const key = keyBuffer(hexKey);
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted blob');
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
