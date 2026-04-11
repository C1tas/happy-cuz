/**
 * Debug: trace exact key derivation and box decryption
 */
import _sodium from 'libsodium-wrappers';
import crypto from 'crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

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

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function b64d(s) { return new Uint8Array(Buffer.from(s, 'base64')); }
function hex(buf) { return Buffer.from(buf).toString('hex'); }

function deriveKey(masterSecret, usage, path) {
    const usageKey = hmac(sha512, masterSecret, new TextEncoder().encode(usage)).slice(0, 32);
    let current = usageKey;
    for (const segment of path) {
        current = hmac(sha512, current, new TextEncoder().encode(segment)).slice(0, 32);
    }
    return current;
}

async function main() {
    await _sodium.ready;
    const sodium = _sodium;
    const secretBytes = decodeBase32(SECRET_KEY_BASE32);

    // 1. Derive content key
    const contentDataKey = deriveKey(secretBytes, 'Happy EnCoder', ['content']);
    console.log(`contentDataKey (hex): ${hex(contentDataKey)}`);

    // 2. Create box keypair
    const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);
    console.log(`box public key: ${hex(contentKeyPair.publicKey)}`);
    console.log(`box secret key: ${hex(contentKeyPair.privateKey)}`);
    console.log(`box public key b64: ${b64(contentKeyPair.publicKey)}`);

    // 3. Verify keypair is valid
    const testMsg = new Uint8Array([1,2,3,4]);
    const testNonce = new Uint8Array(24);
    const testEncrypted = sodium.crypto_box_easy(testMsg, testNonce, contentKeyPair.publicKey, contentKeyPair.privateKey);
    const testDecrypted = sodium.crypto_box_open_easy(testEncrypted, testNonce, contentKeyPair.publicKey, contentKeyPair.privateKey);
    console.log(`Self-encrypt/decrypt test: ${hex(testDecrypted)} === ${hex(testMsg)} : ${Buffer.from(testDecrypted).equals(Buffer.from(testMsg))}`);

    // 4. Auth
    const signKeypair = sodium.crypto_sign_seed_keypair(secretBytes);
    const challenge = crypto.randomBytes(32);
    const signature = sodium.crypto_sign_detached(challenge, signKeypair.privateKey);
    const authRes = await fetch(`${SERVER}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            challenge: b64(challenge),
            signature: b64(signature),
            publicKey: b64(signKeypair.publicKey),
        })
    });
    const { token } = await authRes.json();

    // 5. Get session encryption key
    const sessRes = await fetch(`${SERVER}/v1/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const sessData = await sessRes.json();
    const target = sessData.sessions.find(s => s.id === TARGET_SESSION);
    console.log(`\nSession dataEncryptionKey: ${target.dataEncryptionKey.slice(0, 40)}...`);

    const encKey = b64d(target.dataEncryptionKey);
    console.log(`Raw bytes: ${encKey.length}, version: ${encKey[0]}`);

    const payload = encKey.slice(1);
    const ephPk = payload.slice(0, 32);
    const nonce = payload.slice(32, 56);
    const ciphertext = payload.slice(56);

    console.log(`ephemeral pk: ${hex(ephPk)}`);
    console.log(`nonce: ${hex(nonce)}`);
    console.log(`ciphertext: ${ciphertext.length} bytes`);

    // Try decryption
    try {
        const result = sodium.crypto_box_open_easy(ciphertext, nonce, ephPk, contentKeyPair.privateKey);
        console.log(`\nDecrypted session key: ${hex(result)}`);
    } catch (e) {
        console.error(`\nDecryption failed: ${e.message}`);

        // Try with crypto_box_seal_open (anonymous/sealed box) instead
        console.log('\nTrying crypto_box_seal_open...');
        try {
            const sealPayload = encKey.slice(1); // Skip version byte
            const result = sodium.crypto_box_seal_open(sealPayload, contentKeyPair.publicKey, contentKeyPair.privateKey);
            console.log(`Sealed box decrypt: ${hex(result)}`);
        } catch (e2) {
            console.error(`Sealed box also failed: ${e2.message}`);
        }

        // Print additional key info for comparison
        console.log(`\n--- Key comparison info ---`);
        console.log(`Sign public key (auth): ${b64(signKeypair.publicKey)}`);
        console.log(`Box public key (content): ${b64(contentKeyPair.publicKey)}`);

        // Check what the ephemeral pk looks like
        // The encryption was done with encryptBox(data, recipient_public_key)
        // So the recipient_public_key should be our contentKeyPair.publicKey
        // But maybe it was encrypted for a different key?
        console.log(`\nExpected recipient public key: ${hex(contentKeyPair.publicKey)}`);
        console.log(`If the session was encrypted for a different public key, decryption will fail.`);
    }
}

main().catch(console.error);
