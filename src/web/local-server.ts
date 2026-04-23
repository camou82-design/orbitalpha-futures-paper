import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3000;
const DATA_DIR = path.join(__dirname, '../../data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

function readJsonFile(filePath: string) {
    if (!fs.existsSync(filePath)) return { error: 'File not found', path: filePath };
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        return { error: 'Failed to parse JSON', path: filePath };
    }
}

function readJsonlRecent(filePath: string, limit = 10) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        return lines.slice(-limit).reverse().map(line => JSON.parse(line));
    } catch (e) {
        return [];
    }
}

const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/engine-state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readJsonFile(path.join(REPORTS_DIR, 'engine-state.json')), null, 2));
    } else if (url === '/snapshot') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readJsonFile(path.join(SNAPSHOTS_DIR, 'latest.json')), null, 2));
    } else if (url === '/meta') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readJsonFile(path.join(SNAPSHOTS_DIR, 'latest-meta.json')), null, 2));
    } else if (url === '/recent-decisions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readJsonlRecent(path.join(REPORTS_DIR, 'decisions.jsonl')), null, 2));
    } else if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    } else if (url === '/') {
        const engineState = readJsonFile(path.join(REPORTS_DIR, 'engine-state.json'));
        const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OrbitAlpha Paper Engine Local Dashboard</title>
    <style>
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
        h1 { color: #38bdf8; margin-top: 0; }
        h2 { color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
        .value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; }
        .status-ok { color: #4ade80; }
        .status-warn { color: #facc15; }
        .status-error { color: #f87171; }
        pre { background: #020617; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px; border: 1px solid #1e293b; }
        .nav { margin-bottom: 20px; display: flex; gap: 10px; }
        .nav a { color: #38bdf8; text-decoration: none; font-size: 0.875rem; }
        .nav a:hover { text-decoration: underline; }
        .refresh { font-size: 0.75rem; color: #64748b; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>OrbitAlpha Paper Engine</h1>
        <div class="nav">
            <a href="/engine-state">/engine-state</a>
            <a href="/snapshot">/snapshot</a>
            <a href="/meta">/meta</a>
            <a href="/recent-decisions">/recent-decisions</a>
        </div>
        
        <div class="grid">
            <div class="card">
                <h2>Exchange Configuration</h2>
                <div class="value">${engineState.exchange || 'N/A'}</div>
                <div style="margin-top:10px;">
                    <span class="${engineState.okx_demo_keys_loaded ? 'status-ok' : 'status-error'}">
                        Keys Loaded: ${engineState.okx_demo_keys_loaded}
                    </span><br/>
                    <span class="${engineState.okx_signed_rest_ready ? 'status-ok' : 'status-error'}">
                        Signed Ready: ${engineState.okx_signed_rest_ready}
                    </span>
                </div>
            </div>
            <div class="card">
                <h2>Engine State</h2>
                <div class="value">${engineState.strategy_executor || 'N/A'}</div>
                <div style="margin-top:10px;">
                    Regime: ${engineState.current_regime || 'N/A'}<br/>
                    Status: <span class="status-ok">${engineState.engine_status || 'N/A'}</span>
                </div>
            </div>
            <div class="card">
                <h2>Entry Permission</h2>
                <div>
                    Long: <span class="${engineState.entryAllowedLong ? 'status-ok' : 'status-error'}">${engineState.entryAllowedLong}</span><br/>
                    Short: <span class="${engineState.entryAllowedShort ? 'status-ok' : 'status-error'}">${engineState.entryAllowedShort}</span>
                </div>
                <div style="margin-top:10px; font-size: 0.75rem; color: #94a3b8;">
                    Adaptive Mode: ${engineState.adaptiveMode || 'N/A'}
                </div>
            </div>
        </div>

        <div class="card">
            <h2>Recent Symbol Decisions</h2>
            <pre>${JSON.stringify(engineState.symbol_decisions, null, 2)}</pre>
        </div>

        <div class="refresh">
            Last Updated: ${new Date(engineState.generatedAt || Date.now()).toLocaleString()}
            <button onclick="location.reload()" style="margin-left:10px; background: #38bdf8; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Refresh</button>
        </div>
    </div>
</body>
</html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

server.listen(PORT, () => {
    console.log(`[LOCAL WEB] Server running at http://localhost:${PORT}`);
    console.log(`[LOCAL WEB] Monitoring directory: ${REPORTS_DIR}`);
});
