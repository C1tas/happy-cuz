/**
 * Mock server for testing message lazy loading with large datasets.
 *
 * Usage:
 *   npx tsx sources/trash/mockMessageServer.ts
 *   MOCK_MESSAGE_COUNT=2000 MOCK_PORT=3005 npx tsx sources/trash/mockMessageServer.ts
 *
 * Generates N messages in memory and serves the /v3/sessions/:id/messages endpoint
 * with forward (after_seq) and backward (before_seq) pagination.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

const MESSAGE_COUNT = parseInt(process.env.MOCK_MESSAGE_COUNT || '1000', 10);
const PORT = parseInt(process.env.MOCK_PORT || '3005', 10);

interface MockMessage {
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
    content: { c: string; t: 'encrypted' };
}

function generateMessages(count: number): MockMessage[] {
    const messages: MockMessage[] = [];
    const baseTime = Date.now() - count * 5000; // 5 seconds apart

    const userPrompts = [
        'Can you help me implement a user authentication system with JWT tokens?',
        'How do I optimize the database queries for the dashboard page?',
        'Please refactor the API middleware to add rate limiting',
        'Write unit tests for the payment processing module',
        'Debug the WebSocket connection issue in the chat feature',
        'Implement real-time notifications using Server-Sent Events',
        'Set up CI/CD pipeline with automated testing and deployment',
        'Create a data migration script for the schema changes',
        'Add caching layer using Redis for frequently accessed endpoints',
        'Fix the memory leak in the background job processor',
    ];

    const agentResponses = [
        'I\'ll help you implement the authentication system. Let me start by examining the existing codebase structure and then create the necessary files for JWT-based authentication. First, I need to understand the current user model and database schema. Let me check the existing models and create the auth middleware with proper token generation and validation. This will include refresh token rotation, token blacklisting for logout, and proper error handling for expired or invalid tokens. I\'ll also add rate limiting to the auth endpoints to prevent brute force attacks.',
        'To optimize the database queries, I need to analyze the current query patterns first. Let me check the existing queries and identify the N+1 query problems. I\'ll add proper indexes, implement eager loading for related entities, and use query result caching where appropriate. The dashboard has several aggregate queries that can be materialized. I\'ll also add query timeout handling and connection pooling configuration.',
        'I\'ll refactor the API middleware to support rate limiting. The approach will use a sliding window algorithm with Redis as the backend store. This provides accurate rate limiting with minimal memory overhead. I\'ll create a configurable middleware that supports different rate limits per endpoint, user tier, and IP address. The implementation will include proper headers for rate limit information and graceful handling when Redis is unavailable.',
        'Writing comprehensive unit tests for the payment module. I need to cover the main payment flow, error handling, retry logic, and idempotency. Let me create test fixtures and mock the payment gateway responses. I\'ll test both successful payment scenarios and various failure modes including network timeouts, insufficient funds, and duplicate transaction handling.',
        'I can see the WebSocket connection issue. The problem is that the heartbeat mechanism is not properly handling reconnection scenarios. When the connection drops, the client attempts to reconnect but the server-side session has already been cleaned up. I need to implement a grace period for session cleanup and add proper connection state tracking. Let me fix the reconnection logic and add better error logging.',
    ];

    for (let i = 1; i <= count; i++) {
        const isUser = i % 2 === 1;
        const promptIdx = Math.floor((i - 1) / 2);
        const text = isUser
            ? userPrompts[promptIdx % userPrompts.length]
            : agentResponses[promptIdx % agentResponses.length];

        const role = isUser ? 'user' : 'assistant';
        const plaintext = JSON.stringify({ role, content: [{ type: 'text', text }] });

        messages.push({
            id: randomUUID(),
            seq: i,
            localId: isUser ? randomUUID() : null,
            createdAt: baseTime + i * 5000,
            updatedAt: baseTime + i * 5000,
            content: { c: plaintext, t: 'encrypted' },
        });
    }

    return messages;
}

const messages = generateMessages(MESSAGE_COUNT);
console.log(`Generated ${messages.length} mock messages (seq 1..${messages.length})`);

function parseQuery(url: string): Record<string, string> {
    const query: Record<string, string> = {};
    const queryString = url.split('?')[1];
    if (!queryString) return query;
    for (const pair of queryString.split('&')) {
        const [key, value] = pair.split('=');
        if (key && value) query[decodeURIComponent(key)] = decodeURIComponent(value);
    }
    return query;
}

function setCorsHeaders(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = req.url || '/';
    console.log(`${req.method} ${url}`);

    // Match /v3/sessions/:sessionId/messages
    const match = url.match(/^\/v3\/sessions\/([^/]+)\/messages/);
    if (match && req.method === 'GET') {
        const query = parseQuery(url);
        const afterSeq = parseInt(query.after_seq || '0', 10);
        const beforeSeq = query.before_seq ? parseInt(query.before_seq, 10) : null;
        const limit = Math.min(parseInt(query.limit || '100', 10), 500);

        if (beforeSeq !== null) {
            // Backward pagination: messages with seq < before_seq, ascending order
            const filtered = messages
                .filter(m => m.seq < beforeSeq)
                .sort((a, b) => b.seq - a.seq)
                .slice(0, limit + 1);
            const hasMore = filtered.length > limit;
            const page = hasMore ? filtered.slice(0, limit) : filtered;
            page.reverse(); // ascending order

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages: page, hasMore }));
        } else {
            // Forward pagination: messages with seq > after_seq, ascending order
            const filtered = messages
                .filter(m => m.seq > afterSeq)
                .sort((a, b) => a.seq - b.seq)
                .slice(0, limit + 1);
            const hasMore = filtered.length > limit;
            const page = hasMore ? filtered.slice(0, limit) : filtered;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ messages: page, hasMore }));
        }
        return;
    }

    // Health check
    if (url === '/' || url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', messageCount: messages.length }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`Mock message server running on http://localhost:${PORT}`);
    console.log(`  GET /v3/sessions/:id/messages?after_seq=X&limit=N  (forward pagination)`);
    console.log(`  GET /v3/sessions/:id/messages?before_seq=X&limit=N (backward pagination)`);
    console.log(`  GET /health                                        (health check)`);
});
