import { canonicalJson } from './canonical';

// Device keys, signatures and PIN verifiers on WebCrypto (platform spec §1-§4, D-082). The same code runs in
// the POS (browser) and the API (Node 24), so the formats can never drift apart.

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('not base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A new device key pair. The private key is not extractable: it can sign, but it can never leave the browser. */
export function generateDeviceKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
}

/** The public key as base64url SPKI, for registering with the server. */
export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
}

/** Signs the canonical JSON of `value`: ECDSA P-256 / SHA-256, IEEE P1363 (64 bytes), base64url. */
export async function signCanonical(privateKey: CryptoKey, value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value));
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, data)));
}

/** True only if `signature` is a valid signature of `value` by the key. A malformed key or signature is false. */
export async function verifyCanonical(
  publicKeySpki: string,
  value: unknown,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', fromBase64Url(publicKeySpki), ECDSA, false, ['verify']);
    const data = new TextEncoder().encode(canonicalJson(value));
    return await crypto.subtle.verify(SIGN, key, fromBase64Url(signature), data);
  } catch {
    return false;
  }
}

/** OWASP 2023 for PBKDF2-HMAC-SHA256. Stored in each verifier, so it can be changed later. */
export const PIN_ITERATIONS = 600_000;

export interface PinVerifier {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

const VERIFIER = /^pbkdf2-sha256\$(\d{1,7})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export function parsePinVerifier(text: string): PinVerifier | null {
  const m = VERIFIER.exec(text);
  if (!m) return null;
  return { iterations: Number(m[1]), salt: fromBase64Url(m[2]!), hash: fromBase64Url(m[3]!) };
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` with a fresh 16-byte salt. */
export async function makePinVerifier(pin: string, iterations = PIN_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Checks a PIN against a verifier, in constant time over the hash bytes. Anything malformed is false. */
export async function verifyPin(verifier: string, pin: string): Promise<boolean> {
  const v = parsePinVerifier(verifier);
  if (!v) return false;
  const hash = await derive(pin, v.salt, v.iterations);
  let diff = hash.length ^ v.hash.length;
  for (let i = 0; i < hash.length; i++) diff |= hash[i]! ^ (v.hash[i] ?? 0);
  return diff === 0;
}
