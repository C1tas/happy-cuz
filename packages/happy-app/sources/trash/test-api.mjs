/**
 * Test script: authenticate with secret key and fetch sessions from the server.
 * Usage: node --experimental-modules test-api.mjs
 */
import _sodium from 'libsodium-wrappers';
import crypto from 'crypto';

const SERVER = 'https://happy.sg.c1tas.pw';
const SECRET_KEY_BASE32 = 'IHKS3-K2NSI-HHWB6-YTKE4-YJIXY-MGAL4-YQIOM-SDWH4-XHAEV-GM4KF-4A';

// ---- Base32 decode (RFC 4648) ----
function decodeBase32(input) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    // Error correction + strip non-base32
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

async function main() {
    await _sodium.ready;
    const sodium = _sodium;

    // 1. Decode secret key
    const secretBytes = decodeBase32(SECRET_KEY_BASE32);
    console.log(`Secret key: ${secretBytes.length} bytes`);
    if (secretBytes.length !== 32) {
        console.error('ERROR: Expected 32 bytes, got', secretBytes.length);
        return;
    }

    // 2. Derive Ed25519 keypair
    const keypair = sodium.crypto_sign_seed_keypair(secretBytes);
    console.log(`Public key: ${Buffer.from(keypair.publicKey).toString('base64')}`);

    // 3. Generate challenge and sign
    const challenge = crypto.randomBytes(32);
    const signature = sodium.crypto_sign_detached(challenge, keypair.privateKey);

    // 4. POST /v1/auth
    console.log(`\n--- POST ${SERVER}/v1/auth ---`);
    const authRes = await fetch(`${SERVER}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
            publicKey: Buffer.from(keypair.publicKey).toString('base64'),
        })
    });
    console.log(`Status: ${authRes.status}`);
    const authBody = await authRes.json();
    if (!authBody.token) {
        console.error('Auth failed:', authBody);
        return;
    }
    console.log(`Token: ${authBody.token.slice(0, 40)}...`);

    // 5. GET /v1/sessions
    console.log(`\n--- GET ${SERVER}/v1/sessions ---`);
    const sessRes = await fetch(`${SERVER}/v1/sessions`, {
        headers: {
            'Authorization': `Bearer ${authBody.token}`,
            'Content-Type': 'application/json'
        }
    });
    console.log(`Status: ${sessRes.status}`);
    const sessBody = await sessRes.json();
    if (Array.isArray(sessBody)) {
        console.log(`Sessions count: ${sessBody.length}`);
        for (const s of sessBody.slice(0, 5)) {
            console.log(`  - ${s.id} (updated: ${new Date(s.updatedAt).toISOString()})`);
        }
    } else {
        console.log('Response:', JSON.stringify(sessBody).slice(0, 200));
    }

    // 6. GET /v1/machines
    console.log(`\n--- GET ${SERVER}/v1/machines ---`);
    const machRes = await fetch(`${SERVER}/v1/machines`, {
        headers: {
            'Authorization': `Bearer ${authBody.token}`,
            'Content-Type': 'application/json'
        }
    });
    console.log(`Status: ${machRes.status}`);
    const machBody = await machRes.json();
    if (Array.isArray(machBody)) {
        console.log(`Machines count: ${machBody.length}`);
        for (const m of machBody.slice(0, 5)) {
            console.log(`  - ${m.id} (updated: ${new Date(m.updatedAt).toISOString()})`);
        }
    } else {
        console.log('Response:', JSON.stringify(machBody).slice(0, 200));
    }

    // 7. Test WebSocket connectivity
    console.log(`\n--- Socket.IO polling test ---`);
    const pollRes = await fetch(`${SERVER}/v1/updates/?EIO=4&transport=polling`);
    console.log(`Status: ${pollRes.status}`);
    const pollBody = await pollRes.text();
    console.log(`Response: ${pollBody.slice(0, 100)}`);

    console.log('\n=== API connectivity test complete ===');
}

main().catch(console.error);
