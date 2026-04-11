/**
 * Minimal test: auth + fetch raw messages for a session
 * Usage: node test-messages-raw.mjs
 */
import _sodium from 'libsodium-wrappers';
import crypto from 'crypto';

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

async function main() {
    await _sodium.ready;
    const sodium = _sodium;
    const secretBytes = decodeBase32(SECRET_KEY_BASE32);
    const keypair = sodium.crypto_sign_seed_keypair(secretBytes);
    const challenge = crypto.randomBytes(32);
    const signature = sodium.crypto_sign_detached(challenge, keypair.privateKey);

    const authRes = await fetch(`${SERVER}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            challenge: Buffer.from(challenge).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
            publicKey: Buffer.from(keypair.publicKey).toString('base64'),
        })
    });
    const { token } = await authRes.json();
    console.log(`Auth: ${authRes.status}`);

    // Test v3 messages endpoint
    console.log(`\n--- GET /v3/sessions/${TARGET_SESSION}/messages ---`);
    const msgRes = await fetch(`${SERVER}/v3/sessions/${TARGET_SESSION}/messages?before_seq=999999999&limit=5`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`Status: ${msgRes.status}`);
    console.log(`Content-Type: ${msgRes.headers.get('content-type')}`);

    if (!msgRes.ok) {
        console.error(`Body: ${await msgRes.text()}`);
        return;
    }

    const data = await msgRes.json();
    console.log(`hasMore: ${data.hasMore}`);
    const messages = data.messages || [];
    console.log(`Messages: ${messages.length}`);

    for (const msg of messages) {
        console.log(`  - id=${msg.id}, seq=${msg.seq}, content.t="${msg.content?.t}", content.c length=${msg.content?.c?.length || 0}`);
    }

    // Also test with different pagination
    console.log(`\n--- GET /v3/sessions/${TARGET_SESSION}/messages?after_seq=0&limit=5 ---`);
    const msgRes2 = await fetch(`${SERVER}/v3/sessions/${TARGET_SESSION}/messages?after_seq=0&limit=5`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`Status: ${msgRes2.status}`);
    const data2 = await msgRes2.json();
    console.log(`Messages: ${(data2.messages || []).length}, hasMore: ${data2.hasMore}`);
}

main().catch(console.error);
