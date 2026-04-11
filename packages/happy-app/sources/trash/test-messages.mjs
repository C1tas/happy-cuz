/**
 * Test: fetch and decrypt session messages
 * Usage: node --experimental-modules test-messages.mjs
 */
import _sodium from 'libsodium-wrappers';
import crypto from 'crypto';

const SERVER = 'https://happy.sg.c1tas.pw';
const SECRET_KEY_BASE32 = 'IHKS3-K2NSI-HHWB6-YTKE4-YJIXY-MGAL4-YQIOM-SDWH4-XHAEV-GM4KF-4A';
const TARGET_SESSION = 'cmnu4ot2h0osznv141gk0dybw';

// ---- Base32 decode (RFC 4648) ----
function decodeBase32(input) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let clean = input.toUpperCase()
        .replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const c of clean) {
        const val = ALPHABET.indexOf(c);
        if (val < 0) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    return bytes;
}

// ---- HMAC-SHA512 ----
function hmacSha512(key, data) {
    const hmac = crypto.createHmac('sha512', key);
    hmac.update(data);
    return new Uint8Array(hmac.digest());
}

// ---- Key derivation (matches app's deriveKey) ----
function deriveKey(masterSecret, usage, path) {
    const usageKey = hmacSha512(masterSecret, Buffer.from(usage, 'utf8')).slice(0, 32);
    let current = usageKey;
    for (const segment of path) {
        current = hmacSha512(current, Buffer.from(segment, 'utf8')).slice(0, 32);
    }
    return current;
}

// ---- Base64 helpers ----
function b64Decode(b64) {
    return new Uint8Array(Buffer.from(b64, 'base64'));
}
function b64Encode(buf) {
    return Buffer.from(buf).toString('base64');
}

