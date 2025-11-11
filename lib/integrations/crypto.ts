import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function parseEncryptionKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY;

  if (!rawKey) {
    throw new Error('Missing ENCRYPTION_KEY environment variable.');
  }

  if (/^[0-9a-fA-F]+$/.test(rawKey) && rawKey.length === KEY_LENGTH * 2) {
    return Buffer.from(rawKey, 'hex');
  }

  if (rawKey.length === KEY_LENGTH) {
    return Buffer.from(rawKey, 'utf-8');
  }

  return Buffer.from(rawKey, 'base64');
}

function ensureKeyLength(buffer: Buffer) {
  if (buffer.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH} bytes after decoding.`);
  }
}

export function encryptSecret(plainText: string): Buffer {
  const key = parseEncryptionKey();
  ensureKeyLength(key);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // TODO: include key versioning metadata within the payload when rotation is introduced.
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptSecret(payload: Buffer | Uint8Array | null): string | null {
  if (!payload) {
    return null;
  }

  const key = parseEncryptionKey();
  ensureKeyLength(key);

  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

  if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted payload too short to contain IV and auth tag.');
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function getEncryptionKeyFingerprint(): string {
  const key = parseEncryptionKey();
  ensureKeyLength(key);
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}


