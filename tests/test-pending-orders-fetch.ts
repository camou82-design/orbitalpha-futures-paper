import { PaperEngine, buildV2ConfigBridge, buildV2StateBridge } from "../src/engine/paper-engine";

function evaluatePendingBridgeLogic(engineMock: any) {
    const pendingFetchPerformed =
        engineMock.opsOrdersScanEverDone === true &&
        typeof engineMock.lastOpsOrdersScanAtMs === "number" &&
        engineMock.lastOpsOrdersScanAtMs > 0;

    const cachedOpsPendingIsArray = Array.isArray(engineMock.cachedOpsPending);
    const cachedOpsAlgosIsArray = Array.isArray(engineMock.cachedOpsAlgos);
    const pendingFetchErrorsCount = engineMock.cachedOpsFetchErrors ? engineMock.cachedOpsFetchErrors.length : 0;
    const cachedOpsPendingCount = cachedOpsPendingIsArray ? engineMock.cachedOpsPending.length : 0;
    const cachedOpsAlgosCount = cachedOpsAlgosIsArray ? engineMock.cachedOpsAlgos.length : 0;

    const pendingFetchReady =
        pendingFetchPerformed &&
        cachedOpsPendingIsArray &&
        cachedOpsAlgosIsArray &&
        pendingFetchErrorsCount === 0;

    const pendingPayloadEmpty =
        cachedOpsPendingCount === 0 &&
        cachedOpsAlgosCount === 0;

    const pendingOrdersExposureReady = pendingFetchReady && pendingPayloadEmpty;

    let authorityMode = "FETCH_NOT_READY";
    if (!pendingFetchPerformed) {
        authorityMode = "FETCH_NOT_READY";
    } else if (pendingFetchErrorsCount > 0 || !cachedOpsPendingIsArray || !cachedOpsAlgosIsArray) {
        authorityMode = "FETCH_ERROR";
    } else if (!pendingPayloadEmpty) {
        authorityMode = "NONEMPTY_PENDING_FAIL_CLOSED";
    } else if (pendingOrdersExposureReady) {
        authorityMode = "ZERO_PENDING_SAFE";
    }

    return {
        pendingOrdersExposureReady,
        accountPendingNotionalUsdt: 0,
        symbolPendingNotionalUsdt: 0,
        authorityMode
    };
}

async function runTests() {
    console.log("--- Starting Pending Orders Fetch Authority Unit Tests ---");

    let passCount = 0;
    let failCount = 0;

    function assertResult(testName: string, expected: any, actual: any) {
        let pass = true;
        for (const key of Object.keys(expected)) {
            if (expected[key] !== actual[key]) {
                pass = false;
                console.error(`[FAIL] ${testName}: Expected ${key}=${expected[key]}, got ${actual[key]}`);
            }
        }
        if (pass) {
            console.log(`[PASS] ${testName}`);
            passCount++;
        } else {
            failCount++;
        }
    }

    // Test A: 정상 빈 배열
    const stateA = {
        opsOrdersScanEverDone: true,
        lastOpsOrdersScanAtMs: 123456789,
        cachedOpsPending: [],
        cachedOpsAlgos: [],
        cachedOpsFetchErrors: []
    };
    assertResult("Test A: 정상 빈 배열", {
        pendingOrdersExposureReady: true,
        accountPendingNotionalUsdt: 0,
        symbolPendingNotionalUsdt: 0,
        authorityMode: "ZERO_PENDING_SAFE"
    }, evaluatePendingBridgeLogic(stateA));

    // Test B: 최초 fetch 전
    const stateB = {
        opsOrdersScanEverDone: false,
        lastOpsOrdersScanAtMs: null,
        cachedOpsPending: [],
        cachedOpsAlgos: [],
        cachedOpsFetchErrors: []
    };
    assertResult("Test B: 최초 fetch 전", {
        pendingOrdersExposureReady: false,
        authorityMode: "FETCH_NOT_READY"
    }, evaluatePendingBridgeLogic(stateB));

    // Test C: fetch error
    const stateC = {
        opsOrdersScanEverDone: true,
        lastOpsOrdersScanAtMs: 123456789,
        cachedOpsPending: [],
        cachedOpsAlgos: [],
        cachedOpsFetchErrors: ["network error"]
    };
    assertResult("Test C: fetch error", {
        pendingOrdersExposureReady: false,
        authorityMode: "FETCH_ERROR"
    }, evaluatePendingBridgeLogic(stateC));

    // Test D: pending 1건 존재
    const stateD = {
        opsOrdersScanEverDone: true,
        lastOpsOrdersScanAtMs: 123456789,
        cachedOpsPending: [{ ordId: "123", instId: "BTC-USDT-SWAP" }],
        cachedOpsAlgos: [],
        cachedOpsFetchErrors: []
    };
    assertResult("Test D: pending 1건 존재", {
        pendingOrdersExposureReady: false,
        accountPendingNotionalUsdt: 0,
        symbolPendingNotionalUsdt: 0,
        authorityMode: "NONEMPTY_PENDING_FAIL_CLOSED"
    }, evaluatePendingBridgeLogic(stateD));

    // Test E: algo 1건 존재
    const stateE = {
        opsOrdersScanEverDone: true,
        lastOpsOrdersScanAtMs: 123456789,
        cachedOpsPending: [],
        cachedOpsAlgos: [{ algoId: "456", instId: "ETH-USDT-SWAP" }],
        cachedOpsFetchErrors: []
    };
    assertResult("Test E: algo 1건 존재", {
        pendingOrdersExposureReady: false,
        accountPendingNotionalUsdt: 0,
        symbolPendingNotionalUsdt: 0,
        authorityMode: "NONEMPTY_PENDING_FAIL_CLOSED"
    }, evaluatePendingBridgeLogic(stateE));

    console.log(`=== RESULTS: ${passCount} PASSED, ${failCount} FAILED ===`);
}

runTests().catch(console.error);
