import { internalError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw internalError("Credential data is not valid");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw internalError("Credential encryption key is not configured");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(value: unknown, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptCredential<T>(encoded: string, secret: string): Promise<T> {
  const [version, ivValue, ciphertextValue] = encoded.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) {
    throw internalError("Stored credential data is invalid");
  }
  const key = await deriveKey(secret);
  try {
    const iv = new Uint8Array(decodeBase64Url(ivValue));
    const ciphertext = new Uint8Array(decodeBase64Url(ciphertextValue));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
      key,
      ciphertext as unknown as ArrayBuffer,
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw internalError("Stored credential data cannot be decrypted");
  }
}

export function randomBase64Url(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}
