const http = require("http");
const { execSync } = require("child_process");

/**
 * Production Validation Script (Kodari Standard)
 * Checks: 
 * 1. PM2 process status
 * 2. Listening ports (actual netstat/lsof check)
 * 3. Health check (Internal & External loopback)
 * 4. Data API response
 */

const CONFIG = {
    apps: [
        {
            name: "lightsail-futures-paper-api",
            port: 3991,
            health: "/health",
            data: "/api/futures-paper/data",
            tokenHeader: "x-orbitalpha-futures-paper-token"
        },
        {
            name: "orbitalpha-trading-server",
            port: 8787,
            health: "/api/v1/health",
            data: "/api/v1/trade/status"
        }
    ]
};

async function checkUrl(port, path) {
    return new Promise((resolve) => {
        const options = {
            hostname: "127.0.0.1",
            port: port,
            path: path,
            method: "GET",
            timeout: 2000
        };
        const req = http.request(options, (res) => {
            resolve({ status: res.statusCode, ok: res.statusCode < 500 });
        });
        req.on("error", (e) => resolve({ status: 0, ok: false, error: e.message }));
        req.on("timeout", () => {
            req.destroy();
            resolve({ status: 0, ok: false, error: "timeout" });
        });
        req.end();
    });
}

function checkPort(port) {
    try {
        // Windows: netstat -ano | findstr :PORT
        const cmd = `netstat -ano | findstr :${port}`;
        const out = execSync(cmd).toString();
        return out.includes("LISTENING");
    } catch {
        return false;
    }
}

async function validate() {
    console.log("=== ORBITALPHA PRODUCTION VALIDATION (KODARI) ===");
    let allOk = true;

    for (const app of CONFIG.apps) {
        console.log(`\nChecking App: ${app.name}`);

        // 1. PM2 Status
        try {
            const pm2Out = execSync(`pm2 jlist`).toString();
            const list = JSON.parse(pm2Out);
            const proc = list.find(p => p.name === app.name);
            if (!proc) {
                console.error(`  [FAIL] PM2 process not found.`);
                allOk = false;
            } else if (proc.pm2_env.status !== "online") {
                console.error(`  [FAIL] PM2 state: ${proc.pm2_env.status}`);
                allOk = false;
            } else {
                console.log(`  [OK] PM2 state: online`);
            }
        } catch (e) {
            console.error(`  [WARN] Failed to read PM2 list: ${e.message}`);
        }

        // 2. Port listening
        if (checkPort(app.port)) {
            console.log(`  [OK] Port ${app.port} is LISTENING`);
        } else {
            console.error(`  [FAIL] Port ${app.port} is NOT listening (Actual socket check)`);
            allOk = false;
        }

        // 3. Health check
        const health = await checkUrl(app.port, app.health);
        if (health.ok) {
            console.log(`  [OK] Health check (${app.health}): ${health.status}`);
        } else {
            console.error(`  [FAIL] Health check (${app.health}) failed: ${health.error || health.status}`);
            allOk = false;
        }

        // 4. Data API (Basic check)
        const data = await checkUrl(app.port, app.data);
        if (data.status === 401 || data.status === 200 || data.status === 403) {
            console.log(`  [OK] Data API responded: ${data.status} (Logic active)`);
        } else {
            console.error(`  [FAIL] Data API unreachable or 500: ${data.status}`);
            allOk = false;
        }
    }

    console.log("\n-------------------------------------------");
    if (allOk) {
        console.log("FINAL STATUS: ALL SYSTEMS NORMAL");
        process.exit(0);
    } else {
        console.log("FINAL STATUS: CRITICAL FAILURES DETECTED");
        process.exit(1);
    }
}

validate();
