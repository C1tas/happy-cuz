/**
 * Test: decrypt session messages using the exact same libraries as the web app
 * Uses @noble/hashes for HMAC (same as hmac_sha512.web.ts)
 * Uses @noble/ciphers for AES-GCM (same as aes.web.ts)
 * Uses libsodium-wrappers for box decryption (same as libsodium.lib.web.ts)
 */
import _sodium from 'libsodium-wrappers';
import crypto from 'crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { gcm } from '@noble/ciphers/aes.js';

const SERVER = 'https://happy.sg.c1tas.pw';
const SECRET_KEY_BASE32 = 'IHKS3-K2NSI-HHWB6-YTKE4-YJIXY-MGAL4-YQIOM-SDWH4-XHAEV-GM4KF-4A';
const TARGET_SESSION = 'cmnu4ot2h0osznv141gk0dybw';

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

function b64Decode(b64) {
    return new Uint8Array(Buffer.from(b64, 'base64'));
}
function b64Encode(buf) {
    return Buffer.from(buf).toString('base64');
}

// Use @noble/hashes HMAC-SHA512 (same as hmac_sha512.web.ts)
function hmacSha512Noble(key, data) {
    return hmac(sha512, key, data);
}

// Use Node.js crypto HMAC-SHA512 (for comparison)
function hmacSha512Node(key, data) {
    const h = crypto.createHmac('sha512', Buffer.from(key));
    h.update(Buffer.from(data));
    return new Uint8Array(h.digest());
}

// Key derivation (matches deriveKey.ts)
function deriveKey(masterSecret, usage, path) {
    const usageBytes = new TextEncoder().encode(usage);
    const usageKey = hmacSha512Noble(masterSecret, usageBytes).slice(0, 32);
    let current = usageKey;
    for (const segment of path) {
        const segBytes = new TextEncoder().encode(segment);
        current = hmacSha512Noble(current, segBytes).slice(0, 32);
    }
    return current;
}

async function main() {
    await _sodium.ready;
    const sodium = _sodium;
    const secretBytes = decodeBase32(SECRET_KEY_BASE32);
    console.log(`Secret key: ${secretBytes.length} bytes, hex: ${Buffer.from(secretBytes).toString('hex').slice(0, 16)}...`);

    // Compare HMAC implementations
    const testHmacNoble = hmacSha512Noble(secretBytes, new TextEncoder().encode('Happy EnCoder'));
    const testHmacNode = hmacSha512Node(secretBytes, new TextEncoder().encode('Happy EnCoder'));
    console.log(`HMAC noble: ${Buffer.from(testHmacNoble.slice(0, 8)).toString('hex')}`);
    console.log(`HMAC node:  ${Buffer.from(testHmacNode.slice(0, 8)).toString('hex')}`);
    console.log(`HMAC match: ${Buffer.from(testHmacNoble).equals(Buffer.from(testHmacNode))}`);

    // Derive content key (same as Encryption.create)
    const contentDataKey = deriveKey(secretBytes, 'Happy EnCoder', ['content']);
    console.log(`Content data key: ${Buffer.from(contentDataKey).toString('hex').slice(0, 16)}...`);

    // Create box keypair from content data key
    const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);
    console.log(`Content public key: ${b64Encode(contentKeyPair.publicKey)}`);

    // Authenticate
    const signKeypair = sodium.crypto_sign_seed_keypair(secretBytes);
    const challenge = crypto.randomBytes(32);
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
    const { token } = await authRes.json();
    console.log(`Auth: ${authRes.status}`);

    // Fetch sessions
    const sessRes = await fetch(`${SERVER}/v1/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const sessData = await sessRes.json();
    const sessions = sessData.sessions;
    const target = sessions.find(s => s.id === TARGET_SESSION);
    if (!target) {
        console.error(`Session ${TARGET_SESSION} not found`);
        return;
    }
    console.log(`\nSession: ${target.id}, hasKey: ${!!target.dataEncryptionKey}`);

    // Decrypt session's data encryption key
    const encKey = b64Decode(target.dataEncryptionKey);
    console.log(`Encrypted key: ${encKey.length} bytes, version: ${encKey[0]}`);
    if (encKey[0] !== 0) {
        console.error('Unknown version byte');
        return;
    }

    // decryptBox: ephemeral_pk (32) + nonce (24) + encrypted
    const payload = encKey.slice(1);
    const ephPk = payload.slice(0, 32);
    const nonce = payload.slice(32, 56);
    const encrypted = payload.slice(56);
    console.log(`Box decrypt: ephPk=${ephPk.length}B, nonce=${nonce.length}B, encrypted=${encrypted.length}B`);

    let sessionKey;
    try {
        sessionKey = sodium.crypto_box_open_easy(encrypted, nonce, ephPk, contentKeyPair.privateKey);
        console.log(`Session AES key: ${sessionKey.length} bytes - OK!`);
    } catch (e) {
        console.error(`Box decrypt FAILED:`, e.message);
        return;
    }

    // Test metadata decryption
    const metaBytes = b64Decode(target.metadata);
    console.log(`\nMetadata: ${metaBytes.length} bytes, version: ${metaBytes[0]}`);
    if (metaBytes[0] === 0) {
        const aesData = metaBytes.slice(1);
        const iv = aesData.slice(0, 12);
        const ciphertext = aesData.slice(12);
        try {
            const aes = gcm(sessionKey, iv);
            const plain = aes.decrypt(ciphertext);
            const text = new TextDecoder().decode(plain);
            const meta = JSON.parse(text);
            console.log(`Metadata [@noble]: title="${meta.title}", model="${meta.model}"`);
        } catch (e) {
            console.error(`Metadata decrypt [@noble] FAILED:`, e.message);
        }
    }

    // Fetch and decrypt messages
    console.log(`\n--- Fetching messages ---`);
    const msgRes = await fetch(`${SERVER}/v3/sessions/${TARGET_SESSION}/messages?before_seq=999999999&limit=5`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const msgData = await msgRes.json();
    const messages = msgData.messages;
    console.log(`Messages: ${messages.length}`);

    for (const msg of messages) {
        console.log(`\n  Message ${msg.id} (seq=${msg.seq}):`);
        if (msg.content?.t !== 'encrypted') {
            console.log(`    Not encrypted`);
            continue;
        }

        const encMsgBytes = b64Decode(msg.content.c);
        console.log(`    Encrypted: ${encMsgBytes.length} bytes, version: ${encMsgBytes[0]}`);
        if (encMsgBytes[0] !== 0) {
            console.log(`    Unknown version`);
            continue;
        }

        const aesPayload = encMsgBytes.slice(1);
        const msgIv = aesPayload.slice(0, 12);
        const msgCiphertext = aesPayload.slice(12);

        try {
            const aes = gcm(sessionKey, msgIv);
            const plain = aes.decrypt(msgCiphertext);
            const text = new TextDecoder().decode(plain);
            const parsed = JSON.parse(text);
            console.log(`    [@noble] OK - role: ${parsed.role}, type: ${parsed.content?.type || 'N/A'}`);
            if (parsed.content?.data?.message?.content) {
                const first = parsed.content.data.message.content[0];
                console.log(`    Preview: [${first?.type}] ${(first?.text || '').slice(0, 60)}...`);
            } else if (parsed.content && typeof parsed.content === 'string') {
                console.log(`    Preview: ${parsed.content.slice(0, 60)}...`);
            }
        } catch (e) {
            console.error(`    [@noble] FAILED:`, e.message);
        }
    }

    console.log('\n=== Complete ===');
}

main().catch(console.error);
