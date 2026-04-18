const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * Production Validation Script (Kodari Standard - Futures Paper ONLY)
 * Checks: 
 * 1. PM2 process status (online)
 * 2. Listening ports (ss -nlt for API)
 * 3. Health check (Internal loopback)
 * 4. Data/Status API response (Logic validation)
 * 5. Report file freshness (Loop validation)
 */

const CONFIG = {
    apps: [
        {
            name: "lightsail-futures-paper-api",
            type: "api",
            port: 3991,
            health: "/health",
            data: "/api/futures-paper/data"
        },
        {
            name: "orbitalpha-futures-paper-loop",
            type: "loop",
            reportPath: "reports/summary.json"
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
            timeout: 3000
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

function checkPortListingLinux(port) {
    try {
        const cmd = `ss -nlt | grep ":${port} "`;
        const out = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"] }).toString();
        return out.includes(`:${port}`);
    } catch {
        return false;
    }
}

async function validate() {
    console.log("=== ORBITALPHA FUTURES PRODUCTION VALIDATION (KODARI) ===");
    let allOk = true;

    for (const app of CONFIG.apps) {
        console.log(`\nChecking App: ${app.name}`);

        // 1. PM2 Status
        try {
            const pm2Out = execSync(`pm2 jlist`).toString();
            const list = JSON.parse(pm2Out);
            const proc = list.find(p => p.name === app.name);
            if (!proc) {
                console.error(`  [FAIL] PM2 process '${app.name}' not found.`);
                allOk = false;
                continue;
            }
            const status = proc.pm2_env.status;
            if (status !== "online") {
                console.error(`  [FAIL] PM2 state: ${status}`);
                allOk = false;
            } else {
                console.log(`  [OK] PM2 state: online`);
            }
        } catch (e) {
            console.error(`  [FAIL] Failed to read PM2 list: ${e.message}`);
            allOk = false;
        }

        if (app.type === "api") {
            // 2. Port listening
            if (checkPortListingLinux(app.port)) {
                console.log(`  [OK] Port ${app.port} is LISTENING (ss check)`);
            } else {
                console.error(`  [FAIL] Port ${app.port} is NOT listening`);
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

            // 4. Data API / Logic check
            const data = await checkUrl(app.port, app.data);
            if (data.status === 200 || data.status === 401 || data.status === 403) {
                console.log(`  [OK] Data API responded: ${data.status} (Logic active)`);
            } else {
                console.error(`  [FAIL] Data API failed: ${data.status}`);
                allOk = false;
            }
        }

        if (app.type === "loop") {
            // 5. File Freshness Check
            try {
                const fullPath = path.resolve(process.cwd(), app.reportPath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    const ageMs = Date.now() - stats.mtimeMs;
                    const ageSec = Math.floor(ageMs / 1000);
                    if (ageMs < 120000) { // 2 minutes
                        console.log(`  [OK] Report freshness: ${app.reportPath} updated ${ageSec}s ago`);
                    } else {
                        console.warn(`  [FAIL] Report is STALE: ${app.reportPath} was last updated ${ageSec}s ago`);
                        allOk = false;
                    }
                } else {
                    console.error(`  [FAIL] Report file NOT FOUND: ${app.reportPath}`);
                    allOk = false;
                }
            } catch (e) {
                console.error(`  [FAIL] File verification error: ${e.message}`);
                allOk = false;
            }
        }
    }

    console.log("\n-------------------------------------------");
    if (allOk) {
        console.log("FINAL STATUS: ALL SYSTEMS NORMAL (FUTURES)");
        process.exit(0);
    } else {
        console.log("FINAL STATUS: CRITICAL FAILURES DETECTED");
        process.exit(1);
    }
}

validate();
