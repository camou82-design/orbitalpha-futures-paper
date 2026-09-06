import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveAuthoritativeCandleTs,
  classifySubmitOutcome,
  SubmitOutcomeClass
} from "./paper-engine.js";

/** Helper to simulate execution key store across restarts */
class MockExecutionKeyStore {
  private consumed = new Set<string>();
  public diskPath: string;

  constructor(dataDir: string) {
    this.diskPath = path.join(dataDir, "reports", "execution-keys.json");
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.diskPath, "utf8");
      const parsed = JSON.parse(raw);
      for (const k of parsed.consumed ?? []) {
        if (typeof k === "string" && k.trim() !== "") this.consumed.add(k);
      }
    } catch {
      // empty
    }
  }

  async consume(key: string): Promise<boolean> {
    if (!key || key.trim() === "") return false;
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    await fs.mkdir(path.dirname(this.diskPath), { recursive: true });
    const consumedList = Array.from(this.consumed).slice(-4000);
    await fs.writeFile(this.diskPath, JSON.stringify({ updated_at: Date.now(), consumed: consumedList }, null, 2), "utf8");
    return true;
  }

  async release(key: string): Promise<void> {
    if (!key || key.trim() === "") return;
    this.consumed.delete(key);
    try {
      const consumedList = Array.from(this.consumed).slice(-4000);
      await fs.writeFile(this.diskPath, JSON.stringify({ updated_at: Date.now(), consumed: consumedList }, null, 2), "utf8");
    } catch {
      // ignore
    }
  }

  isConsumed(key: string): boolean {
    return this.consumed.has(key);
  }
}

/** Mock Ambiguous Submit Tracker simulating PaperEngine active ambiguous map */
class MockAmbiguousSubmitTracker {
  private active = new Map<string, { clOrdId: string; key: string; symbol: string }>();

  record(sym: string, clOrdId: string, key: string) {
    this.active.set(sym, { clOrdId, key, symbol: sym });
  }

  has(sym: string): boolean {
    return this.active.has(sym);
  }

  reconcileAgainstExchange(
    sym: string,
    queryResult: { ok: boolean; orders?: Array<{ clOrdId?: string }> }
  ): { action: "KEEP_CONSUMED_AND_BLOCK" | "RELEASE_KEY_AND_UNBLOCK" } {
    if (!this.active.has(sym)) {
      return { action: "RELEASE_KEY_AND_UNBLOCK" };
    }
    const current = this.active.get(sym)!;

    // If exchange query failed (e.g. timeout / network error / 500), NEVER assume absence!
    if (!queryResult.ok || !queryResult.orders) {
      return { action: "KEEP_CONSUMED_AND_BLOCK" };
    }

    // Exchange query succeeded: check if clOrdId exists
    const match = queryResult.orders.some(o => o.clOrdId === current.clOrdId);
    if (match) {
      // Order actually reached exchange and exists: KEEP key consumed, do NOT allow duplicate re-entry
      return { action: "KEEP_CONSUMED_AND_BLOCK" };
    } else {
      // Definitive proof of absence on exchange: release ambiguous state and key
      this.active.delete(sym);
      return { action: "RELEASE_KEY_AND_UNBLOCK" };
    }
  }
}

const isDefinitiveFailure = (outcome: string): boolean =>
  outcome === "DEFINITIVE_EXCHANGE_REJECTED" || outcome === "DEFINITIVE_NOT_SUBMITTED";

