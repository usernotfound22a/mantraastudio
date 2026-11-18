/**
 * Authenticated encryption for secrets at rest.
 *
 * Used for channel access tokens and webhook signing secrets, which have to be
 * recoverable (we must re-sign each delivery) and therefore cannot be one-way
 * hashed the way API keys are.
 *
 * Format: v1.<iv>.<ciphertext>.<tag>, all base64url, AES-256-GCM.
 * The key is derived from ENV_ENCRYPTION_KEY with scrypt so a short passphrase
 * still yields a full-length key, and so rotating the passphrase is a one-line
 * change rather than a re-key of every row.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey = null;

/** Derives the 32-byte AES key once per process. */
function key() {
  if (!cachedKey) {
    const secret = env.ENCRYPTION_KEY || env.JWT_SECRET;
    cachedKey = crypto.scryptSync(secret, 'socialhub-secret-v1', 32);
  }
  return cachedKey;
}

/**
 * Encrypts a UTF-8 string.
 * @param {string} plaintext
 * @returns {string} v1.<iv>.<tag>.<ciphertext>
 */
export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new TypeError('encryptSecret requires a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

/**
 * Decrypts a value produced by encryptSecret.
 * Throws on tampering - GCM authenticates, so a modified ciphertext fails.
 * @param {string} payload
 * @returns {string}
 */
export function decryptSecret(payload) {
  if (typeof payload !== 'string') {
    throw new TypeError('decryptSecret requires a string');
  }
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised secret format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** True when a string looks like our encrypted envelope. */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}
