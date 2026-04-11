// Web implementation using @noble/ciphers (pure JS, no crypto.subtle dependency)
// crypto.subtle is not available on non-HTTPS origins (e.g. http://192.168.x.x)
// Wire format matches web-secure-encryption: base64(IV[12] + ciphertext+tag)

import { gcm } from '@noble/ciphers/aes.js';
import { decodeUTF8, encodeUTF8 } from './text';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const key = decodeBase64(key64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encodeUTF8(data);
    const aes = gcm(key, iv);
    const ciphertext = aes.encrypt(plaintext);
    // Format: base64(IV[12] + ciphertext_with_tag)
    const combined = new Uint8Array(12 + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, 12);
    return encodeBase64(combined);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    const key = decodeBase64(key64);
    const combined = decodeBase64(data);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const aes = gcm(key, iv);
    const plaintext = aes.decrypt(ciphertext);
    return decodeUTF8(plaintext);
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = await encryptAESGCMString(decodeUTF8(data), key64);
    return decodeBase64(encrypted);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = await decryptAESGCMString(encodeBase64(data), key64);
    return raw ? encodeUTF8(raw) : null;
}