describe("V2 EXECUTION KEY RESTART-SAFE IDEMPOTENCY TESTS", () => {
  it("1. resolveAuthoritativeCandleTs reads envelope.authority.authoritativeCandleTs only (fail-closed)", () => {
    const ts1 = resolveAuthoritativeCandleTs({
      authority: { authoritativeCandleTs: 1788600000000 }
    });
    assert.equal(ts1, 1788600000000);

    // Candle array must NOT be used as fallback
    const tsNoFallback = resolveAuthoritativeCandleTs({
      authority: null
    });
    assert.equal(tsNoFallback, null, "Must return null when authority.authoritativeCandleTs is absent");

    const tsMissing = resolveAuthoritativeCandleTs({
      authority: { authoritativeCandleTs: undefined }
    });
    assert.equal(tsMissing, null, "Must return null when authoritativeCandleTs is undefined");
  });

  it("2. classifySubmitOutcome: OKX business reject vs true ambiguous transport failures", () => {
    // 2a. Definitive not submitted (pre-send local validation failure)
    const notSent = classifySubmitOutcome({ ok: false, errorCode: "price_build_fail", errorMessage: "Failed to construct cap price" });
    assert.equal(notSent, "DEFINITIVE_NOT_SUBMITTED");

    // 2b. Definitive exchange rejection (clear OKX validation / balance / parameter reject)
    const okxRejected = classifySubmitOutcome({ ok: false, errorCode: "51000", errorMessage: "Insufficient margin" });
    assert.equal(okxRejected, "DEFINITIVE_EXCHANGE_REJECTED");

    // 2c. Ambiguous: OKX JSON business response with uncertain server-processing outcome
    const okx50000 = classifySubmitOutcome({ ok: false, errorCode: "50000", errorMessage: "Internal server error" });
    assert.equal(okx50000, "AMBIGUOUS_SUBMIT_OUTCOME", "50000 Internal server error — no contract that order was not submitted");

    // 2d. Ambiguous: Timeout / Network error / HTTP 5xx (order might have reached exchange)
    const timeoutErr = classifySubmitOutcome({ ok: false, errorMessage: "ETIMEDOUT: Connection timed out" });
    assert.equal(timeoutErr, "AMBIGUOUS_SUBMIT_OUTCOME");

    const netErr = classifySubmitOutcome({ ok: false, errorMessage: "ECONNRESET socket hang up" });
    assert.equal(netErr, "AMBIGUOUS_SUBMIT_OUTCOME");

    const http502 = classifySubmitOutcome({ ok: false, errorMessage: "502 bad gateway" });
    assert.equal(http502, "AMBIGUOUS_SUBMIT_OUTCOME");

    const http503 = classifySubmitOutcome({ ok: false, errorMessage: "503 service unavailable" });
    assert.equal(http503, "AMBIGUOUS_SUBMIT_OUTCOME");

    const http504 = classifySubmitOutcome({ ok: false, errorMessage: "504 gateway timeout" });
    assert.equal(http504, "AMBIGUOUS_SUBMIT_OUTCOME");
  });

  it("3. 동일 authoritative candle + restart → key 완전 동일 / duplicate block", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-3-"));
    try {
      const proc1Store = new MockExecutionKeyStore(tmpDir);
      const candleTs = 1788655000000;
      const key1 = `v2entry:ETHUSDT:long:${candleTs}`;

      // Process 1 consumes key
      const claim1 = await proc1Store.consume(key1);
      assert.equal(claim1, true, "Process 1 must consume key");

      // Immediate restart replay of the exact same authoritative candleTs
      const proc2Store = new MockExecutionKeyStore(tmpDir);
      await proc2Store.loadFromDisk();

      const key2 = `v2entry:ETHUSDT:long:${candleTs}`;
      assert.equal(key1, key2, "Key generated after restart for same candle MUST be strictly equal");

      const claim2 = await proc2Store.consume(key2);
      assert.equal(claim2, false, "Replay of exact same candle decision after restart must be duplicate-blocked");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. 다음 authoritative candle → 새 key 허용", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-4-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const candle1Ts = 1788600000000;
      const candle2Ts = 1788600900000; // 15m later

      const key1 = `v2entry:BTCUSDT:long:${candle1Ts}`;
      const key2 = `v2entry:BTCUSDT:long:${candle2Ts}`;

      assert.notEqual(key1, key2, "Next candle must generate a distinct key");

      const claim1 = await store.consume(key1);
      assert.equal(claim1, true, "First candle entry claimed");

      const claim2 = await store.consume(key2);
      assert.equal(claim2, true, "Next candle entry with new authoritative timestamp must be allowed");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("5. authoritative candle timestamp 없음 → V2_EXECUTION_IDENTITY_UNAVAILABLE fail-closed", () => {
    const ts = resolveAuthoritativeCandleTs({ authority: null });
    assert.equal(ts, null, "Must resolve to null");

    // Verify engine fail-closed behavior simulation
    let executionAllowed = true;
    let blockReason = "";
    if (ts == null || ts <= 0) {
      executionAllowed = false;
      blockReason = "V2_EXECUTION_IDENTITY_UNAVAILABLE";
    }

    assert.equal(executionAllowed, false, "Execution must be blocked");
    assert.equal(blockReason, "V2_EXECUTION_IDENTITY_UNAVAILABLE");
  });

  it("6. definitive submit failure (local pre-submit / exchange reject) -> key released and retry succeeds", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-6-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const candleTs = 1788660000000;
      const key = `v2entry:BTCUSDT:short:${candleTs}`;

      // 1. Initial claim before submit
      const claimed = await store.consume(key);
      assert.equal(claimed, true, "Pre-submit claim succeeds");

      // 2. Submit fails with DEFINITIVE rejection (e.g. price_build_fail local pre-submit error)
      const submitResult = { ok: false, errorCode: "price_build_fail", errorMessage: "Failed to construct cap price" };
      const outcomeClass: SubmitOutcomeClass = classifySubmitOutcome(submitResult);
      assert.equal(outcomeClass, "DEFINITIVE_NOT_SUBMITTED");

      if (isDefinitiveFailure(outcomeClass)) {
        await store.release(key);
      }
      assert.equal(store.isConsumed(key), false, "Key must be released on definitive pre-submit failure");

      // 3. Next retry attempt for the same decision
      const retryClaim = await store.consume(key);
      assert.equal(retryClaim, true, "Legitimate retry after definitive failure must be allowed");
      assert.equal(store.isConsumed(key), true, "Key must remain consumed after retry");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("7. ambiguous timeout → execution key 유지 & 직후 동일 decision retry 차단", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-7-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const tracker = new MockAmbiguousSubmitTracker();
      const candleTs = 1788662000000;
      const sym = "ETHUSDT";
      const clOrdId = "cl_eth_123";
      const key = `v2entry:${sym}:short:${candleTs}`;

      // 1. Pre-claim
      const claimed = await store.consume(key);
      assert.equal(claimed, true);

      // 2. Submit encounters timeout (ambiguous)
      const submitResult = { ok: false, errorMessage: "ETIMEDOUT: Connection timed out" };
      const outcomeClass: SubmitOutcomeClass = classifySubmitOutcome(submitResult);
      assert.equal(outcomeClass, "AMBIGUOUS_SUBMIT_OUTCOME");

      if (isDefinitiveFailure(outcomeClass)) {
        await store.release(key);
      } else {
        tracker.record(sym, clOrdId, key);
      }

      // Key must REMAIN consumed
      assert.equal(store.isConsumed(key), true, "Key must NOT be released on ambiguous timeout");
      assert.equal(tracker.has(sym), true, "Symbol must be registered in ambiguous tracker");

      // 3. Immediate retry attempt is blocked both by key and by ambiguous pending state
      const retryClaim = await store.consume(key);
      assert.equal(retryClaim, false, "Retry blocked by consumed key");
      assert.equal(tracker.has(sym), true, "Retry blocked by ambiguous pending guard");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("8. OKX reconcile: 동일 clOrdId 발견 → key 유지 / 재주문 금지", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-8-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const tracker = new MockAmbiguousSubmitTracker();
      const sym = "BTCUSDT";
      const clOrdId = "cl_btc_ambig_1";
      const key = `v2entry:${sym}:long:1788665000000`;

      await store.consume(key);
      tracker.record(sym, clOrdId, key);

      // Reconcile query succeeds from exchange and finds the order
      const exchangeQueryResult = {
        ok: true,
        orders: [{ clOrdId: "cl_btc_ambig_1" }]
      };
      const reconcile = tracker.reconcileAgainstExchange(sym, exchangeQueryResult);
      assert.equal(reconcile.action, "KEEP_CONSUMED_AND_BLOCK");

      // Do NOT release key
      assert.equal(store.isConsumed(key), true, "Key must stay consumed when order exists on exchange");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("9. OKX reconcile: 정상조회 성공 + 동일 clOrdId 없음 확정 → key release / retry 허용", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-9-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const tracker = new MockAmbiguousSubmitTracker();
      const sym = "ETHUSDT";
      const clOrdId = "cl_eth_ambig_2";
      const key = `v2entry:${sym}:short:1788668000000`;

      await store.consume(key);
      tracker.record(sym, clOrdId, key);

      // Exchange query successfully returns list of pending/active orders, but clOrdId is NOT present
      const exchangeQueryResult = {
        ok: true,
        orders: []
      };
      const reconcile = tracker.reconcileAgainstExchange(sym, exchangeQueryResult);
      assert.equal(reconcile.action, "RELEASE_KEY_AND_UNBLOCK");

      // Release key as proven absent on exchange
      await store.release(key);
      assert.equal(store.isConsumed(key), false, "Key released upon confirmed exchange absence");

      // Retry is now permitted
      const retryClaim = await store.consume(key);
      assert.equal(retryClaim, true, "Retry must be allowed after confirmed absence release");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("10. OKX reconcile: 조회 자체 실패 또는 timeout → absence로 간주 금지 / key 유지", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-10-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const tracker = new MockAmbiguousSubmitTracker();
      const sym = "BTCUSDT";
      const clOrdId = "cl_btc_ambig_3";
      const key = `v2entry:${sym}:short:1788670000000`;

      await store.consume(key);
      tracker.record(sym, clOrdId, key);

      // Exchange query failed (timeout)
      const queryTimeout = { ok: false };
      const resTimeout = tracker.reconcileAgainstExchange(sym, queryTimeout);
      assert.equal(resTimeout.action, "KEEP_CONSUMED_AND_BLOCK", "Timeout must NEVER assume absence");
      assert.equal(store.isConsumed(key), true, "Key must remain consumed on query timeout");

      // Exchange query failed (network error)
      const queryNetErr = { ok: false };
      const resNetErr = tracker.reconcileAgainstExchange(sym, queryNetErr);
      assert.equal(resNetErr.action, "KEEP_CONSUMED_AND_BLOCK", "Network failure must NEVER assume absence");
      assert.equal(store.isConsumed(key), true, "Key must remain consumed on query network failure");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("11. BTC and ETH symmetry: different symbols with same candle timestamp never collide", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-exec-key-test-11-"));
    try {
      const store = new MockExecutionKeyStore(tmpDir);
      const commonTs = 1788675000000;

      const btcKey = `v2entry:BTCUSDT:long:${commonTs}`;
      const ethKey = `v2entry:ETHUSDT:long:${commonTs}`;

      assert.notEqual(btcKey, ethKey, "BTC and ETH keys must be distinct");

      const btcOk = await store.consume(btcKey);
      const ethOk = await store.consume(ethKey);

      assert.equal(btcOk, true, "BTC claim must succeed");
      assert.equal(ethOk, true, "ETH claim with same timestamp must succeed independently");

      assert.equal(await store.consume(btcKey), false, "Duplicate BTC blocked");
      assert.equal(await store.consume(ethKey), false, "Duplicate ETH blocked");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
