/**
 * Playwright profiling script for Happy web app
 *
 * Opens a headed browser at 192.168.58.1:8081, records:
 *   - All network requests with timing
 *   - All console messages (errors, warnings, logs)
 *   - Performance marks
 *   - WebSocket frames
 *
 * User completes login and navigation manually.
 * Press Ctrl+C in terminal to stop and generate report.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const TARGET = 'http://192.168.58.1:8081';
const OUT_DIR = './test-results';

// Collectors
const networkLog = [];
const consoleLog = [];
const wsFrames = [];
const perfMarks = [];
let startTime = Date.now();

function ts() { return Date.now() - startTime; }

async function main() {
    console.log('🚀 Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        args: ['--window-size=1400,900'],
    });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // --- Network logging ---
    page.on('request', (req) => {
        const entry = {
            ts: ts(),
            method: req.method(),
            url: req.url(),
            type: req.resourceType(),
            startTime: Date.now(),
        };
        // Store reference for response matching
        req._profEntry = entry;
        networkLog.push(entry);
    });

    page.on('response', (res) => {
        const req = res.request();
        const entry = req._profEntry;
        if (entry) {
            entry.status = res.status();
            entry.duration = Date.now() - entry.startTime;
            entry.size = res.headers()['content-length'] || '?';
        }
    });

    page.on('requestfailed', (req) => {
        const entry = req._profEntry;
        if (entry) {
            entry.status = 'FAILED';
            entry.error = req.failure()?.errorText || 'unknown';
            entry.duration = Date.now() - entry.startTime;
        }
    });

    // --- Console logging ---
    page.on('console', (msg) => {
        const entry = {
            ts: ts(),
            type: msg.type(),
            text: msg.text(),
            location: msg.location() ? `${msg.location().url}:${msg.location().lineNumber}` : '',
        };
        consoleLog.push(entry);

        // Print errors and warnings live
        if (msg.type() === 'error' || msg.type() === 'warning') {
            const icon = msg.type() === 'error' ? '❌' : '⚠️';
            console.log(`  ${icon} [${(entry.ts / 1000).toFixed(1)}s] ${msg.text().slice(0, 200)}`);
        }
    });

    // --- Page errors ---
    page.on('pageerror', (err) => {
        consoleLog.push({ ts: ts(), type: 'pageerror', text: err.message });
        console.log(`  💥 [${(ts() / 1000).toFixed(1)}s] PAGE ERROR: ${err.message.slice(0, 200)}`);
    });

    // --- WebSocket tracking ---
    page.on('websocket', (ws) => {
        const wsUrl = ws.url();
        console.log(`  🔌 [${(ts() / 1000).toFixed(1)}s] WebSocket opened: ${wsUrl}`);
        wsFrames.push({ ts: ts(), event: 'open', url: wsUrl });

        ws.on('framesent', (data) => {
            wsFrames.push({ ts: ts(), event: 'sent', url: wsUrl, size: data.payload?.length || 0 });
        });
        ws.on('framereceived', (data) => {
            wsFrames.push({ ts: ts(), event: 'recv', url: wsUrl, size: data.payload?.length || 0 });
        });
        ws.on('close', () => {
            wsFrames.push({ ts: ts(), event: 'close', url: wsUrl });
            console.log(`  🔌 [${(ts() / 1000).toFixed(1)}s] WebSocket closed: ${wsUrl}`);
        });
    });

    // Navigate
    startTime = Date.now();
    console.log(`\n📡 Navigating to ${TARGET}`);
    console.log('━'.repeat(60));

    try {
        await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
        console.log(`  ⏳ Navigation: ${e.message.slice(0, 100)}`);
    }

    const loadTime = ts();
    console.log(`  📄 DOM loaded in ${loadTime}ms`);
    perfMarks.push({ ts: loadTime, mark: 'dom-content-loaded' });

    // Wait for network idle
    try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        const idleTime = ts();
        console.log(`  🏁 Network idle at ${idleTime}ms`);
        perfMarks.push({ ts: idleTime, mark: 'network-idle' });
    } catch {
        console.log(`  ⏳ Network did not reach idle within 15s (WebSocket keeps it active)`);
    }

    console.log('━'.repeat(60));
    console.log('');
    console.log('👉 浏览器已打开，请在浏览器中完成以下操作：');
    console.log('   1. 登录（如需要）');
    console.log('   2. 点击一个 session 查看消息加载');
    console.log('   3. 尝试发送消息、切换 session 等操作');
    console.log('');
    console.log('✅ 操作完成后，在此终端按 Enter 键结束录制并生成报告');
    console.log('━'.repeat(60));

    // Wait for user to press Enter
    await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', resolve);
    });

    console.log('\n📊 Generating report...');

    // --- Generate report ---
    const report = [];
    report.push('# Happy Web App Profiling Report');
    report.push(`\nGenerated: ${new Date().toISOString()}`);
    report.push(`Target: ${TARGET}`);
    report.push(`Total recording time: ${(ts() / 1000).toFixed(1)}s`);

    // Performance marks
    report.push('\n## Performance Marks');
    for (const m of perfMarks) {
        report.push(`- ${m.mark}: ${m.ts}ms`);
    }

    // Network summary
    report.push('\n## Network Summary');
    const apiRequests = networkLog.filter(r => r.url.includes('/v1/') || r.url.includes('/v3/'));
    const staticRequests = networkLog.filter(r => !r.url.includes('/v1/') && !r.url.includes('/v3/'));
    report.push(`- Total requests: ${networkLog.length}`);
    report.push(`- API requests: ${apiRequests.length}`);
    report.push(`- Static/bundle requests: ${staticRequests.length}`);
    report.push(`- Failed requests: ${networkLog.filter(r => r.status === 'FAILED').length}`);

    // API requests detail (sorted by time)
    report.push('\n## API Requests (chronological)');
    report.push('```');
    report.push(`${'Time'.padEnd(8)} ${'Dur'.padEnd(8)} ${'Status'.padEnd(8)} ${'Method'.padEnd(6)} URL`);
    report.push('─'.repeat(100));
    for (const r of apiRequests.sort((a, b) => a.ts - b.ts)) {
        const time = `${r.ts}ms`.padEnd(8);
        const dur = r.duration ? `${r.duration}ms`.padEnd(8) : '?'.padEnd(8);
        const status = `${r.status || '?'}`.padEnd(8);
        const method = r.method.padEnd(6);
        // Shorten URL for readability
        const url = r.url.replace(TARGET, '').replace('https://happy.sg.c1tas.pw', '');
        report.push(`${time} ${dur} ${status} ${method} ${url}`);
    }
    report.push('```');

    // Slow requests (>500ms)
    const slowReqs = networkLog.filter(r => r.duration > 500).sort((a, b) => b.duration - a.duration);
    if (slowReqs.length > 0) {
        report.push('\n## Slow Requests (>500ms)');
        report.push('```');
        for (const r of slowReqs.slice(0, 20)) {
            const url = r.url.replace(TARGET, '').replace('https://happy.sg.c1tas.pw', '');
            report.push(`  ${r.duration}ms  ${r.method} ${url}`);
        }
        report.push('```');
    }

    // Console errors
    const errors = consoleLog.filter(c => c.type === 'error' || c.type === 'pageerror');
    report.push(`\n## Console Errors (${errors.length} total)`);
    if (errors.length > 0) {
        report.push('```');
        for (const e of errors) {
            report.push(`[${(e.ts / 1000).toFixed(1)}s] ${e.text.slice(0, 300)}`);
        }
        report.push('```');
    }

    // Console warnings
    const warnings = consoleLog.filter(c => c.type === 'warning');
    report.push(`\n## Console Warnings (${warnings.length} total)`);
    if (warnings.length > 0) {
        report.push('```');
        for (const w of warnings.slice(0, 30)) {
            report.push(`[${(w.ts / 1000).toFixed(1)}s] ${w.text.slice(0, 200)}`);
        }
        if (warnings.length > 30) report.push(`... and ${warnings.length - 30} more`);
        report.push('```');
    }

    // WebSocket summary
    report.push(`\n## WebSocket Activity`);
    const opens = wsFrames.filter(f => f.event === 'open');
    const sent = wsFrames.filter(f => f.event === 'sent');
    const recv = wsFrames.filter(f => f.event === 'recv');
    report.push(`- Connections opened: ${opens.length}`);
    report.push(`- Frames sent: ${sent.length}`);
    report.push(`- Frames received: ${recv.length}`);
    if (opens.length > 0) {
        report.push(`- First connection at: ${opens[0].ts}ms`);
    }

    // App-specific console logs (sync-related)
    const syncLogs = consoleLog.filter(c =>
        c.type === 'log' && (
            c.text.includes('fetchMessages') ||
            c.text.includes('fetchSessions') ||
            c.text.includes('#init') ||
            c.text.includes('Fast path') ||
            c.text.includes('🔄') ||
            c.text.includes('💬') ||
            c.text.includes('🆕')
        )
    );
    if (syncLogs.length > 0) {
        report.push(`\n## Sync Logs (${syncLogs.length} entries)`);
        report.push('```');
        for (const l of syncLogs) {
            report.push(`[${(l.ts / 1000).toFixed(1)}s] ${l.text.slice(0, 300)}`);
        }
        report.push('```');
    }

    // Write report
    const reportPath = `${OUT_DIR}/profiling-report-${Date.now()}.md`;
    const rawPath = `${OUT_DIR}/profiling-raw-${Date.now()}.json`;
    fs.writeFileSync(reportPath, report.join('\n'));
    fs.writeFileSync(rawPath, JSON.stringify({ networkLog, consoleLog, wsFrames, perfMarks }, null, 2));

    console.log(`\n📄 Report saved to: ${reportPath}`);
    console.log(`📦 Raw data saved to: ${rawPath}`);

    // Print quick summary
    console.log('\n━━━ Quick Summary ━━━');
    console.log(`Total requests: ${networkLog.length} (API: ${apiRequests.length})`);
    console.log(`Failed: ${networkLog.filter(r => r.status === 'FAILED').length}`);
    console.log(`Slow (>500ms): ${slowReqs.length}`);
    console.log(`Console errors: ${errors.length}`);
    console.log(`Console warnings: ${warnings.length}`);
    console.log(`WS frames: ${sent.length} sent, ${recv.length} recv`);

    await browser.close();
    process.exit(0);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
