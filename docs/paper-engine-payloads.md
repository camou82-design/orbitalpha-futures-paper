# Paper engine: executor 필드 (스키마 메모)

`decision_funnel_tick` / `decision_funnel_50` 카운트 의미는 **[decision-funnel.md](./decision-funnel.md)** 를 참고하세요.

`executor` / `strategy_executor` / `executorAtEntry`는 **RANGE | TREND | IDLE** 만 사용합니다.  
레거시 로그·파일의 `NONE`은 런타임에서 **IDLE**로 정규화합니다.

## `reports/engine-state.json` (발췌)

```json
{
  "engine_mode": "PAPER_TEST",
  "execution_state": "PAPER_READY",
  "strategy_executor": "TREND",
  "decision_funnel_tick": {
    "raw_signal_count": 2,
    "regime_pass_count": 1,
    "edge_pass_count": 1,
    "risk_pass_count": 1,
    "execution_ready_count": 1,
    "ai_pass_count": 1,
    "enter_count": 0
  },
  "decision_funnel_50": {
    "raw_signal_count": 45,
    "regime_pass_count": 30,
    "edge_pass_count": 22,
    "risk_pass_count": 28,
    "execution_ready_count": 25,
    "ai_pass_count": 10,
    "enter_count": 2
  },
  "decision_funnel_50_size": 17,
  "symbol_decisions": {
    "BTCUSDT": {
      "decision": {
        "strategy_executor": "TREND",
        "execution_state": "PAPER_READY",
        "final_decision": "REJECT"
      }
    }
  }
}
```

## `reports/decisions.jsonl` (한 줄 예시)

```json
{"symbol":"BTCUSDT","strategy_executor":"RANGE","execution_state":"IDLE","final_decision":"SKIP","reject_reason":"REGIME_NO_TRADE"}
```

## `reports/events.jsonl` (EXIT 예시)

```json
{
  "type": "EXIT_SL",
  "symbol": "BTCUSDT",
  "regime": "NO_TRADE",
  "executor": "IDLE"
}
```

실패 원인은 `executor`가 아니라 `execution_state` / `reject_reason`(decision) / 이벤트 `reason` 등으로 구분합니다.
