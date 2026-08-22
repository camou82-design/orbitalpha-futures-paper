import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateRiskControls } from "../engine/risk-control-layer";
import type { EngineConfig } from "../models/types";

function getMockConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
    return {
        symbols: ["BTCUSDT"],
        paperDailyLossLimitUsd: 1000,
        paperLast10NetDegradeThresholdUsd: 500,
        paperDegradeSizeMultiplier: 0.5,
        paperModeSuspendMs: 15 * 60 * 1000,
        paperModeHardSuspendMs: 1_200_000,
        paperModeLossStreakSoftCount: 3,
        paperModeLossStreakSuspendCount: 7,
        ...overrides
    } as any;
}

function pass(name: string, details?: any) {
    console.log(`[RISK-WIRING-TEST][${name}] PASS`, details ? `— ${JSON.stringify(details)}` : "");
}

async function runTests() {
    console.log("=== STARTING RISK CONTROL REGIME WIRING REGRESSION SUITE ===");

    const now = Date.now();
    const config = getMockConfig();

    // Test 1: Production Artifact Wiring Contract Assertion on dist/engine/paper-engine.js
    {
        const candidates = [
            path.resolve(__dirname, "paper-engine.js"),
            path.resolve(__dirname, "../../dist/engine/paper-engine.js"),
            path.resolve(__dirname, "paper-engine.ts"),
            path.resolve(__dirname, "../../src/engine/paper-engine.ts")
        ];

        const targetPath = candidates.find(p => fs.existsSync(p));
        assert.ok(targetPath, "Target paper-engine artifact file must exist");
        const fileContent = fs.readFileSync(targetPath, "utf-8");

        // 1. Assert boxBreakSide mapping in production code
        const hasUpperMapping = fileContent.includes('regimeDetected.boxBreakSide === "upper"') && fileContent.includes('"up"');
        const hasLowerMapping = fileContent.includes('regimeDetected.boxBreakSide === "lower"') && fileContent.includes('"down"');
        const hasNoneFallback = fileContent.includes('"none"');

        assert.ok(hasUpperMapping, "Production artifact must map regimeDetected.boxBreakSide === 'upper' -> 'up'");
        assert.ok(hasLowerMapping, "Production artifact must map regimeDetected.boxBreakSide === 'lower' -> 'down'");
        assert.ok(hasNoneFallback, "Production artifact must have 'none' fallback for boxBreakSide");

        // 2. Assert evaluateRiskControls call passes regimeExitRisk and mappedBoxBreakSide
        const hasRegimeExitRiskWiring = fileContent.includes("regimeExitRisk: regimeDetected.regimeExitRisk");
        const hasBoxBreakSideWiring = fileContent.includes("boxBreakSide: mappedBoxBreakSide");

        assert.ok(hasRegimeExitRiskWiring, "Production artifact must pass regimeExitRisk: regimeDetected.regimeExitRisk to evaluateRiskControls");
        assert.ok(hasBoxBreakSideWiring, "Production artifact must pass boxBreakSide: mappedBoxBreakSide to evaluateRiskControls");

        pass("TEST_1_PRODUCTION_ARTIFACT_WIRING_CONTRACT", {
            verifiedFile: path.basename(targetPath),
            upperMapping: true,
            lowerMapping: true,
            noneFallback: true,
            regimeExitRiskWired: true,
            boxBreakSideWired: true
        });
    }

    // Test 2: Range recovery bypass active when regimeExitRisk <= 0.55 and boxBreakSide == "none"
    {
        const priorState = {
            crashLockUntil: now + 60000,
            crashState: "CRASH_LOCK"
        } as any;

        const decision = evaluateRiskControls({
            config,
            now,
            history: [],
            priorState,
            globalCandles: [],
            rangeConfidence: 0.8,
            regimeExitRisk: 0.3,
            boxBreakSide: "none"
        });

        assert.equal(decision.detail.crash_lock_range_recovery_bypass_active, true);
        assert.equal(decision.crashState, "NONE");
        pass("TEST_2_RANGE_RECOVERY_BYPASS_WITH_LOW_EXIT_RISK", {
            bypassActive: decision.detail.crash_lock_range_recovery_bypass_active,
            crashState: decision.crashState
        });
    }

    // Test 3: Range recovery bypass blocked when regimeExitRisk > 0.55
    {
        const priorState = {
            crashLockUntil: now + 60000,
            crashState: "CRASH_LOCK"
        } as any;

        const decision = evaluateRiskControls({
            config,
            now,
            history: [],
            priorState,
            globalCandles: [],
            rangeConfidence: 0.8,
            regimeExitRisk: 0.7, // > 0.55
            boxBreakSide: "none"
        });

        assert.equal(decision.detail.crash_lock_range_recovery_bypass_active, false);
        assert.equal(decision.crashState, "CRASH_LOCK");
        pass("TEST_3_RANGE_RECOVERY_BLOCKED_WHEN_HIGH_EXIT_RISK", {
            bypassActive: decision.detail.crash_lock_range_recovery_bypass_active,
            crashState: decision.crashState
        });
    }

    // Test 4: Range recovery bypass blocked when boxBreakSide is "down" (from "lower") or "up" (from "upper")
    {
        const priorState = {
            crashLockUntil: now + 60000,
            crashState: "CRASH_LOCK"
        } as any;

        const decisionDown = evaluateRiskControls({
            config,
            now,
            history: [],
            priorState,
            globalCandles: [],
            rangeConfidence: 0.8,
            regimeExitRisk: 0.2,
            boxBreakSide: "down" // mapped from "lower"
        });

        assert.equal(decisionDown.detail.crash_lock_range_recovery_bypass_active, false);
        assert.equal(decisionDown.crashState, "CRASH_LOCK");

        const decisionUp = evaluateRiskControls({
            config,
            now,
            history: [],
            priorState,
            globalCandles: [],
            rangeConfidence: 0.8,
            regimeExitRisk: 0.2,
            boxBreakSide: "up" // mapped from "upper"
        });

        assert.equal(decisionUp.detail.crash_lock_range_recovery_bypass_active, false);
        assert.equal(decisionUp.crashState, "CRASH_LOCK");

        pass("TEST_4_RANGE_RECOVERY_BLOCKED_ON_BOX_BREAK_SIDE", {
            downCrashState: decisionDown.crashState,
            upCrashState: decisionUp.crashState
        });
    }

    // Test 5: RegimeExitRisk size multiplier scaling
    {
        const decision = evaluateRiskControls({
            config,
            now,
            history: [],
            priorState: null,
            globalCandles: [],
            rangeConfidence: 0.8,
            regimeExitRisk: 0.3, // exitRiskScale = 0.7
            boxBreakSide: "none"
        });

        // longSizeMult and shortSizeMult should be scaled by 0.7
        assert.equal(Math.round(decision.longSizeMult * 100) / 100, 0.7);
        assert.equal(Math.round(decision.shortSizeMult * 100) / 100, 0.7);
        pass("TEST_5_REGIME_EXIT_RISK_SIZE_SCALING", {
            longSizeMult: decision.longSizeMult,
            shortSizeMult: decision.shortSizeMult
        });
    }

    console.log("=== ALL RISK CONTROL REGIME WIRING TESTS PASSED ===");
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
