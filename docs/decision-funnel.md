# decision_funnel 카운트 정의

엔진은 **매 틱** 심볼별 의사결정(`PaperSymbolDecisionRecord`)을 만든 뒤, `src/engine/decision-funnel.ts`의 `computeFunnelTick()`으로 **퍼널 스냅샷**을 집계합니다.  
`reports/engine-state.json`에는 다음이 들어갑니다.

| 필드 | 의미 |
|------|------|
| `decision_funnel_tick` | **이번 틱** 집계 |
| `decision_funnel_50` | 최근 최대 50틱의 `decision_funnel_tick`을 **항목별 합(sum)** 한 값 (비영속 링 버퍼) |
| `decision_funnel_50_size` | 위 누적에 실제로 포함된 틱 수 (1…50) |

`reject_reason_counts_tick`은 퍼널과 별도로, `final_decision !== ENTER` 이고 `reject_reason != null` 인 심볼만 이유 코드별로 센 맵입니다.

---

## 한 틱(`decision_funnel_tick`)의 각 카운트

집계 단위는 **심볼 하나**입니다. 심볼 집합(예: BTC, ETH)에 대해 아래 조건을 만족하면 해당 카운트에 **+1** 합니다.  
조건들은 **서로 독립**입니다. “이전 단계를 통과한 심볼만 다음 단계를 센다”가 **아닙니다**.

| 키 | 조건 (해당 심볼이면 +1) |
|----|-------------------------|
| `raw_signal_count` | `signal_state !== "NONE"` (롱/숏 후보가 있는 경우) |
| `regime_pass_count` | `regime_state` 가 `"TREND"` 또는 `"RANGE"` |
| `edge_pass_count` | `edge_state === "PASS"` |
| `risk_pass_count` | `risk_state === "PASS"` 또는 `"SOFT_BLOCK"` |
| `execution_ready_count` | `execution_state === "PAPER_READY"` 또는 `"IDLE"` |
| `ai_pass_count` | 해당 심볼 평가에서 `aiGatePassed === true` |
| `enter_count` | `final_decision === "ENTER"` |

파이프라인 **순서**는 DATA → SIGNAL → REGIME → … 와 같지만, **집계 숫자는 “단계별로 줄어드는 퍼널”이 아니라, 각 단계 조건을 만족하는 심볼 수**입니다.

---

## 자주 헷갈리는 점

1. **`regime_pass_count`는 “레짐 게이트 통과”가 아님**  
   현재 구현은 `regime_state`가 TREND/RANGE인 심볼 수입니다. 시장 레짐이 NO_TRADE여도 심볼별 `regime_state` 표현과 조합에 따라 수치가 달라질 수 있습니다.

2. **단조(왼쪽 ≥ 오른쪽)가 항상 성립하지 않음**  
   예: 신호는 있는데(`raw_signal_count`에 포함) 레짐이 NO_TRADE면 `regime_pass_count`에는 잡히지 않을 수 있어,  
   `raw_signal_count ≥ regime_pass_count ≥ … ≥ enter_count` 같은 **부등식이 항상 맞지는 않습니다.**  
   이는 버그가 아니라 **정의상 독립 조건 합**이기 때문입니다.

3. **`decision_funnel_50`은 “50번의 틱 합”**  
   틱마다 위 규칙으로 나온 카운트를 **더한 것**입니다. “50틱 동안 한 번이라도 지나간 심볼” 같은 **유니크 카운트가 아닙니다.**

4. **모니터 표시 순서**  
   UI/로그에서 보여 주는 순서(신호 → 레짐 → 엣지 → …)는 **해석 편의**이며, 수학적 포함 관계를 보장하지 않습니다.

---

## 관련 코드

- `computeFunnelTick`, `sumDecisionFunnelTicks`: `src/engine/decision-funnel.ts`
- 링 버퍼 및 `engine-state` 기록: `src/engine/paper-engine.ts`

---

## 단조 감소 검사 스크립트

`scripts/check_funnel_monotonic.py`는 위 부등식 체인을 **선택적으로** 검사합니다.  
현재 정의에서는 위반이 **정상적으로 발생할 수 있으므로**, CI에서는 `--strict` 사용 여부를 정하세요.