// ---- AES-256-GCM decrypt (matching web-secure-encryption format) ----
function decryptAESGCM(encryptedB64, keyBytes) {
    const combined = b64Decode(encryptedB64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    // Separate auth tag (last 16 bytes) from ciphertext
    const authTag = ciphertext.slice(ciphertext.length - 16);
    const data = ciphertext.slice(0, ciphertext.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
}

// ---- AES-256-GCM decrypt (using @noble/ciphers style: ciphertext+tag combined) ----
async function decryptAESGCMNoble(encryptedB64, keyBytes) {
    // Import @noble/ciphers dynamically
    const { gcm } = await import('@noble/ciphers/aes');
    const combined = b64Decode(encryptedB64);
    const iv = combined.slice(0, 12);
    const ciphertextWithTag = combined.slice(12);
    const aes = gcm(keyBytes, iv);
    const plaintext = aes.decrypt(ciphertextWithTag);
    return new TextDecoder().decode(plaintext);
}

async function main() {
    await _sodium.ready;
    const sodium = _sodium;

    // 1. Decode secret key and derive keys
    const secretBytes = decodeBase32(SECRET_KEY_BASE32);
    console.log(`Secret key: ${secretBytes.length} bytes`);

    const contentDataKey = deriveKey(secretBytes, 'Happy EnCoder', ['content']);
    const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);
    console.log(`Content public key: ${b64Encode(contentKeyPair.publicKey)}`);

    // 2. Authenticate
    const challenge = crypto.randomBytes(32);
    const signKeypair = sodium.crypto_sign_seed_keypair(secretBytes);
    const signature = sodium.crypto_sign_detached(challenge, signKeypair.privateKey);

    const authRes = await fetch(`${SERVER}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            challenge: b64Encode(challenge),
            signature: b64Encode(signature),
            publicKey: b64Encode(signKeypair.publicKey),
        })
    });
    const authBody = await authRes.json();
    const token = authBody.token;
    console.log(`Auth: ${authRes.status}, token: ${token.slice(0, 30)}...`);

    // 3. Get sessions and find target session's dataEncryptionKey
    const sessRes = await fetch(`${SERVER}/v1/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const sessData = await sessRes.json();
    const sessions = sessData.sessions || sessData;

    let targetSession = null;
    for (const s of sessions) {
        if (s.id === TARGET_SESSION) {
            targetSession = s;
            break;
        }
    }

    if (!targetSession) {
        console.error(`Session ${TARGET_SESSION} not found!`);
        console.log('Available sessions:', sessions.map(s => s.id).join(', '));
        return;
    }

    console.log(`\nFound session: ${targetSession.id}`);
    console.log(`  dataEncryptionKey present: ${!!targetSession.dataEncryptionKey}`);
    console.log(`  metadata present: ${!!targetSession.metadata}`);

    // 4. Decrypt the per-session data encryption key
    let sessionKey = null;
    if (targetSession.dataEncryptionKey) {
        const encryptedKey = b64Decode(targetSession.dataEncryptionKey);
        const versionByte = encryptedKey[0];
        console.log(`  Key version byte: ${versionByte}`);

        if (versionByte === 0) {
            // Decrypt using box encryption
            const keyPayload = encryptedKey.slice(1);
            // Format: ephemeral_pk (32) + nonce (24) + encrypted_data
            const ephPk = keyPayload.slice(0, 32);
            const nonce = keyPayload.slice(32, 56);
            const encrypted = keyPayload.slice(56);

            try {
                sessionKey = sodium.crypto_box_open_easy(encrypted, nonce, ephPk, contentKeyPair.privateKey);
                console.log(`  Session AES key: ${sessionKey.length} bytes - OK`);
            } catch (e) {
                console.error(`  Failed to decrypt session key:`, e.message);
                return;
            }
        }
    }

    // 5. Try decrypting metadata with the session key
    if (targetSession.metadata && sessionKey) {
        try {
            // metadata is AES encrypted, format: version_byte(1) + IV(12) + ciphertext+tag
            const encData = b64Decode(targetSession.metadata);
            if (encData[0] === 0) {
                const aesPayload = b64Encode(encData.slice(1));
                const decrypted = decryptAESGCM(aesPayload, sessionKey);
                const metadata = JSON.parse(decrypted);
                console.log(`  Metadata decrypted OK: title="${metadata.title || '(none)'}"`);
            }
        } catch (e) {
            console.error(`  Metadata decrypt failed:`, e.message);
        }
    }

    // 6. Fetch messages for this session
    console.log(`\n--- Fetching messages for ${TARGET_SESSION} ---`);
    const msgRes = await fetch(`${SERVER}/v3/sessions/${TARGET_SESSION}/messages?before_seq=999999999&limit=10`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`Messages API status: ${msgRes.status}`);

    if (!msgRes.ok) {
        console.error(`Messages fetch failed: ${await msgRes.text()}`);
        return;
    }

    const msgData = await msgRes.json();
    const messages = msgData.messages || [];
    console.log(`Messages count: ${messages.length}, hasMore: ${msgData.hasMore}`);

    // 7. Try to decrypt each message
    for (const msg of messages.slice(0, 5)) {
        console.log(`\n  Message ${msg.id} (seq=${msg.seq}):`);
        console.log(`    content.t = "${msg.content?.t}"`);

        if (msg.content?.t === 'encrypted' && msg.content?.c && sessionKey) {
            try {
                const encData = b64Decode(msg.content.c);
                console.log(`    Encrypted data length: ${encData.length} bytes, first byte: ${encData[0]}`);

                if (encData[0] === 0) {
                    // Version byte 0 + AES-GCM payload
                    const aesPayload = b64Encode(encData.slice(1));

                    // Test with Node crypto
                    try {
                        const decrypted = decryptAESGCM(aesPayload, sessionKey);
                        const parsed = JSON.parse(decrypted);
                        console.log(`    [node-crypto] Decrypted OK, type: ${parsed.type}, role: ${parsed.role || 'N/A'}`);
                        if (parsed.content) {
                            const preview = typeof parsed.content === 'string'
                                ? parsed.content.slice(0, 80)
                                : JSON.stringify(parsed.content).slice(0, 80);
                            console.log(`    [node-crypto] Content preview: ${preview}...`);
                        }
                    } catch (e) {
                        console.error(`    [node-crypto] Decrypt FAILED:`, e.message);
                    }

                    // Test with @noble/ciphers (same as aes.web.ts)
                    try {
                        const decrypted = await decryptAESGCMNoble(aesPayload, sessionKey);
                        const parsed = JSON.parse(decrypted);
                        console.log(`    [@noble] Decrypted OK, type: ${parsed.type}, role: ${parsed.role || 'N/A'}`);
                    } catch (e) {
                        console.error(`    [@noble] Decrypt FAILED:`, e.message);
                    }
                } else {
                    console.log(`    Unknown version byte: ${encData[0]}`);
                }
            } catch (e) {
                console.error(`    Decrypt error:`, e.message);
            }
        } else if (msg.content?.t !== 'encrypted') {
            console.log(`    Not encrypted, content: ${JSON.stringify(msg.content).slice(0, 100)}`);
        }
    }

    console.log('\n=== Message decryption test complete ===');
}

main().catch(console.error);
