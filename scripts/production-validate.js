const http = require("http");
const { execSync } = require("child_process");

/**
 * Production Validation Script (Kodari Standard - Linux/Debian)
 * Checks: 
 * 1. PM2 process status (online)
 * 2. Listening ports (ss -nlt actual socket check)
 * 3. Health check (Internal loopback)
 * 4. Data/Status API response (Logic validation)
 */

const CONFIG = {
    apps: [
        {
            name: "lightsail-futures-paper-api",
            port: 3991,
            health: "/health",
            data: "/api/futures-paper/data"
        },
        {
            name: "orbitalpha-trading-api",
            port: 8787,
            health: "/api/v1/health",
            data: "/api/v1/trade/status"
        },
        {
            name: "orbitalpha-trading-dashboard",
            port: 3010,
            health: "/",
            data: "/login"
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
        // Debian/Linux: ss -nlt | grep ":PORT "
        const cmd = `ss -nlt | grep ":${port} "`;
        const out = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"] }).toString();
        return out.includes(`:${port}`);
    } catch {
        return false;
    }
}

async function validate() {
    console.log("=== ORBITALPHA PRODUCTION VALIDATION (LINUX/DEBIAN) ===");
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

        // 2. Port listening
        if (checkPortListingLinux(app.port)) {
            console.log(`  [OK] Port ${app.port} is LISTENING (ss check)`);
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

        // 4. Data API / Logic check
        const data = await checkUrl(app.port, app.data);
        // 200 (Dashboard), 401 (API Auth needed), 403 (Forbidden) are all "Logic Active" signals.
        if (data.status === 200 || data.status === 401 || data.status === 403) {
            console.log(`  [OK] Data/Status API responded: ${data.status} (Logic active)`);
        } else {
            console.error(`  [FAIL] Data/Status API failed: ${data.status}`);
            allOk = false;
        }
    }

    console.log("\n-------------------------------------------");
    if (allOk) {
        console.log("FINAL STATUS: ALL SYSTEMS NORMAL (LINUX)");
        process.exit(0);
    } else {
        console.log("FINAL STATUS: CRITICAL FAILURES DETECTED");
        process.exit(1);
    }
}

validate();
