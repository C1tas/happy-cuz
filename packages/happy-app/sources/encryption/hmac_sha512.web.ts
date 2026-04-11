// Web implementation using @noble/hashes (pure JS, no crypto.subtle dependency)
// expo-crypto's Crypto.digest is not available on web platform
// crypto.subtle is not available on non-HTTPS origins (e.g. http://192.168.x.x)

import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

export async function hmac_sha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    return hmac(sha512, key, data);
}
