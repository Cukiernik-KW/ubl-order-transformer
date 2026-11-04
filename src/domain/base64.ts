import { invalidBase64 } from "./errors.js";

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
const WHITESPACE = /\s+/g;

/**
 * Strict Base64 decoding.
 *
 * Buffer.from(s, "base64") never throws: it silently skips characters outside the alphabet
 * and stops at the first "=", so garbage input "decodes" to some bytes. We validate explicitly:
 * 1. strip whitespace (MIME-style line breaks are allowed),
 * 2. check the alphabet (standard Base64 only; base64url "-" "_" is rejected) and length % 4,
 * 3. round-trip: re-encoding must give back the input. This catches non-canonical encodings
 *    such as "QR==" (decodes to "A", but "A" encodes to "QQ==").
 */
export function decodeBase64Strict(input: string): Buffer {
  const normalized = input.replace(WHITESPACE, "");

  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_ALPHABET.test(normalized)) {
    throw invalidBase64();
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== normalized) {
    throw invalidBase64();
  }
  return decoded;
}
