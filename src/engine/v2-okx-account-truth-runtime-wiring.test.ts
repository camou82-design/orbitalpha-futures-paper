import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { OkxAccountTruthScheduler } from "../lib/okxAccountTruthScheduler";
import type { OkxDemoClient } from "../exchange/okx-demo";
import { saveOkxAccountTruthCursor, readOkxAccountTruthCursor } from "../storage/account-truth-store";

function createMockOkxClient(options: {
  fills?: Array<Record<string, unknown>>;
  shouldThrow?: boolean;
  delayMs?: number;
}): {
  client: OkxDemoClient;
  callLog: Array<{ method: string; args: unknown }>;
} {
  const callLog: Array<{ method: string; args: unknown }> = [];

  const mockClient = {
    getFillsHistory: async (args?: unknown) => {
      callLog.push({ method: "getFillsHistory", args });
      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (options.shouldThrow) {
        throw new Error("MOCK_OKX_NETWORK_FAILURE");
      }
      return {
        ok: true,
        value: options.fills ?? [],
        diagnostics: { httpStatus: 200, requestUrl: "/api/v5/trade/fills-history" }
      };
    },
    submitOrder: async () => {
      callLog.push({ method: "submitOrder", args: null });
      throw new Error("UNEXPECTED_ORDER_SUBMIT");
    },
    cancelOrder: async () => {
      callLog.push({ method: "cancelOrder", args: null });
      throw new Error("UNEXPECTED_ORDER_CANCEL");
    }
  } as unknown as OkxDemoClient;

  return { client: mockClient, callLog };
}

test("PHASE 13D-2: OKX Account Truth Runtime Wiring & Scheduler Test Suite", async (t) => {
  // 1. startup/cursor 없음 -> sync 실행 가능
  await t.test("1. startup/cursor 없음 -> sync 실행 가능", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-1-"));
    try {
      const { client, callLog } = createMockOkxClient({ fills: [] });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      const triggered = scheduler.triggerIfDue(1000);
      assert.equal(triggered, true);

      // Wait a tick for async background promise
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(callLog.length, 1);
      assert.equal(callLog[0].method, "getFillsHistory");
      const args = callLog[0].args as { begin?: string };
      // With no cursor and now=1000, begin is around 1000 - 7*24*3600*1000 (bootstrap)
      assert.ok(args && typeof args.begin === "string");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 2. 60초 미만 -> 재호출 안 됨
  await t.test("2. 60초 미만 -> 재호출 안 됨", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-2-"));
    try {
      const { client, callLog } = createMockOkxClient({ fills: [] });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      // T = 10,000ms -> Trigger 1 (Success)
      const trig1 = scheduler.triggerIfDue(10_000);
      assert.equal(trig1, true);
      await new Promise((r) => setTimeout(r, 20));

      // T = 25,000ms (+15s engine tick) -> Must skip
      const trig2 = scheduler.triggerIfDue(25_000);
      assert.equal(trig2, false);

      // T = 55,000ms (+45s) -> Must skip
      const trig3 = scheduler.triggerIfDue(55_000);
      assert.equal(trig3, false);

      assert.equal(callLog.length, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 3. 60초 경과 -> incremental sync 실행
  await t.test("3. 60초 경과 -> incremental sync 실행", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-3-"));
    try {
      const { client, callLog } = createMockOkxClient({ fills: [] });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      // T = 0 -> Trigger 1
      scheduler.triggerIfDue(0);
      await new Promise((r) => setTimeout(r, 20));

      // T = 60,001ms -> Trigger 2
      const trig2 = scheduler.triggerIfDue(60_001);
      assert.equal(trig2, true);
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(callLog.length, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 4. sync in-flight -> 중복 호출 안 됨
  await t.test("4. sync in-flight -> 중복 호출 안 됨", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-4-"));
    try {
      // 100ms slow response
      const { client, callLog } = createMockOkxClient({ fills: [], delayMs: 100 });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      // T = 0 -> Start sync 1 (in-flight)
      const trig1 = scheduler.triggerIfDue(0);
      assert.equal(trig1, true);
      assert.equal(scheduler.isSyncInFlight(), true);

      // T = 65,000ms (even if time is past 60s, in-flight guard must block)
      const trig2 = scheduler.triggerIfDue(65_000);
      assert.equal(trig2, false);

      // Wait for completion
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(scheduler.isSyncInFlight(), false);
      assert.equal(callLog.length, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 5. sync reject -> engine path에 throw 안 됨
  await t.test("5. sync reject -> engine path에 throw 안 됨", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-5-"));
    try {
      let loggedError = false;
      const mockLogger = {
        info: () => {},
        warn: () => {},
        error: (msg: string) => {
          if (msg.includes("OKX_ACCOUNT_TRUTH_SYNC_ERROR")) loggedError = true;
        }
      };

      const { client } = createMockOkxClient({ shouldThrow: true });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000,
        logger: mockLogger
      });

      // triggerIfDue must return boolean without throwing
      assert.doesNotThrow(() => {
        const triggered = scheduler.triggerIfDue(1000);
        assert.equal(triggered, true);
      });

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(scheduler.isSyncInFlight(), false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 6. 실패 후 다음 interval에 재시도 가능
  await t.test("6. 실패 후 다음 interval에 재시도 가능", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-6-"));
    try {
      const { client, callLog } = createMockOkxClient({ shouldThrow: true });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      // T = 0 (Fail)
      scheduler.triggerIfDue(0);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(scheduler.isSyncInFlight(), false);

      // T = 60,001 (Retry)
      const retried = scheduler.triggerIfDue(60_001);
      assert.equal(retried, true);
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(callLog.length, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 7. cursor 존재 -> 7-day bootstrap 반복 안 됨
  await t.test("7. cursor 존재 -> 7-day bootstrap 반복 안 됨", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-7-"));
    try {
      const now = Date.now();
      const cursorTime = now - 3600_000; // 1 hour ago
      const expectedBegin = String(cursorTime - 5 * 60 * 1000);

      await saveOkxAccountTruthCursor(tmpDir, {
        lastFillTime: cursorTime,
        syncedAt: now
      });

      const { client, callLog } = createMockOkxClient({ fills: [] });
      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      scheduler.triggerIfDue(now);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(callLog.length, 1);
      const args = callLog[0].args as { begin?: string };
      // When cursor is 1 hour ago, begin = cursor - 5 min (NOT now - 7 days)
      assert.equal(args.begin, expectedBegin);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // 8. runtime wiring은 submit/cancel 함수를 호출하지 않음
  await t.test("8. runtime wiring은 submit/cancel 함수를 호출하지 않음", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-test-8-"));
    try {
      const { client, callLog } = createMockOkxClient({
        fills: [
          {
            instId: "BTC-USDT-SWAP",
            side: "buy",
            fillPx: "80000",
            fillSz: "1.0",
            fillTime: 100,
            ordId: "m1",
            clOrdId: ""
          },
          {
            instId: "BTC-USDT-SWAP",
            side: "sell",
            fillPx: "80500",
            fillSz: "1.0",
            fillTime: 200,
            ordId: "m2",
            clOrdId: ""
          }
        ]
      });

      const scheduler = new OkxAccountTruthScheduler({
        dataDir: tmpDir,
        client,
        syncIntervalMs: 60_000
      });

      scheduler.triggerIfDue(1000);
      await new Promise((r) => setTimeout(r, 60));

      const submitCalls = callLog.filter((c) => c.method === "submitOrder");
      const cancelCalls = callLog.filter((c) => c.method === "cancelOrder");

      assert.equal(submitCalls.length, 0);
      assert.equal(cancelCalls.length, 0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
