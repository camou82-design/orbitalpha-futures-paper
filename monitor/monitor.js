(function () {
  "use strict";

  const STORAGE_TOKEN = "orbitalpha_futures_paper_monitor_token";
  const STORAGE_BASE = "orbitalpha_futures_paper_monitor_base";

  const REASON_LABELS = {
    last7d_pnl_negative: "최근 7일 손익 부진",
    last30d_win_rate_low: "최근 30일 승률 낮음",
    fee_drag_high: "수수료 부담 높음",
    funding_drag_high: "펀딩 부담 높음",
    trade_count_too_small: "거래 수 부족",
    no_recent_trades: "최근 거래 없음"
  };

  const STATUS_LABELS = {
    healthy: "정상",
    weak: "약세",
    cold: "최근 거래 없음",
    "insufficient-data": "표본 부족"
  };

  const MODE_LABELS = {
    trend: "추세장",
    sideways: "횡보장",
    risk_off: "위험회피 구간",
    TREND: "TREND",
    RANGE: "RANGE",
    NO_TRADE: "NO_TRADE"
  };

  const ENTRY_BLOCK_LABELS = {
    fee_slippage_insufficient: "수수료·슬리피지 대비 기대수익 부족",
    range_center_forbidden: "RANGE 중앙 구간",
    range_cooldown_active: "RANGE 연속 실패 쿨다운",
    mode_suspended: "동일 모드 연속 손실로 일시 중단",
    daily_loss_limit_exceeded: "일일 손실 제한 발동",
    no_trade_regime: "NO_TRADE 구간",
    trend_need_breakout_or_pullback: "TREND 돌파/눌림 확인 부족",
    trend_direction_weak: "TREND 방향성 미약",
    trend_volume_too_thin: "거래 강도(볼륨) 부족",
    AI_FILTER: "AI 차단",
    AI_REJECT: "AI 거부",
    AI_LOW_CONFIDENCE: "AI 신뢰도 낮음",
    ADAPTIVE_REJECT: "적응형 거부",
    AI_DIRECTION_MISMATCH: "방향 불일치",
    EDGE_FAIL_FEE: "수수료 불리",
    EDGE_FAIL_RR: "손익비 부족",
    EDGE_FAIL_LOW_VOL: "변동성 부족",
    EDGE_FAIL_EXPECTANCY: "기대값 부족",
    REGIME_NO_TRADE: "레짐 제외",
    REGIME_UNKNOWN: "레짐 불명",
    RISK_COOLDOWN: "쿨다운",
    RISK_FAIL_REENTRY: "재진입 제한",
    RISK_LOSS_STREAK: "연속 손실",
    RISK_MAX_DRAWDOWN: "일일 손실 한도",
    DATA_NOT_READY: "데이터 부족",
    ORDER_BUILD_FAIL: "주문 생성 실패",
    EXECUTOR_INIT_FAIL: "실행기 초기화 실패",
    EXECUTION_DISABLED: "실행 비활성",
    LONG_ONLY_SHORT_DEFERRED: "Long Only·숏 보류(RANGE S1)",
    SIGNAL_NONE: "신호 없음",
    LEGACY_BLOCKED: "기타 차단"
  };

  /** V2 무진입 감사 한글 레이블 (로그 코드 → 운영자용 문장). */
  const NO_ENTRY_STALE_MS = 3 * 60 * 1000;

  const NO_ENTRY_EXPECTED_MISSING_KO = {
    SHOCK_REACTION_WATCH_MID_CHASE_BLOCKED: "상승/하락 충격 후 중간 구간 추격 진입 차단",
    CHASE_BLOCKED_RANGE_MID_ZONE: "횡보 중단 구간에서 추격 진입 차단",
    CHASE_BLOCKED_SHOCK_WATCH: "충격 감시 구간 추격 차단",
    SHOCK_UP_MID_RETEST_REQUIRED: "상승 충격 후 중간 구간이라 리테스트 확인 대기",
    SHOCK_DOWN_MID_RETEST_REQUIRED: "하락 충격 후 중간 구간이라 리테스트 확인 대기",
    SHOCK_UP_RECLAIM_NOT_CONFIRMED: "상승 재돌파 후 지지 재확인 미완료",
    SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "하락 이탈 후 리테스트 실패 확인 미완료",
    SHOCK_REACTION_UP_RETEST_NOT_CONFIRMED: "상승 충격 후 리테스트 미확인",
    SHOCK_REACTION_DOWN_RETEST_NOT_CONFIRMED: "하락 충격 후 리테스트 미확인",
    SHOCK_UP_TREND_CONFIRMATION_WEAK: "상승 충격 대응 후 추세 확인이 아직 약함",
    SHOCK_DOWN_TREND_CONFIRMATION_WEAK: "하락 충격 대응 후 추세 확인이 아직 약함",
    MIN_QUALITY_NOT_MET: "진입 품질 점수 부족",
    TREND_ENTRY_NOT_PROMOTED: "추세 후보는 있으나 V2 승격 조건 미충족",
    TREND_CANDIDATE_NOT_PROMOTED_DETAIL: "추세 후보 미승격(세부 진행 중)",
    TREND_PROMOTION_BLOCKED_HTF_DATA_NOT_READY: "HTF 데이터 준비 부족(60틱 미만)",
    TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "추세 승격 차단: 진입 품질 점수가 기준 미만",
    TREND_PROMOTION_BLOCKED_QUALITY: "진입 품질 점수 미달",
    TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKOUT_CONFIRMED: "박스 상단: 돌파 후 지지 재확인 필요",
    TREND_PROMOTION_BLOCKED_RANGE_ZONE_NOT_BREAKDOWN_CONFIRMED: "박스 하단: 이탈 후 저항 재확인 필요",
    TREND_PROMOTION_BLOCKED_BREAKOUT_RETEST_NOT_CONFIRMED: "돌파 후 리테스트 확인 미완료",
    TREND_PROMOTION_BLOCKED_SUPPORT_RECHECK_REQUIRED: "지지 구간 재확인 필요",
    RECOVERY_MODE_SIZE_SUPPRESSED: "연속 손실 복구 모드로 신규 진입 사이즈 억제",
    TWO_CONSECUTIVE_LOSSES_RECOVERY_MODE: "연속 손실 이후 복구 모드 적용 중",
    SIDE_NONE_AFTER_VETO: "후처리 거부 후 유효 방향 없음",
    RANGE_TREND_SIDE_CONFLICT: "레인지 후보와 추세 후보 방향 충돌",
    STOP_PRICE_MISSING: "보호 스톱 가격 미충족(차단)",
    V2_HOLD_NO_ENTRY_SIDE: "V2 HOLD — 진입 방향 미확정",
    UNKNOWN_HOLD_REASON: "세부 무진입 원인 불명(HOLD)",
    ALL_GATES_HEALTHY_NO_ENTER: "게이트는 통과했으나 진입 확정 신호 부족"
  };

  const NO_ENTRY_NEXT_ACTION_KO = {
    WAIT_FOR_RETEST_OR_RECLAIM_CONFIRMATION: "리테스트 / 지지 재확인 대기",
    WAIT_FOR_BREAKDOWN_RETEST_FAILURE: "하락 이탈 후 리테스트 결과 대기",
    WAIT_FOR_VALID_SIDE_CONFIRMATION: "유효 방향 재확인 대기",
    WAIT_FOR_RECOVERY_MODE_CLEAR_OR_HIGH_CONFIDENCE_RETEST:
      "복구 모드 해제 또는 고신뢰 리테스트 대기",
    WAIT_FOR_VALID_ENTRY_SIGNAL: "진입 신호 재확인 대기",
    EXECUTE_V2_AUTHORITY: "V2 권위 실행 단계",
    PLAN_TO_ENTER: "진입 검토 계획",
    PLAN_TO_HOLD: "보유 유지 검토",
    WAIT_FOR_HTF_DATA_READY: "HTF 데이터 안정 대기",
    WAIT_FOR_BREAKOUT_RETEST_SUPPORT_CONFIRM: "돌파 후 지지 전환 확인 대기",
    WAIT_FOR_BREAKDOWN_RETEST_RESISTANCE_CONFIRM: "이탈 후 저항 전환 확인 대기",
    NONE: "—"
  };

  const NO_ENTRY_SIDE_VETO_KO = {
    SHOCK_UP_MID_RETEST_REQUIRED: "상승 충격 후 중간 구간이라 리테스트 확인 대기",
    SHOCK_DOWN_MID_RETEST_REQUIRED: "하락 충격 후 중간 구간이라 리테스트 확인 대기",
    SHOCK_UP_RECLAIM_NOT_CONFIRMED: "상승 재돌파 후 지지 재확인 미완료",
    SHOCK_DOWN_BREAKDOWN_RETEST_NOT_CONFIRMED: "하락 이탈 후 리테스트 실패 확인 미완료",
    TREND_PROMOTION_BLOCKED_QUALITY_BELOW_THRESHOLD: "추세 승격 차단: 품질 미달",
    TREND_CANDIDATE_NOT_PROMOTED_DETAIL: "추세 후보 미승격(세부)",
    RECOVERY_MODE_SIZE_SUPPRESSED: "복구 모드로 사이즈 억제",
    RANGE_TREND_SIDE_CONFLICT: "레인지·추세 방향 충돌"
  };

  const NO_ENTRY_MARKET_SUBTYPE_KO = {
    SHOCK_REACTION_UP: "상승 충격 반응",
    SHOCK_REACTION_DOWN: "하락 충격 반응",
    SHOCK_REACTION_SIDEWAYS: "횡보 충격 반응",
    DEFAULT: "기본 장세",
    TREND_PERSISTENCE_LONG: "상승 추세 지속",
    TREND_PERSISTENCE_SHORT: "하락 추세 지속"
  };

  const MAX_OPEN = 3;
  let currentTradeControl = null;

  function $(id) {
    return document.getElementById(id);
  }

  function mapReason(k) {
    return REASON_LABELS[k] || k;
  }

  function mapStatus(s) {
    if (typeof s !== "string") return "데이터 없음";
    return STATUS_LABELS[s] || s;
  }

  function mapMode(m) {
    return MODE_LABELS[m] || m;
  }

  function mapBlockReason(r) {
    if (!r) return "—";
    return ENTRY_BLOCK_LABELS[r] || mapReason(r) || String(r);
  }

  /** 이벤트/레거시 로그의 executor NONE → IDLE (표시 일관성). */
  function mapExecutorDisplay(ex) {
    if (ex === undefined || ex === null || ex === "") return "—";
    if (ex === "NONE") return "IDLE";
    return String(ex);
  }

  function formatKst(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
    try {
      return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }) + " KST";
    } catch {
      return "—";
    }
  }

  function formatUsd(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const frac = abs >= 1000 ? 2 : abs >= 1 ? 3 : 4;
    return "$" + n.toLocaleString("ko-KR", { minimumFractionDigits: 0, maximumFractionDigits: frac });
  }

  function formatPct(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    let p = n;
    if (n >= 0 && n <= 1) p = n * 100;
    return p.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "%";
  }

  function formatPrice(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function getSnapshots(bundle) {
    const ls = bundle.latestSnapshot;
    if (!ls || typeof ls !== "object") return [];
    const snaps = ls.snapshots;
    return Array.isArray(snaps) ? snaps : [];
  }

  function snapBySymbol(bundle, sym) {
    return getSnapshots(bundle).find((s) => s && s.symbol === sym) || null;
  }

  /** API/JSON에서 숫자가 문자열로 올 수 있음 */
  function coerceFinite(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const x = parseFloat(String(v).replace(/,/g, ""));
      if (Number.isFinite(x)) return x;
    }
    return null;
  }

  function entryNotionalUsd(pos) {
    const sizeUsd = coerceFinite(pos.sizeUsd);
    if (sizeUsd !== null && sizeUsd > 0) return sizeUsd;
    return null;
  }

  function marginUsdFromPosition(pos) {
    const marginUsd = coerceFinite(pos.marginUsd);
    if (marginUsd !== null && marginUsd > 0) return marginUsd;
    const sizeUsd = entryNotionalUsd(pos);
    const lev = coerceFinite(pos.leverage);
    if (sizeUsd !== null && lev !== null && lev > 0) return sizeUsd / lev;
    return null;
  }

  /** 스냅샷에 심볼이 없어도 symbolRows / 포지션 currentPrice로 Mark 확보 */
  function markForOpen(bundle, sym, pos, snap) {
    if (snap && typeof snap.lastPrice === "number" && Number.isFinite(snap.lastPrice)) return snap.lastPrice;
    const rows = bundle.symbolRows;
    if (Array.isArray(rows)) {
      const row = rows.find((r) => r && String(r.symbol) === String(sym));
      if (row && typeof row.lastPrice === "number" && Number.isFinite(row.lastPrice)) return row.lastPrice;
    }
    const cp = pos && coerceFinite(pos.currentPrice);
    if (cp !== null) return cp;
    return null;
  }

  function normalizeOpenPos(pos) {
    if (!pos || typeof pos !== "object") return null;
    return {
      sizeUsd: entryNotionalUsd(pos),
      marginUsd: marginUsdFromPosition(pos),
      leverage: coerceFinite(pos.leverage) ?? 1,
      entryPrice: coerceFinite(pos.entryPrice),
      openedAt: coerceFinite(pos.openedAt) ?? coerceFinite(pos.firstOpenedAt),
      realized: coerceFinite(pos.realizedPnl) ?? 0,
      stopPx: coerceFinite(pos.stopPrice),
      engineUnreal: coerceFinite(pos.unrealizedPnl),
      unrealPct: coerceFinite(pos.unrealizedPnlPct),
      raw: pos
    };
  }

  /** 미실현: 엔진값 → %×마진 → 마크 추정 순 */
  function unrealizedUsdResolved(n, mark) {
    const pos = n.raw;
    if (n.engineUnreal !== null && Number.isFinite(n.engineUnreal)) return n.engineUnreal;
    if (n.unrealPct !== null && n.marginUsd !== null && n.marginUsd > 0) return (n.marginUsd * n.unrealPct) / 100;
    if (mark === null || n.entryPrice === null || n.entryPrice <= 0 || n.marginUsd === null || n.marginUsd <= 0) return null;
    const lev = n.leverage;
    const gross =
      pos.side === "long"
        ? ((mark - n.entryPrice) / n.entryPrice) * n.marginUsd * lev
        : ((n.entryPrice - mark) / n.entryPrice) * n.marginUsd * lev;
    return Number.isFinite(gross) ? gross : null;
  }

  function fmtUsdPos(n) {
    return typeof n === "number" && Number.isFinite(n) ? formatUsd(n) : "N/A";
  }

  function fmtSignedUsdPos(n) {
    return typeof n === "number" && Number.isFinite(n) ? formatSignedUsd(n) : "N/A";
  }

  function fmtUsdPosNoDecimal(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "N/A";
    return "$" + Math.round(n).toLocaleString("ko-KR");
  }

  function fmtSignedUsdPosNoDecimal(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "N/A";
    const sign = n > 0 ? "+" : n < 0 ? "−" : "";
    return sign + "$" + Math.abs(Math.round(n)).toLocaleString("ko-KR");
  }

  function fmtPctPos(pnlUsd, marginUsd) {
    if (typeof marginUsd !== "number" || !Number.isFinite(marginUsd) || marginUsd <= 0) return "N/A";
    if (typeof pnlUsd !== "number" || !Number.isFinite(pnlUsd)) return "N/A";
    return formatSignedPctOnMargin(pnlUsd, marginUsd);
  }

  function fmtHoldPos(ms) {
    const t = typeof ms === "number" && Number.isFinite(ms) ? ms : null;
    if (t === null) return "N/A";
    return formatHoldDuration(t);
  }

  function fmtRealizedLabel(r) {
    if (typeof r !== "number" || !Number.isFinite(r)) return "실현 손익 없음";
    return formatSignedUsd(r);
  }

  function fmtStopLabel(px) {
    return px !== null && typeof px === "number" && Number.isFinite(px) ? formatPrice(px) : "손절 미설정";
  }

  function getOpenPositions(bundle) {
    const o = bundle.currentPositions || bundle.openPositions;
    return Array.isArray(o) ? o.filter((x) => x && x.status === "open") : [];
  }

  function getStaleLedgerPositions(bundle) {
    const stale = bundle.ledgerStalePositions;
    return Array.isArray(stale) ? stale : [];
  }

  function ledgerOkxSync(bundle) {
    const es = bundle.engineState;
    if (!es || typeof es !== "object") return null;
    const s = es.ledger_okx_position_sync;
    return s && typeof s === "object" ? s : null;
  }

  function okxActualKeySet(sync) {
    const keys = new Set();
    if (!sync || !Array.isArray(sync.okx_positions_preview)) return keys;
    for (const row of sync.okx_positions_preview) {
      if (!row || !row.symbol) continue;
      const side = row.side === "short" ? "short" : "long";
      keys.add(String(row.symbol) + ":" + side);
    }
    return keys;
  }

  function isLedgerOnlyStaleKey(sync, key) {
    if (!sync) return false;
    const okxHas = Array.isArray(sync.okx_positions_preview)
      && sync.okx_positions_preview.some((r) => r && String(r.symbol) + ":" + (r.side === "short" ? "short" : "long") === key);
    const paperHas = Array.isArray(sync.paper_positions_preview)
      && sync.paper_positions_preview.some((r) => r && String(r.symbol) + ":" + (r.side === "short" ? "short" : "long") === key);
    return paperHas && !okxHas;
  }

  function isOkxOnlyKey(sync, key) {
    if (!sync) return false;
    const okxHas = Array.isArray(sync.okx_positions_preview)
      && sync.okx_positions_preview.some((r) => r && String(r.symbol) + ":" + (r.side === "short" ? "short" : "long") === key);
    const paperHas = Array.isArray(sync.paper_positions_preview)
      && sync.paper_positions_preview.some((r) => r && String(r.symbol) + ":" + (r.side === "short" ? "short" : "long") === key);
    return okxHas && !paperHas;
  }

  function hasBotOwnershipEvidence(pos) {
    if (!pos || typeof pos !== "object") return false;
    if (pos.isV2Authority === true) return true;
    const auth = String(pos.authoritySourceAtEntry || pos.authority || "").toLowerCase();
    if (auth === "v2") return true;
    if (String(pos.exchangeClOrdId || "").startsWith("p")) return true;
    return false;
  }

  function isTrueExternalManualForDisplay(pos) {
    if (!pos) return false;
    if (pos.manualLifecycleEvidenceIndependent === false) return false;

    const ls = String(pos.lifecycleState || "");
    if (ls === "EXTERNAL_MANUAL_POSITION" || ls === "OPERATOR_MANAGED") return true;
    if (pos.manualLifecycleEvidenceIndependent === true) return true;

    if (pos.manualOwnershipLatch === true && String(pos.manualOwnershipLatchStrength || "") === "STRONG") {
      if (String(pos.authoritySourceAtEntry || "") === "EXPLICIT_EXTERNAL_FILL") return true;
    }

    return false;
  }

  function syncMismatchIsLedgerStaleOnly(bundle) {
    const sync = ledgerOkxSync(bundle);
    if (!sync || sync.sync_status !== "KEY_MISMATCH") return false;
    const mismatched = Array.isArray(sync.mismatched_keys) ? sync.mismatched_keys : [];
    if (mismatched.length === 0) return false;
    return mismatched.every((k) => isLedgerOnlyStaleKey(sync, k));
  }

  function okxExchangePositionForSymbol(bundle, sym) {
    const sync = ledgerOkxSync(bundle);
    const prev = sync && Array.isArray(sync.okx_positions_preview) ? sync.okx_positions_preview : [];
    return prev.find((x) => x && x.symbol === sym) || null;
  }

  function openForSymbol(bundle, sym) {
    return getOpenPositions(bundle).find((p) => p.symbol === sym) || null;
  }

  function staleLedgerForSymbol(bundle, sym) {
    return getStaleLedgerPositions(bundle).find((p) => p && p.symbol === sym) || null;
  }

  /** OKX 감시·보호 주문·리컨실 표면 (`engine-state.position_ops_surface`). */
  function positionOpsSummary(bundle) {
    const es = bundle.engineState;
    const surf = es && es.position_ops_surface;
    if (!surf || typeof surf !== "object") return "";
    const sync = ledgerOkxSync(bundle);
    const st = sync && typeof sync.sync_status === "string" ? sync.sync_status : "";
    const lines = [];
    const main = typeof surf.surface_banner_ko === "string" ? surf.surface_banner_ko : "";
    if (main) lines.push(main);
    if (st && st !== "ALIGNED" && st !== "REMOTE_UNAVAILABLE") lines.push("리컨실 " + st);
    const rows = Array.isArray(surf.rows) ? surf.rows : [];
    if (surf.orders_scan_performed === true && rows.length > 0) {
      const miss = rows.filter((r) => r && r.reduce_only_protective_found === false);
      if (miss.length > 0)
        lines.push(
          "보호 주문 없음: " +
          miss
            .map((r) => {
              const sd = r.side === "long" ? "롱" : r.side === "short" ? "숏" : r.side;
              return String(r.symbol) + " " + sd;
            })
            .join(", ")
        );
    }
    return lines.join(" · ");
  }

  function estimatePnlUsd(pos, mark) {
    if (!pos || typeof mark !== "number" || !Number.isFinite(mark)) return null;
    const entry = pos.entryPrice;
    const lev = pos.leverage;
    const margin = pos.sizeUsd;
    if (typeof entry !== "number" || typeof lev !== "number" || typeof margin !== "number") return null;
    if (!Number.isFinite(entry) || entry <= 0) return null;
    const gross =
      pos.side === "long"
        ? ((mark - entry) / entry) * margin * lev
        : ((entry - mark) / entry) * margin * lev;
    return gross;
  }

  const DEFAULT_TAKER_FEE_RATE = 0.0006;
  function estimateNetPnlUsd(pos, mark) {
    const gross = estimatePnlUsd(pos, mark);
    if (typeof gross !== "number" || !Number.isFinite(gross)) return null;
    const entry = coerceFinite(pos.entryPrice);
    const lev = coerceFinite(pos.leverage);
    const margin = marginUsdFromPosition(pos);
    if (entry === null || lev === null || margin === null || entry <= 0 || lev <= 0 || margin <= 0) return gross;
    const notionalOpen = margin * lev;
    const exitMark = typeof mark === "number" && Number.isFinite(mark) && mark > 0 ? mark : entry;
    const notionalClose = notionalOpen * (exitMark / entry);
    const entryFee = notionalOpen * DEFAULT_TAKER_FEE_RATE;
    const exitFee = notionalClose * DEFAULT_TAKER_FEE_RATE;
    return gross - entryFee - exitFee;
  }

  /** 엔진이 넣은 미실현이 있으면 우선, 없으면 마크 기준 추정 */
  function unrealizedPnlFor(pos, mark) {
    if (pos && typeof pos.unrealizedPnl === "number" && Number.isFinite(pos.unrealizedPnl)) {
      return pos.unrealizedPnl;
    }
    return estimatePnlUsd(pos, mark);
  }

  function formatSignedUsd(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "−" : "";
    const abs = Math.abs(n);
    const frac = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
    return sign + "$" + abs.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: frac });
  }

  function formatSignedPctOnMargin(pnlUsd, marginUsd) {
    if (
      typeof pnlUsd !== "number" ||
      !Number.isFinite(pnlUsd) ||
      typeof marginUsd !== "number" ||
      !Number.isFinite(marginUsd) ||
      marginUsd <= 0
    ) {
      return "—";
    }
    const pct = (pnlUsd / marginUsd) * 100;
    const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
    return sign + Math.abs(pct).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "%";
  }

  function pnlToneClass(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "pnl-zero";
    if (n > 0.0005) return "pnl-pos";
    if (n < -0.0005) return "pnl-neg";
    return "pnl-zero";
  }

  /** 승률: 0~1 또는 0~100 모두 허용, 50% 근처는 중립 */
  function winRateToneClass(w) {
    if (typeof w !== "number" || !Number.isFinite(w)) return "pnl-zero";
    const frac = w > 1 ? w / 100 : w;
    if (frac > 0.5005) return "pnl-pos";
    if (frac < 0.4995) return "pnl-neg";
    return "pnl-zero";
  }

  function formatHoldDuration(openedAtMs) {
    if (typeof openedAtMs !== "number" || !Number.isFinite(openedAtMs)) return "—";
    const ms = Date.now() - openedAtMs;
    if (ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}일 ${h % 24}시간`;
    if (h > 0) return `${h}시간 ${m % 60}분`;
    if (m > 0) return `${m}분`;
    return `${s}초`;
  }

  function aggregatePortfolioMetrics(bundle) {
    const opens = getOpenPositions(bundle);
    let totalUnreal = 0;
    let totalMargin = 0;
    for (const o of opens) {
      const n = normalizeOpenPos(o);
      if (!n) continue;
      const sym = o.symbol;
      const snap = snapBySymbol(bundle, sym);
      const mark = markForOpen(bundle, sym, o, snap);
      const m = n.marginUsd;
      if (typeof m === "number" && Number.isFinite(m) && m > 0) totalMargin += m;
      const u = unrealizedUsdResolved(n, mark);
      if (typeof u === "number" && Number.isFinite(u)) totalUnreal += u;
    }
    return { openCount: opens.length, totalUnreal, totalMargin };
  }

  function inferMarketNarrative(bundle) {
    const meta = bundle.latestMeta;
    const es = bundle.engineState;
    const snaps = getSnapshots(bundle);
    const opens = getOpenPositions(bundle);
    const modes = new Set();
    for (const o of opens) {
      const m = o.adaptiveModeAtEntry;
      if (m === "trend" || m === "sideways" || m === "risk_off") modes.add(m);
    }
    let modeLine = "";
    if (es && typeof es === "object" && typeof es.regime === "string") {
      modeLine = "현재 레짐: " + mapMode(es.regime) + (es.riskStatus ? " · 리스크 " + String(es.riskStatus) : "");
    } else
      if (modes.size === 1) {
        const [one] = Array.from(modes);
        modeLine = "마지막 진입 시 모드: " + mapMode(one);
      } else if (modes.size > 1) {
        modeLine = "종목별 진입 모드가 다름 · " + Array.from(modes).map(mapMode).join(", ");
      } else {
        modeLine = "적응형 모드(trend/횡보/리스크오프)는 스냅샷에 직접 없음 · 아래는 스냅샷 추정";
      }

    let context = "";
    if (snaps.length >= 2) {
      const weakNarrow = snaps.every((s) => {
        const g = Math.abs(typeof s.emaGap === "number" ? s.emaGap : 0);
        const st = s.candidateStrength;
        return g < 0.004 && (st === "weak" || st === undefined);
      });
      const trendPass = snaps.every((s) => s.trendOk === true);
      if (weakNarrow) context = "EMA 간격이 좁고 약한 후보 위주 → 횡보성에 가까운 구간(추정)";
      else if (trendPass) context = "단기 추세 필터 통과 · 방향성 후보는 종목별로 확인";
      else context = "일부 종목에서 단기 방향성 필터 미통과";
    }

    const ss = meta && meta.signalSummary;
    const cand = (ss && ss.longCandidates + ss.shortCandidates) || 0;
    const sub =
      cand > 0
        ? `이번 틱 메타: 후보 롱·숏 합계 ${cand}건 반영`
        : "이번 틱 메타: 표면 후보 카운트 0";

    return { modeLine, context, sub };
  }

  function entryAggregate(bundle) {
    const opens = getOpenPositions(bundle);
    const snaps = getSnapshots(bundle);
    const hasCandidate = snaps.some((s) => s.signal && s.signal !== "none");

    if (opens.length >= MAX_OPEN) {
      return {
        title: "신규 진입 차단",
        badge: "badge-bad",
        detail: `동시 보유 한도(${MAX_OPEN}) 도달`
      };
    }
    if (hasCandidate && opens.length < MAX_OPEN) {
      return {
        title: "후보 감지 · 엔진 검증 경로",
        badge: "badge-warn",
        detail: "일부 종목에서 롱/숏 후보 · 최종 진입 여부는 게이트·포지션 상태에 따름"
      };
    }
    if (opens.length > 0) {
      return {
        title: "신규 후보 없음 · 포지션 운용 중",
        badge: "badge-neutral",
        detail: "보유 중인 종목은 추가 진입 없음(동일 심볼)"
      };
    }
    return {
      title: "신규 진입 대기",
      badge: "badge-neutral",
      detail: "이번 틱은 표면 후보 없음 · 품질·게이트에 걸린 중립일 수 있음"
    };
  }

  function primaryBlock(bundle) {
    const opens = getOpenPositions(bundle);
    if (opens.length >= MAX_OPEN) {
      return { text: "동시 보유 한도로 신규 진입 불가", tone: "danger" };
    }
    const es = bundle.engineState;
    if (es && typeof es === "object") {
      const entryAllowed = es.entryAllowed;
      const blocked = Array.isArray(es.blockedReasons) ? es.blockedReasons : [];
      if (entryAllowed === false && blocked.length > 0) {
        const first = blocked[0];
        return { text: "현재 진입 차단: " + String(first), tone: "danger" };
      }
    }
    const snaps = getSnapshots(bundle);
    const dr = bundle.dashboard && bundle.dashboard.reasons;
    if (Array.isArray(dr) && dr.length > 0) {
      return { text: mapReason(dr[0]) + " (헬스)", tone: "warn" };
    }
    for (const s of snaps) {
      if (openForSymbol(bundle, s.symbol)) continue;
      const sig = s.signal || "none";
      if (sig === "none") {
        const q = typeof s.qualityScore === "number" ? s.qualityScore : 0;
        if (q < 70) {
          return {
            text: s.symbol + ": 신호 약함·품질 미달로 후보 단계 이전 차단",
            tone: "warn"
          };
        }
        return {
          text: s.symbol + ": 기대 수익·정렬·비용 게이트 등으로 중립 처리(추정)",
          tone: "warn"
        };
      }
    }
    return { text: "즉시 차단 표시 없음 · 후보·보유 상태 확인", tone: "ok" };
  }

  function positionHeroLine(bundle) {
    const opens = getOpenPositions(bundle);
    const sync = ledgerOkxSync(bundle);
    const st = sync && typeof sync.sync_status === "string" ? sync.sync_status : null;
    const detail = sync && typeof sync.detail === "string" && sync.detail.trim().length > 0 ? sync.detail : "";
    const mismatch = st === "OKX_ONLY" || st === "LEDGER_ONLY" || (st === "KEY_MISMATCH" && !syncMismatchIsLedgerStaleOnly(bundle));
    function subMismatch(extra) {
      let s = "RECONCILE_MISMATCH";
      if (extra) s += " · " + extra;
      if (detail) s += " · " + detail;
      return s;
    }

    if (opens.length === 0) {
      const staleLedger = getStaleLedgerPositions(bundle);
      if (staleLedger.length > 0) {
        return {
          title: "실제 포지션 없음",
          sub: "ledger 정리 대기 · 원장 stale " + staleLedger.length + "건",
          badge: "badge-warn",
          cardClass: "hero-card--warn"
        };
      }
      if (st === "OKX_ONLY") {
        return {
          title: "실거래소 포지션 보유 중",
          sub: subMismatch("페이퍼 원장 미반영"),
          badge: "badge-warn",
          cardClass: "hero-card--warn"
        };
      }
      if (st === "LEDGER_ONLY") {
        return {
          title: "거래소 포지션 없음(원장 불일치)",
          sub: subMismatch("원장 오픈 행은 있으나 OKX 스왑 스냅샷 없음"),
          badge: "badge-warn",
          cardClass: "hero-card--warn"
        };
      }
      if (st === "KEY_MISMATCH") {
        return {
          title: "RECONCILE_MISMATCH",
          sub: subMismatch("심볼·방향 키 불일치"),
          badge: "badge-warn",
          cardClass: "hero-card--warn"
        };
      }
      return {
        title: "포지션 없음",
        sub: "모든 심볼 관망",
        badge: "badge-neutral"
      };
    }

    const sides = opens.map((o) => {
      const sym = o.symbol || "?";
      const side = o.side === "long" ? "롱" : o.side === "short" ? "숏" : o.side;
      return sym + " " + side;
    });
    const title =
      opens.length === 1 ? sides[0] + " 보유 중" : opens.length + "개 포지션 보유 · " + sides.join(", ");
    if (mismatch) {
      const staleOnly = syncMismatchIsLedgerStaleOnly(bundle);
      return {
        title,
        sub: staleOnly
          ? "ledger 정리 대기 · 실제 포지션 기준 감시 유지"
          : subMismatch(st || ""),
        badge: staleOnly ? "badge-warn" : "badge-warn",
        cardClass: "hero-card--warn"
      };
    }
    return { title, sub: "종목별 손익은 카드에서 확인", badge: "badge-ok" };
  }

  function getRegimeBadge(pos) {
    if (!pos) return null;
    if (pos.sourceSignal === "okx_reconcile_adopted" || pos.lifecycleState === "CLOSE_ONLY_MANAGED") {
      if (pos.lifecycleState === "CLOSE_ONLY_MANAGED") return { text: "Close-only 관리", cls: "badge-warn" };
      return { text: "복구 관리", cls: "badge-warn" };
    }
    if (isTrueExternalManualForDisplay(pos)) {
      return { text: "외부 수동 관리", cls: "badge-warn" };
    }
    const r = pos.regimeAtEntry || pos.executorAtEntry || pos.strategy;
    if (r === "RANGE" || r === "R") return { text: "R", cls: "badge-range" };
    if (r === "TREND" || r === "T") return { text: "T", cls: "badge-trend" };
    if (r === "TRANSITION" || r === "TR") return { text: "TR", cls: "badge-transition" };
    if (r === "SHOCK" || r === "S") return { text: "S", cls: "badge-shock" };
    if (r === "NO_TRADE") return { text: "관리", cls: "badge-neutral" };
    return null;
  }

  function calculateEnhancedStatus(sym, bundle, pos, snap) {
    const side = pos ? pos.side : "none";
    const sideK = side === "long" ? "롱" : side === "short" ? "숏" : "관망 중";
    const mark = snap && typeof snap.lastPrice === "number" ? snap.lastPrice : null;
    const entry = pos ? coerceFinite(pos.entryPrice) : null;
    const stop = pos ? coerceFinite(pos.stopPrice) : null;
    const pnlPct = pos ? coerceFinite(pos.unrealizedPnlPct) : null;
    const regime = pos ? (pos.regimeAtEntry || pos.executorAtEntry || pos.strategy) : (bundle.engineState ? bundle.engineState.regime : null);
    
    const audit = pickNoEntryAuditRow(bundle, sym);
    const pip = bundle.engineState && bundle.engineState.symbol_decisions && bundle.engineState.symbol_decisions[sym] 
      ? bundle.engineState.symbol_decisions[sym].decision 
      : null;

    if (pos) {
      let pressure = "추세 유지";
      if (pnlPct !== null) {
        if (pnlPct > 2) pressure = "수익권 확대";
        else if (pnlPct > 0) pressure = "수익권 유지";
        else if (pnlPct < -1.5) pressure = side === "long" ? "하락 압력" : "상승 압력";
        else if (pnlPct < -0.5) pressure = "추세 약화";
      }

      let trend = [];
      if (mark !== null && entry !== null) {
        if (side === "long") {
          trend.push(mark < entry ? "진입가 이탈" : "진입가 상회");
        } else {
          trend.push(mark > entry ? "진입가 이탈" : "진입가 상회");
        }
      }
      if (pnlPct !== null && pnlPct < 0) trend.push("손실권 확대");
      if (stop !== null && mark !== null) {
        const dist = Math.abs(mark - stop) / mark;
        if (dist < 0.015) trend.push("손절가 근접");
      }
      if (trend.length === 0) trend.push("데이터 확인 중");

      let risk = "정상";
      if (stop !== null && mark !== null) {
        const dist = Math.abs(mark - stop) / mark;
        if (dist < 0.01) risk = "손절가 근접 (위험)";
        else if (dist < 0.02) risk = "손절가 가시권";
      }
      if (pnlPct !== null && pnlPct < -2) risk = "손실 확대 주의";

      let next = "추세 지속 확인";
      if (risk.includes("위험")) next = "반등 확인 전까지 방어 우선";
      else if (pressure === "추세 약화") next = "반전 경계 및 보호주문 확인";
      else if (regime === "RANGE") next = "박스권 상/하단 이탈 확인";

      return {
        main: `${sideK} 보유 · ${pressure}`,
        trend: trend.join(" / "),
        risk: risk,
        next: next
      };
    } else {
      const ageMs = audit ? noEntryAuditAgeMs(audit) : null;
      const stale = !audit || (typeof ageMs === "number" && ageMs > NO_ENTRY_STALE_MS);

      if (stale) {
        return {
          main: "관망 중 · 최신 판단 대기",
          trend: "최신 데이터 확인 중",
          risk: "—",
          next: "다음 스냅샷 갱신 대기"
        };
      }

      let reason = "진입 대기";
      if (audit && audit.expected_missing_condition) {
        reason = koNoEntryMissing(audit.expected_missing_condition);
      } else if (pip && pip.reject_reason) {
        reason = mapBlockReason(pip.reject_reason);
      }

      let trend = "추세 정렬 미흡";
      if (audit && audit.quality_score !== null) {
        if (audit.quality_score < 50) trend = "진입 품질 부족";
        else trend = `품질 점수(${audit.quality_score}) 대기`;
      }

      let next = "레인지·추세 정렬 재확인 대기";
      if (audit && audit.expected_next_action) {
        next = koNoEntryNext(audit.expected_next_action);
      }

      return {
        main: `관망 중 · ${reason}`,
        trend: trend,
        risk: "—",
        next: next
      };
    }
  }

  function symbolHeadline(sym, bundle) {
    const pos = openForSymbol(bundle, sym);
    const okxRow = okxExchangePositionForSymbol(bundle, sym);
    const s = snapBySymbol(bundle, sym) || {};
    
    if (!pos && okxRow) {
      const sideK = okxRow.side === "long" ? "롱" : okxRow.side === "short" ? "숏" : okxRow.side;
      return sym + " · 실거래소 " + sideK + " 포지션 감지 · 장부 정합성 확인 필요";
    }

    const est = calculateEnhancedStatus(sym, bundle, pos, s);
    return sym + " · " + est.main;
  }

  function symbolOneLiner(sym, bundle) {
    const pos = openForSymbol(bundle, sym);
    const okxRow = okxExchangePositionForSymbol(bundle, sym);
    const s = snapBySymbol(bundle, sym) || {};
    const es = bundle.engineState;
    const pip =
      es && es.symbol_decisions && es.symbol_decisions[sym] && es.symbol_decisions[sym].decision
        ? es.symbol_decisions[sym].decision
        : null;
    if (pos) {
      return (
        "진입가 " +
        formatPrice(pos.entryPrice) +
        " · 현재가 " +
        formatPrice(s.lastPrice) +
        " · 레버 " +
        String(pos.leverage ?? "—") +
        "x"
      );
    }
    if (!pos && okxRow) {
      const syn = ledgerOkxSync(bundle);
      const st = syn && syn.sync_status;
      const mm =
        st && st !== "ALIGNED" && st !== "REMOTE_UNAVAILABLE"
          ? " · RECONCILE_MISMATCH"
          : "";
      return (
        "실거래소 포지션(페이퍼 원장 미연동) · 방향 " +
        (okxRow.side === "long" ? "롱" : okxRow.side === "short" ? "숏" : String(okxRow.side)) +
        mm +
        " · 상세는 거래소 확인"
      );
    }
    if (pip && String(pip.regime) === "RANGE") {
      const boxPos = typeof pip.box_position_diag === "number" ? Number(pip.box_position_diag) : null;
      const boxTxt = boxPos === null ? "박스 위치 산출 중" : "박스 위치 " + boxPos.toFixed(2);
      if (pip.range_zone_detected === "mid" || pip.range_mid_wait_applied === true)
        return boxTxt + " · 중단 구간: 기본은 대기(no-trade 우선)";
      if (pip.range_zone_detected === "upper")
        return boxTxt + " · 상단: 롱 신호는 진입로 이어기지 않고 숏 우선";
      if (pip.range_zone_detected === "lower")
        return boxTxt + " · 하단: 숏 억제, 롱 평가 우선";
      if (pip.range_center_wait === true) return boxTxt + " · 중앙 구간이라 진입 대기";
      if (pip.range_upper_edge_near === true && pip.range_short_allowed === true)
        return boxTxt + " · 상단 근접 숏 조건 충족으로 진입 평가 중";
      if (String(pip.range_short_allowed_reason || "") === "range_lower_zone_short_forbidden")
        return boxTxt + " · 하단권 숏 금지, 롱 반응 신호 대기";
      if (pip.range_cost_warning_applied === true) return boxTxt + " · 비용 경고 반영, 보수 관찰 유지";
      return boxTxt + " · 자리 기반 기대값 재평가 중";
    }
    const sig = s.signal || "none";
    const q = typeof s.qualityScore === "number" ? s.qualityScore : null;
    if (sig === "none") {
      if (q !== null && q < 70) return "신호 품질·구조 미달로 후보 단계 전에 차단된 틱일 가능성이 큼";
      if (q !== null && q >= 70)
        return "점수는 있으나 최종 시그널 없음 · 기대 수익 부족·상위 시간대 정렬·게이트 차단(추정)";
      return "중립 시그널 · 엔진이 이번 틱에서 진입 후보로 보지 않음";
    }
    if (sig === "paper_long_candidate") return "롱 방향 후보 · 이후 비용·정렬·모드 조건을 통과해야 실제 진입";
    if (sig === "paper_short_candidate") return "숏 방향 후보 · 이후 비용·정렬·모드 조건을 통과해야 실제 진입";
    return String(sig);
  }

  function perfSlice(bundle, key) {
    const lp = bundle.ledgerPerformance;
    if (lp && lp[key]) return lp[key];
    const snap = bundle.dashboard && bundle.dashboard.snapshot;
    return snap && snap[key] ? snap[key] : null;
  }

  function renderPerfNote(bundle) {
    const lp = bundle.ledgerPerformance;
    if (lp) {
      return (
        "종료 거래 원장 기준 집계 · 파싱 " +
        (lp.parsedTradeCount ?? "—") +
        "건 · 시각 " +
        formatKst(lp.generatedAt)
      );
    }
    return "원장 없음 시 dashboard.snapshot 폴백";
  }

  function renderHero(bundle) {
    const pm = aggregatePortfolioMetrics(bundle);
    const perf7 = perfSlice(bundle, "last7d");
    const unrealClass = pnlToneClass(pm.totalUnreal);
    const realized7 =
      perf7 && typeof perf7.totalPnlUsdNet === "number" && Number.isFinite(perf7.totalPnlUsdNet)
        ? perf7.totalPnlUsdNet
        : null;
    const realizedClass = pnlToneClass(realized7 !== null ? realized7 : 0);
    const win7 =
      perf7 && typeof perf7.winRate === "number" && Number.isFinite(perf7.winRate) ? perf7.winRate : null;
    const winClass = win7 !== null ? winRateToneClass(win7) : "";
    const hero = $("hero");
    hero.innerHTML = `
      <article class="hero-card hero-card--metric hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums">${esc(String(pm.openCount))}</p>
        <p class="hero-label">총 보유 수</p>
      </article>
      <article class="hero-card hero-card--metric hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums ${unrealClass}">${esc(formatSignedUsd(pm.totalUnreal))}</p>
        <p class="hero-label">총 미실현 손익</p>
      </article>
      <article class="hero-card hero-card--metric hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums ${realizedClass}">${realized7 !== null ? esc(formatSignedUsd(realized7)) : "—"}</p>
        <p class="hero-label">최근 7일 실현(순)</p>
      </article>
      <article class="hero-card hero-card--metric hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums ${winClass}">${win7 !== null ? esc(formatPct(win7)) : "—"}</p>
        <p class="hero-label">최근 7일 승률</p>
      </article>
    `;
  }

  function renderOkxHero(bundle) {
    const hero = $("hero-okx");
    if (!hero) return;
    const es = bundle.engineState;
    if (!es) {
      hero.innerHTML = '<p class="muted">엔진 상태 데이터 없음</p>';
      return;
    }

    const totalEquity = es.okx_total_equity_usdt ?? es.okx_wallet_balance_usdt;
    const avail = es.okx_available_balance_usdt;
    const frozen = es.okx_used_margin_usdt ?? es.usdt_frozen_bal;
    const unreal = es.okx_unrealized_pnl_usdt;

    const unrealClass = pnlToneClass(unreal);
    const updated = es.okx_balance_updated_at ? ` (갱신: ${new Date(es.okx_balance_updated_at).toLocaleTimeString()})` : "";

    hero.innerHTML = `
      <article class="hero-card hero-card--accent hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums">${esc(formatUsd(totalEquity))}</p>
        <p class="hero-label">총 평가자산 (Live)</p>
      </article>
      <article class="hero-card hero-card--accent hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums">${esc(formatUsd(avail))}</p>
        <p class="hero-label">사용 가능 잔고 (Live)</p>
      </article>
      <article class="hero-card hero-card--accent hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums">${esc(formatUsd(frozen))}</p>
        <p class="hero-label">포지션 점유·동결 (Live)</p>
      </article>
      <article class="hero-card hero-card--accent hero-card--numfirst">
        <p class="hero-metric-xl tabular-nums ${unrealClass}">${esc(formatSignedUsd(unreal))}</p>
        <p class="hero-label">미실현 손익 (Live)</p>
      </article>
    `;
  }

  function pickExternalMarketContext(bundle) {
    const es = bundle && bundle.engineState;
    if (!es || typeof es !== "object") return null;
    const ctx = es.external_market_context ?? es.externalMarketContext ?? null;
    return ctx && typeof ctx === "object" ? ctx : null;
  }

  function formatExternalScore(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const sign = n >= 0 ? "+" : "";
    return sign + n.toFixed(2);
  }

  function formatExternalMultiplier(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n.toFixed(2) + "x";
  }

  function formatExternalReliabilityPct(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const pct = n <= 1 ? n * 100 : n;
    return Math.round(pct) + "%";
  }

  function mapExternalDirection(score, reliability, weight) {
    const insufficient =
      reliability === 0 || (typeof weight === "number" && Number.isFinite(weight) && weight < 0.35);
    if (insufficient) {
      return { label: "외부 데이터 부족 / 중립", tone: "neutral", key: "insufficient", insufficient: true };
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return { label: "—", tone: "neutral", key: "unknown", insufficient: false };
    }
    if (score >= 0.5) return { label: "롱 강한 우호", tone: "bull", key: "long_strong", insufficient: false };
    if (score >= 0.15) return { label: "롱 우호", tone: "bull", key: "long", insufficient: false };
    if (score > -0.15) return { label: "중립", tone: "neutral", key: "neutral", insufficient: false };
    if (score > -0.5) return { label: "숏 우호", tone: "bear", key: "short", insufficient: false };
    return { label: "숏 강한 우호", tone: "bear", key: "short_strong", insufficient: false };
  }

  function formatMarketDirectionArrow(dir) {
    if (dir === "up") return "↑";
    if (dir === "down") return "↓";
    return "→";
  }

  function externalSourceUnavailable(ctx, key) {
    const list = ctx && ctx.unavailable_sources;
    if (!Array.isArray(list)) return false;
    return list.some((s) => String(s).toLowerCase() === String(key).toLowerCase());
  }

  function formatExternalMomentumSource(ctx, key, signal) {
    if (externalSourceUnavailable(ctx, key)) {
      return `<span class="emc-source-val emc-source-val--dim">사용불가</span>`;
    }
    const disp =
      ctx && ctx.source_display && typeof ctx.source_display === "object" ? ctx.source_display[key] : null;
    if (disp && typeof disp === "object") {
      const mkt = formatMarketDirectionArrow(disp.market_direction);
      const btc =
        typeof disp.btc_impact === "number" && Number.isFinite(disp.btc_impact)
          ? formatExternalScore(disp.btc_impact)
          : "—";
      return `<span class="emc-source-val">시장 ${esc(mkt)} / BTC 영향 ${esc(btc)}</span>`;
    }
    if (typeof signal !== "number" || !Number.isFinite(signal)) {
      return `<span class="emc-source-val emc-source-val--dim">—</span>`;
    }
    const invert = key === "dxy" || key === "us10y";
    const mkt = formatMarketDirectionArrow(signal > 0.05 ? "up" : signal < -0.05 ? "down" : "flat");
    const btcVal = invert ? -signal : signal;
    return `<span class="emc-source-val">시장 ${esc(mkt)} / BTC 영향 ${esc(formatExternalScore(btcVal))}</span>`;
  }

  function formatEconomicEventStatus(ctx) {
    const raw = ctx && ctx.economic_event_source_status;
    if (raw === "live") return "정상";
    if (raw === "cached") return "캐시";
    if (externalSourceUnavailable(ctx, "economicEvent") || externalSourceUnavailable(ctx, "economic_event")) {
      return "사용불가";
    }
    return "사용불가";
  }

  function formatNewsSourceStatus(ctx) {
    if (externalSourceUnavailable(ctx, "news")) return "사용불가";
    const err = ctx && ctx.last_fetch_errors && typeof ctx.last_fetch_errors === "object" ? ctx.last_fetch_errors.news : null;
    if (typeof err === "string" && err.trim()) return "사용불가";
    return "정상";
  }

  function externalMarketStatusBadges(ctx) {
    const enabled = ctx && ctx.external_market_context_enabled === true;
    const shadow = ctx && ctx.external_market_context_shadow_mode !== false;
    const fetchOn = ctx && ctx.external_market_context_fetch_enabled === true;
    const applied = ctx && ctx.external_context_applied === true;
    const impactNone = !ctx || ctx.trading_impact === "none" || ctx.trading_impact === "unknown";

    const badges = [];
    if (!fetchOn) {
      badges.push('<span class="emc-badge emc-badge--off">데이터 수집 비활성</span>');
    }
    if (fetchOn && (!enabled || shadow)) {
      badges.push('<span class="emc-badge emc-badge--shadow">관찰 전용</span>');
    }
    if (fetchOn && enabled && !shadow) {
      badges.push('<span class="emc-badge emc-badge--live">실거래 반영 가능</span>');
    }
    if (!applied || impactNone || shadow || !enabled) {
      badges.push('<span class="emc-badge">실거래 영향 없음</span>');
    } else {
      badges.push('<span class="emc-badge emc-badge--live">실거래 사이징 반영 중</span>');
    }
    return badges.join("");
  }

  function buildExternalMarketSummary(ctx, dir) {
    if (!ctx || ctx.external_market_context_fetch_enabled !== true) {
      return "외부시장 데이터 수집이 비활성 상태입니다. 엔진 설정(EXTERNAL_MARKET_CONTEXT_FETCH_ENABLED) 확인이 필요합니다.";
    }
    if (dir.insufficient) {
      return "외부 데이터가 부족해 방향 판단을 중립으로 처리하고 있습니다.";
    }
    const shadowSuffix =
      ctx.external_market_context_shadow_mode !== false ||
      ctx.external_market_context_enabled !== true ||
      ctx.trading_impact === "none" ||
      ctx.external_context_applied !== true
        ? " 아직 관찰 전용이라 실제 주문에는 반영되지 않습니다."
        : "";

    switch (dir.key) {
      case "long":
        return `현재 외부시장 환경은 롱 포지션에 다소 우호적입니다.${shadowSuffix}`;
      case "long_strong":
        return `현재 외부시장 환경은 롱 포지션에 강하게 우호적입니다.${shadowSuffix}`;
      case "short":
        return `현재 외부시장 환경은 숏 포지션에 다소 우호적입니다.${shadowSuffix}`;
      case "short_strong":
        return `현재 외부시장 환경은 숏 포지션에 강하게 우호적입니다.${shadowSuffix}`;
      case "neutral":
        return "현재 외부시장 환경은 롱·숏 어느 한쪽에도 뚜렷하게 우호적이지 않습니다.";
      default:
        return "현재 외부시장 환경을 표시할 수 없습니다.";
    }
  }

  function formatExternalFetchErrors(ctx) {
    const err = ctx && ctx.last_fetch_errors;
    if (!err || typeof err !== "object") return "";
    const parts = Object.keys(err)
      .filter((k) => typeof err[k] === "string" && err[k].trim())
      .map((k) => `${k}: ${err[k]}`);
    return parts.length > 0 ? parts.join(" · ") : "";
  }

  function renderExternalMarketContext(bundle) {
    const box = $("external-market-context-card");
    if (!box) return;
    const ctx = pickExternalMarketContext(bundle);
    if (!ctx) {
      box.innerHTML =
        '<div class="emc-card"><p class="emc-summary muted">외부시장 맥락 데이터 없음 · 엔진이 한 틱 이상 실행된 후 engineState.external_market_context 에 표시됩니다.</p></div>';
      return;
    }

    const score = ctx.external_context_score;
    const reliability = ctx.external_signal_reliability;
    const weight = ctx.available_signal_weight;
    const dir = mapExternalDirection(score, reliability, weight);
    const dirClass =
      dir.tone === "bull" ? "emc-direction--bull" : dir.tone === "bear" ? "emc-direction--bear" : "emc-direction--neutral";

    const longMult =
      typeof ctx.reliability_adjusted_long_preview_multiplier === "number" &&
      Number.isFinite(ctx.reliability_adjusted_long_preview_multiplier) &&
      reliability !== 0
        ? ctx.reliability_adjusted_long_preview_multiplier
        : ctx.long_preview_multiplier;
    const shortMult =
      typeof ctx.reliability_adjusted_short_preview_multiplier === "number" &&
      Number.isFinite(ctx.reliability_adjusted_short_preview_multiplier) &&
      reliability !== 0
        ? ctx.reliability_adjusted_short_preview_multiplier
        : ctx.short_preview_multiplier;

    const updatedAt = typeof ctx.ts === "number" && Number.isFinite(ctx.ts) ? formatKst(ctx.ts) : "—";
    const ageMs = typeof ctx.snapshot_age_ms === "number" && Number.isFinite(ctx.snapshot_age_ms) ? ctx.snapshot_age_ms : null;

    box.innerHTML = `
      <div class="emc-card">
        <div class="emc-top">
          <div class="emc-metric">
            <span class="emc-metric-k">외부시장 판단</span>
            <span class="emc-metric-v emc-direction ${dirClass}">${esc(dir.label)}</span>
          </div>
          <div class="emc-metric">
            <span class="emc-metric-k">외부 점수</span>
            <span class="emc-metric-v tabular-nums">${esc(formatExternalScore(score))}</span>
          </div>
          <div class="emc-metric">
            <span class="emc-metric-k">신뢰도</span>
            <span class="emc-metric-v tabular-nums">${esc(formatExternalReliabilityPct(reliability))}</span>
          </div>
          <div class="emc-metric">
            <span class="emc-metric-k">롱 예상 배율</span>
            <span class="emc-metric-v tabular-nums">${esc(formatExternalMultiplier(longMult))}</span>
          </div>
          <div class="emc-metric">
            <span class="emc-metric-k">숏 예상 배율</span>
            <span class="emc-metric-v tabular-nums">${esc(formatExternalMultiplier(shortMult))}</span>
          </div>
        </div>
        <div class="emc-badges">${externalMarketStatusBadges(ctx)}</div>
        <p class="emc-summary">${esc(buildExternalMarketSummary(ctx, dir))}</p>
        <div class="emc-sources">
          <div class="emc-source-row emc-source-row--stack">
            <span class="emc-source-label">나스닥(NQ)</span>
            ${formatExternalMomentumSource(ctx, "nq", ctx.nq_signal)}
          </div>
          <div class="emc-source-row emc-source-row--stack">
            <span class="emc-source-label">S&amp;P500(ES)</span>
            ${formatExternalMomentumSource(ctx, "es", ctx.es_signal)}
          </div>
          <div class="emc-source-row emc-source-row--stack">
            <span class="emc-source-label">달러지수(DXY)</span>
            ${formatExternalMomentumSource(ctx, "dxy", ctx.dxy_signal)}
          </div>
          <div class="emc-source-row emc-source-row--stack">
            <span class="emc-source-label">미국 10년물 금리</span>
            ${formatExternalMomentumSource(ctx, "us10y", ctx.us10y_signal)}
          </div>
          <div class="emc-source-row">
            <span class="emc-source-label">경제 이벤트</span>
            <span class="emc-source-val">${esc(formatEconomicEventStatus(ctx))}</span>
          </div>
          <div class="emc-source-row">
            <span class="emc-source-label">크립토 뉴스</span>
            <span class="emc-source-val">${esc(formatNewsSourceStatus(ctx))}</span>
          </div>
        </div>
        <p class="emc-meta">갱신 ${esc(updatedAt)}${ageMs != null ? ` · 스냅샷 ${Math.round(ageMs / 1000)}초 전` : ""} · 가용 가중치 ${esc(typeof weight === "number" && Number.isFinite(weight) ? weight.toFixed(2) : "—")} · raw 롱 ${esc(formatExternalMultiplier(ctx.raw_long_preview_multiplier))} / raw 숏 ${esc(formatExternalMultiplier(ctx.raw_short_preview_multiplier))} · adj 롱 ${esc(formatExternalMultiplier(ctx.reliability_adjusted_long_preview_multiplier))} / adj 숏 ${esc(formatExternalMultiplier(ctx.reliability_adjusted_short_preview_multiplier))}${ctx.economic_event_fetch_error ? ` · 경제 이벤트 오류 ${esc(String(ctx.economic_event_fetch_error))}` : ""}${formatExternalFetchErrors(ctx) ? ` · fetch ${esc(formatExternalFetchErrors(ctx))}` : ""}</p>
      </div>
    `;
  }

  function renderOperatorContext(bundle) {
    const el = $("operator-context-body");
    if (!el) return;
    const nar = inferMarketNarrative(bundle);
    const entry = entryAggregate(bundle);
    const pos = positionHeroLine(bundle);
    const blk = primaryBlock(bundle);
    const es = bundle.engineState;
    const curRegime = es && typeof es === "object" ? (es.current_regime || es.regime) : null;
    const entryGateLine =
      es && typeof es === "object"
        ? "레짐 " +
        mapMode(curRegime) +
        " · 진입 " +
        (es.entryAllowed === false ? "차단" : es.entryAllowed === true ? "가능" : "—") +
        (Array.isArray(es.blockedReasons) && es.blockedReasons.length > 0 ? " · 이유 " + mapBlockReason(es.blockedReasons[0]) : "")
        : "";
    const toneClass =
      blk.tone === "danger" ? "hero-card--danger" : blk.tone === "warn" ? "hero-card--warn" : "";
    const funnel = es && es.decision_funnel_tick && typeof es.decision_funnel_tick === "object" ? es.decision_funnel_tick : null;
    const funnelLine =
      funnel && typeof funnel.raw_signal_count === "number"
        ? `이번 틱 퍼널: 신호 ${funnel.raw_signal_count} → 레짐 ${funnel.regime_pass_count} → 엣지 ${funnel.edge_pass_count} → 리스크 ${funnel.risk_pass_count} → 실행준비 ${funnel.execution_ready_count} → AI ${funnel.ai_pass_count ?? "—"} → 진입 ${funnel.enter_count ?? "—"}`
        : "";
    const f50 = es && es.decision_funnel_50 && typeof es.decision_funnel_50 === "object" ? es.decision_funnel_50 : null;
    const f50n =
      typeof es?.decision_funnel_50_size === "number" && Number.isFinite(es.decision_funnel_50_size)
        ? es.decision_funnel_50_size
        : null;
    const funnel50Line =
      f50 && typeof f50.raw_signal_count === "number"
        ? `최근 50틱 누적(${f50n != null ? `${f50n}/50` : "—"}): 신호 ${f50.raw_signal_count} → … → 진입 ${f50.enter_count ?? "—"}`
        : "";
    const rj = es && es.reject_reason_counts_tick && typeof es.reject_reason_counts_tick === "object" ? es.reject_reason_counts_tick : null;
    const rejectTickLine =
      rj && Object.keys(rj).length > 0
        ? "이번 틱 차단 코드: " +
        Object.keys(rj)
          .map((k) => `${mapBlockReason(k)} ${rj[k]}`)
          .join(" · ")
        : "";
    el.innerHTML = `
      <div class="opctx-grid">
        <article class="hero-card hero-card--accent" style="margin:0">
          <p class="hero-label">시장·스냅샷</p>
          <p class="hero-value" style="font-size:0.9rem">${esc(nar.context || "—")}</p>
          <p class="hero-sub">${esc(nar.modeLine)}</p>
          <p class="hero-sub muted">${esc(entryGateLine)}</p>
          <p class="hero-sub muted">${esc(nar.sub)}</p>
        </article>
        <article class="hero-card hero-card--accent ${esc(pos.cardClass || "")}" style="margin:0">
          <p class="hero-label">포지션 요약</p>
          <p class="hero-value" style="font-size:0.9rem">${esc(pos.title)}</p>
          <p class="hero-sub">${esc(pos.sub)}</p>
          <p class="hero-sub muted">${esc(positionOpsSummary(bundle))}</p>
        </article>
        <article class="hero-card" style="margin:0">
          <p class="hero-label">신규 진입 문구</p>
          <p class="hero-value" style="font-size:0.9rem">${esc(entry.title)}</p>
          <p class="hero-sub">${esc(entry.detail)}</p>
        </article>
        <article class="hero-card ${toneClass}" style="margin:0">
          <p class="hero-label">주의·차단 요약</p>
          <p class="hero-value" style="font-size:0.85rem">${esc(blk.text)}</p>
        </article>
      </div>
      ${es && typeof es === "object"
        ? `<div class="muted text-xs" style="margin-top:0.75rem">모드 ${esc(es.engine_mode || "—")} · 실행 ${esc(
          es.execution_state || "—"
        )} · 전략 ${esc(es.strategy_executor || es.active_mode_executor || "—")} · 레짐 ${esc(
          mapMode(curRegime)
        )} · 엔진 ${esc(es.engine_status || "—")} · 리스크 ${esc(es.risk_state || es.riskStatus || "—")}</div>`
        : ""}
      ${funnelLine ? `<p class="hero-sub muted" style="margin-top:0.5rem">${esc(funnelLine)}</p>` : ""}
      ${funnel50Line ? `<p class="hero-sub muted">${esc(funnel50Line)}</p>` : ""}
      ${rejectTickLine ? `<p class="hero-sub muted">${esc(rejectTickLine)}</p>` : ""}
      ${renderAiSummaryInline(bundle)}
    `;
  }

  function renderAiSummaryInline(bundle) {
    const s = bundle.summary;
    const ai = s && s.observation && s.observation.aiApproval ? s.observation.aiApproval : null;
    if (!ai) return "";
    const rate = typeof ai.ai_approval_rate === "number" ? formatPct(ai.ai_approval_rate) : "—";
    const q = s && s.observation && s.observation.aiBlockQuality ? s.observation.aiBlockQuality : null;
    const qRate = q && typeof q.ai_block_quality_rate === "number" ? formatPct(q.ai_block_quality_rate) : "—";
    const c = q && q.criteria ? q.criteria : null;
    const cLine = c
      ? ` · 기준 good ≤ ${String(c.good_block_threshold_pct)}% / missed ≥ ${String(c.missed_opportunity_threshold_pct)}%`
      : "";
    const qLine = q
      ? ` · 차단품질 good ${esc(String(q.ai_block_good_count))} / missed ${esc(String(q.ai_block_missed_count))} (${esc(qRate)})${esc(cLine)}`
      : "";
    return `<p class="hero-sub muted">AI 승인: exec ${esc(String(ai.executor_allowed_count))} · 승인 ${esc(
      String(ai.ai_approved_count)
    )} · 차단 ${esc(String(ai.ai_blocked_count))} · 승인율 ${esc(rate)}${qLine}</p>`;
  }

  function formatCount(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return String(Math.trunc(n));
  }

  function formatRatioPlain(n) {
    if (n === null || n === undefined || typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n.toLocaleString("ko-KR", { maximumFractionDigits: 3 });
  }

  function renderFeeAnalytics(bundle) {
    const box = $("fee-analytics");
    if (!box) return;
    const dashFa = bundle.dashboard && bundle.dashboard.feeAnalytics;
    const lp7 = bundle.ledgerPerformance && bundle.ledgerPerformance.last7d;
    const s =
      dashFa && dashFa.last7d && typeof dashFa.last7d.totalTrades === "number"
        ? dashFa.last7d
        : lp7;
    if (!s || !s.totalTrades) {
      box.innerHTML =
        '<p class="muted text-xs">최근 7일 종료 거래 없음 · 또는 엔진 리포트 갱신 후 dashboard에 feeAnalytics가 채워집니다.</p>';
      return;
    }
    const item = (label, val) =>
      `<div><span class="fee-k">${esc(label)}</span> <span class="fee-v">${val}</span></div>`;
    box.innerHTML = [
      item("거래 수", formatCount(s.totalTrades)),
      item("평균 승리(순)", formatUsd(s.averageWinPnlUsdNet)),
      item("평균 패배(순)", formatUsd(s.averageLossPnlUsdNet)),
      item("건당 평균 수수료", formatUsd(s.averageFeeUsdPerTrade)),
      item("gross 합", formatUsd(s.totalPnlUsdGross)),
      item("수수료 합", formatUsd(s.totalFeeUsd)),
      item("순손익 합", formatUsd(s.totalPnlUsdNet)),
      item("profit factor (순)", formatRatioPlain(s.profitFactorNet)),
      item("평균승/평균패", formatRatioPlain(s.avgWinToAvgLossRatio)),
      item("gross+ 순− 건수", formatCount(s.tradesGrossPositiveNetNegative)),
      item("수수료 역전 비중", formatPct(s.tradesGrossPositiveNetNegativeRatio)),
      item("순/gross", formatRatioPlain(s.netToGrossRatio)),
      item("fee/gross", formatRatioPlain(s.feeToGrossRatio))
    ].join("");
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pickNoEntryAuditRow(bundle, sym) {
    const rootBy =
      bundle.noEntryAuditBySymbol ||
      (bundle.noEntryAudit && typeof bundle.noEntryAudit === "object"
        ? bundle.noEntryAudit.bySymbol
        : null);
    if (!rootBy || typeof rootBy !== "object") return null;
    const u = String(sym).trim().toUpperCase();
    return rootBy[sym] || rootBy[u] || null;
  }

  function noEntryAuditAgeMs(row) {
    if (!row || typeof row !== "object") return null;
    const ts = typeof row.ts === "number" && Number.isFinite(row.ts) ? row.ts : null;
    if (ts === null) return null;
    return Date.now() - ts;
  }

  function koNoEntryMissing(code) {
    if (code === null || code === undefined || code === "") return "—";
    const k = String(code);
    return NO_ENTRY_EXPECTED_MISSING_KO[k] || NO_ENTRY_SIDE_VETO_KO[k] || k;
  }

  function koNoEntryNext(code) {
    if (code === null || code === undefined || code === "") return "—";
    const k = String(code);
    return NO_ENTRY_NEXT_ACTION_KO[k] || k;
  }

  function koNoEntryLeverage(code) {
    if (code === null || code === undefined || code === "") return "—";
    const k = String(code);
    return NO_ENTRY_EXPECTED_MISSING_KO[k] || k;
  }

  function koNoEntrySideVeto(code) {
    if (code === null || code === undefined || code === "") return "—";
    const k = String(code);
    return NO_ENTRY_SIDE_VETO_KO[k] || koNoEntryMissing(k);
  }

  function koNoEntryMarketSubtype(code) {
    if (code === null || code === undefined || code === "") return "—";
    const k = String(code);
    return NO_ENTRY_MARKET_SUBTYPE_KO[k] || k;
  }

  function fmtSideEnShort(x) {
    if (x === "long") return "Long";
    if (x === "short") return "Short";
    if (x === null || x === undefined || x === "") return "none";
    if (String(x).toLowerCase() === "none") return "none";
    return String(x);
  }

  function fmtAuditBool(v) {
    if (v === true) return "예";
    if (v === false) return "아니오";
    return "—";
  }

  function noEntryCardState(bundle, snap) {
    const tc = bundle.tradeControl;
    const engine = bundle.engineState;
    if (tc && tc.killSwitch === true) return { label: "차단 중", cls: "sym-state-v--danger" };
    if (engine && engine.entryAllowed === false) return { label: "차단 중", cls: "sym-state-v--danger" };
    const sig = snap && snap.signal ? snap.signal : "none";
    if (sig === "paper_long_candidate" || sig === "paper_short_candidate") return { label: "진입 대기", cls: "sym-state-v--ok" };
    return { label: "관망 중", cls: "sym-state-v--neutral" };
  }

  function noEntryAuditDetailHtml(sym, bundle) {
    const audit = pickNoEntryAuditRow(bundle, sym);
    const ageMs = audit ? noEntryAuditAgeMs(audit) : null;
    const stale = !audit || (typeof ageMs === "number" && ageMs > NO_ENTRY_STALE_MS);
    function ddt(label, ddInner) {
      return `<dt>${esc(label)}</dt><dd>${ddInner}</dd>`;
    }
    function strField(key) {
      if (stale || !audit) return `<span class="muted">—</span>`;
      const v = audit[key];
      if (v === undefined || v === null || v === "") return `<span class="muted">—</span>`;
      return esc(String(v));
    }

    const tsLine =
      !audit || typeof audit.ts !== "number"
        ? `<span class="muted">—</span>`
        : `${esc(formatKst(audit.ts))} (${esc(String(audit.ts))})`;
    const ageLine =
      ageMs !== null && Number.isFinite(ageMs)
        ? esc(String(Math.max(0, Math.round(ageMs))))
        : `<span class="muted">—</span>`;

    return [
      ddt(
        "무진입 요약 상태",
        stale ? `<span class="muted">${esc("최근 판단 갱신 대기 · 스냅샷 없음 또는 만료")}</span>` : esc("실시간 V2 무진입 감사")
      ),
      ddt(
        "expected_missing_condition (표시 문장)",
        stale ? `<span class="muted">—</span>` : esc(koNoEntryMissing(audit.expected_missing_condition))
      ),
      ddt(
        "raw_missing_condition",
        stale ? `<span class="muted">—</span>` : strField("raw_missing_condition")
      ),
      ddt(
        "expected_next_action (표시 문장)",
        stale ? `<span class="muted">—</span>` : esc(koNoEntryNext(audit.expected_next_action))
      ),
      ddt(
        "trend_side_candidate / range_side_candidate",
        stale
          ? `<span class="muted">—</span>`
          : esc(`${fmtSideEnShort(audit.trend_side_candidate)} · ${fmtSideEnShort(audit.range_side_candidate)}`)
      ),
      ddt(
        "selected_side_after_veto",
        stale ? `<span class="muted">—</span>` : esc(fmtSideEnShort(audit.selected_side_after_veto))
      ),
      ddt(
        "side_veto_detail (표시 문장)",
        stale ? `<span class="muted">—</span>` : esc(koNoEntrySideVeto(audit.side_veto_detail))
      ),
      ddt(
        "market_subtype",
        stale
          ? `<span class="muted">—</span>`
          : `${esc(koNoEntryMarketSubtype(audit.market_subtype))} <span class="muted text-xs">(${esc(String(audit.market_subtype ?? "—"))})</span>`
      ),
      ddt("active_engine_routing (legacy)", strField("active_engine_routing")),
      ddt("top_level_execution_lane", strField("top_level_execution_lane")),
      ddt("v2_router_executor", strField("v2_router_executor")),
      ddt(
        "boxPos / zone",
        stale
          ? `<span class="muted">—</span>`
          : esc(`${String(audit.boxPos ?? "—")} · ${String(audit.zone ?? "—")}`)
      ),
      ddt(
        "trendOk · quality_score · grade",
        stale
          ? `<span class="muted">—</span>`
          : esc(
              `${fmtAuditBool(audit.trendOk)} · ${audit.quality_score != null ? String(audit.quality_score) : "—"} · ${audit.entry_quality_grade != null ? String(audit.entry_quality_grade) : "—"}`
            )
      ),
      ddt(
        "reversal_confirmed / side_zone_valid",
        stale
          ? `<span class="muted">—</span>`
          : esc(`${fmtAuditBool(audit.reversal_confirmed)} · ${fmtAuditBool(audit.side_zone_valid)}`)
      ),
      ddt(
        "chase_blocked / retest / reclaim",
        stale
          ? `<span class="muted">—</span>`
          : esc(
              `${fmtAuditBool(audit.chase_blocked)} · ${fmtAuditBool(audit.display_retest_required || audit.retest_required)} · ${fmtAuditBool(audit.display_support_recheck_required || audit.reclaim_required)}`
            )
      ),
      ddt("expected_retest_direction", strField("expected_retest_direction")),
      ddt(
        "leverage_block_reason (표시 문장)",
        stale ? `<span class="muted">—</span>` : esc(koNoEntryLeverage(audit.leverage_block_reason))
      ),
      ddt(
        "recovery_mode_active · size_suppressed_by_recovery",
        stale
          ? `<span class="muted">—</span>`
          : esc(`${fmtAuditBool(audit.recovery_mode_active)} · ${fmtAuditBool(audit.size_suppressed_by_recovery)}`)
      ),
      ddt("updated_at (ts)", tsLine),
      ddt("age_ms", ageLine)
    ].join("");
  }

  /** V2 포지션 상세 섹션 렌더링.
   *  pos 객체에서 V2 전용 필드들을 읽어 "보유 포지션 상세" 블록으로 반환.
   *  데이터가 없으면 "API 응답에 없습니다" 경고 표시.
   */
  function renderV2PositionDetail(pos, mark, bundle, sym) {
    if (!pos) return "";

    // ── V2 필드 수집 ──────────────────────────────────────────────
    const side       = pos.side === "long" ? "LONG" : pos.side === "short" ? "SHORT" : String(pos.side || "—");
    const entryPrice = coerceFinite(pos.entryPrice);
    const markPrice  = mark !== null ? mark : coerceFinite(pos.currentPrice ?? pos.markPrice);
    const size       = coerceFinite(pos.sizeUsd) ?? coerceFinite(pos.notional);
    const leverage   = coerceFinite(pos.leverage);

    const unrealUsd  = coerceFinite(pos.unrealizedPnlUsd ?? pos.unrealizedPnl);
    const unrealPct  = coerceFinite(pos.unrealizedPnlPct);
    const stopPrice  = coerceFinite(pos.stopPrice);
    const tp1Price   = coerceFinite(pos.tp1Price ?? pos.targetPrice1 ?? pos.takeProfit1);
    const finalTp    = coerceFinite(pos.finalTpPrice ?? pos.finalTakeProfit ?? pos.targetPrice ?? pos.takeProfit);

    // V2 메타
    const entryReason = pos.v2EntryReason ?? pos.entryReason ?? pos.sourceSignal ?? null;
    const openedAt    = coerceFinite(pos.openedAt ?? pos.firstOpenedAt);
    const holdMinutes = openedAt !== null ? Math.floor((Date.now() - openedAt) / 60000) : null;

    // 보호 주문 / 동기화 상태
    const protectionStatus  = pos.protectionStatus  ?? pos.protectiveStatus  ?? pos.protective_status  ?? null;
    const probeTP1Submitted = pos.probeTP1Submitted ?? pos.probe_tp1_submitted ?? null;
    const probeTP1Filled    = pos.probeTP1Filled    ?? pos.probe_tp1_filled    ?? null;

    // 장부 / OKX 동기화 — pos 직접 필드 우선, 없으면 engineState ledger 참조
    let ledgerSyncStatus = pos.ledgerSyncStatus ?? pos.ledger_sync_status ?? null;
    let okxSyncStatus    = pos.okxSyncStatus    ?? pos.okx_sync_status    ?? null;
    if (!ledgerSyncStatus || !okxSyncStatus) {
      const sync = ledgerOkxSync(bundle);
      if (sync) {
        ledgerSyncStatus = ledgerSyncStatus ?? sync.sync_status ?? null;
        // OKX 동기화는 preview에서 해당 심볼 찾기
        const okxRow = okxExchangePositionForSymbol(bundle, sym);
        okxSyncStatus = okxSyncStatus ?? (okxRow ? "SYNCED" : sync.sync_status ?? null);
      }
    }

    // ── 데이터 존재 여부 체크 ──────────────────────────────────────
    const hasAnyV2Detail = entryPrice !== null || markPrice !== null || stopPrice !== null
      || tp1Price !== null || finalTp !== null || entryReason !== null
      || protectionStatus !== null || ledgerSyncStatus !== null || okxSyncStatus !== null;

    // ── 보호 주문 상태 레이블 ─────────────────────────────────────
    function fmtProtection(v) {
      if (v === null || v === undefined) return "—";
      const s = String(v).toLowerCase();
      if (s === "confirmed" || s === "active" || s === "ok" || s === "filled") return "정상";
      if (s === "pending" || s === "submitted" || s === "open") return "대기";
      if (s === "missing" || s === "none" || s === "failed") return "미확인";
      return esc(String(v));
    }

    // ── 장부 정합성 레이블 ────────────────────────────────────────
    function fmtSync(v) {
      if (v === null || v === undefined) return "—";
      const s = String(v).toUpperCase();
      if (s === "ALIGNED" || s === "SYNCED") return "ALIGNED";
      if (s === "REMOTE_UNAVAILABLE") return "확인 불가(원격 응답 없음)";
      if (s === "OKX_ONLY") return "OKX에만 있음 (장부 누락)";
      if (s === "LEDGER_ONLY") return "장부에만 있음 (OKX 없음)";
      if (s === "KEY_MISMATCH") return "ledger 정리 대기";
      if (s === "ENGINE_LEDGER_STALE" || s === "ENGINE_RECONCILE_PENDING") return "ledger 정리 대기";
      return esc(String(v));
    }

    // ── 미실현 손익 색상 ──────────────────────────────────────────
    const pnlCls = unrealUsd !== null ? pnlToneClass(unrealUsd) : "";

    // ── 진입 사유 한글 매핑 ───────────────────────────────────────
    const V2_REASON_KO = {
      EARLY_REVERSAL_SHORT_PROBE: "조기 반전 숏 프로브",
      EARLY_REVERSAL_LONG_PROBE:  "조기 반전 롱 프로브",
      FAST_TREND_SHIFT_SHORT:     "빠른 추세 전환 숏",
      FAST_TREND_SHIFT_LONG:      "빠른 추세 전환 롱",
      RANGE_REVERSAL_SHORT:       "레인지 반전 숏",
      RANGE_REVERSAL_LONG:        "레인지 반전 롱",
      TREND_CONTINUATION_LONG:    "추세 지속 롱",
      TREND_CONTINUATION_SHORT:   "추세 지속 숏",
      CORE_TREND_CONTINUATION:    "코어 추세 지속",
      CORE_PULLBACK_REVERSAL:     "코어 눌림 반전",
      CORE_BREAKOUT_VOLUME:       "코어 돌파 볼륨",
      paper_long_candidate:       "롱 후보 (레거시)",
      paper_short_candidate:      "숏 후보 (레거시)"
    };
    const reasonLabel = entryReason
      ? (V2_REASON_KO[entryReason] ? `${V2_REASON_KO[entryReason]} (${esc(entryReason)})` : esc(String(entryReason)))
      : "—";

    if (!hasAnyV2Detail) {
      return `
        <div class="v2-pos-detail v2-pos-detail--warn">
          <p class="v2-pos-detail-title">보유 포지션 상세</p>
          <p class="v2-pos-detail-empty">포지션 보유 중이나 상세 데이터가 API 응답에 없습니다.</p>
        </div>`;
    }

    function row(label, valHtml) {
      return `<div class="v2-pos-row"><span class="v2-pos-k">${label}</span><span class="v2-pos-v">${valHtml}</span></div>`;
    }

    const unrealDisplay = unrealUsd !== null
      ? `<span class="${pnlCls}">${esc(formatSignedUsd(unrealUsd))}${unrealPct !== null ? " (" + esc(formatSignedPctOnMargin(unrealUsd, unrealUsd / Math.max(unrealPct / 100, 0.0001))) + ")" : ""}</span>`
      : `<span class="muted">—</span>`;

    const unrealPctDisplay = unrealPct !== null
      ? `<span class="${pnlCls}">${unrealPct > 0 ? "+" : ""}${esc(unrealPct.toFixed(3))}%</span>`
      : `<span class="muted">—</span>`;

    const protColor = protectionStatus
      ? (String(protectionStatus).toLowerCase().match(/confirmed|active|ok|filled/) ? "v2-ok" : "v2-warn")
      : "";

    const syncColor = ledgerSyncStatus
      ? (String(ledgerSyncStatus).toUpperCase() === "ALIGNED" ? "v2-ok" : "v2-warn")
      : "";

    return `
      <div class="v2-pos-detail">
        <p class="v2-pos-detail-title">보유 포지션 상세</p>
        <div class="v2-pos-grid">
          ${row("방향",     `<strong class="pos-card-side pos-card-side--${pos.side === 'short' ? 'short' : 'long'}">${esc(side)}</strong>`)}
          ${row("진입가",   `<span class="tabular-nums">${entryPrice !== null ? esc(formatPrice(entryPrice)) : '<span class="muted">—</span>'}</span>`)}
          ${row("현재가",   `<span class="tabular-nums">${markPrice !== null ? esc(formatPrice(markPrice)) : '<span class="muted">—</span>'}</span>`)}
          ${row("수량(USD)", `<span class="tabular-nums">${size !== null ? esc(fmtUsdPosNoDecimal(size)) : '<span class="muted">—</span>'}</span>`)}
          ${row("레버리지", `<span class="tabular-nums">${leverage !== null ? esc(String(leverage)) + "×" : '<span class="muted">—</span>'}</span>`)}
          ${row("미실현 손익", unrealDisplay)}
          ${row("미실현 손익%", unrealPctDisplay)}
          ${row("손절가",   stopPrice !== null ? `<span class="tabular-nums v2-warn">${esc(formatPrice(stopPrice))}</span>` : '<span class="muted">미설정</span>')}
          ${row("TP1",      tp1Price  !== null ? `<span class="tabular-nums">${esc(formatPrice(tp1Price))}</span>`  : '<span class="muted">—</span>')}
          ${row("Final TP", finalTp   !== null ? `<span class="tabular-nums">${esc(formatPrice(finalTp))}</span>`   : '<span class="muted">—</span>')}
          ${row("진입 사유", reasonLabel)}
          ${row("보유 시간", holdMinutes !== null ? `<span class="tabular-nums">${esc(String(holdMinutes))}분</span>` : '<span class="muted">—</span>')}
          ${row("보호 주문", `<span class="${protColor}">${fmtProtection(protectionStatus)}</span>`)}
          ${probeTP1Submitted !== null ? row("Probe TP1 제출", `<span>${probeTP1Submitted === true || probeTP1Submitted === "true" ? "예" : "아니오"}</span>`) : ""}
          ${probeTP1Filled !== null    ? row("Probe TP1 체결", `<span>${probeTP1Filled    === true || probeTP1Filled    === "true" ? "예" : "아니오"}</span>`) : ""}
          ${row("장부 정합성", `<span class="${syncColor}">${fmtSync(ledgerSyncStatus)}</span>`)}
          ${row("OKX 동기화", `<span class="${okxSyncStatus ? (String(okxSyncStatus).toUpperCase() === 'SYNCED' || String(okxSyncStatus).toUpperCase() === 'ALIGNED' ? 'v2-ok' : 'v2-warn') : ''}">${okxSyncStatus ? esc(String(okxSyncStatus)) : '<span class="muted">—</span>'}</span>`)}
        </div>
      </div>`;
  }

  function renderSymbols(bundle) {

    const grid = $("symbol-grid");
    const want = ["BTCUSDT", "ETHUSDT"];
    const es = bundle.engineState;
    const curRegime = es && typeof es === "object" ? (es.current_regime || es.regime) : null;
    const recent = Array.isArray(bundle.eventsRecent) ? bundle.eventsRecent : [];

    function latestBlockedFor(sym) {
      for (let i = recent.length - 1; i >= 0; i--) {
        const e = recent[i];
        if (!e || e.symbol !== sym) continue;
        if (e.type === "ENTRY_BLOCKED" || e.type === "BLOCKED") return e;
      }
      return null;
    }

    function contextFor(sym, snap) {
      const b = latestBlockedFor(sym);
      if (b) {
        const sub =
          (b.reason === "AI_FILTER" || b.reason === "AI_REJECT") && b.detail && b.detail.ai_reason
            ? " · " + String(b.detail.ai_reason)
            : b.reason === "AI_DIRECTION_MISMATCH"
              ? " · 방향 불일치"
              : "";
        return { ctx: "blocked", reason: mapBlockReason(b.reason) + sub };
      }
      if (curRegime === "RANGE") return { ctx: "range", reason: null };
      if (curRegime === "TREND") {
        const hasBox = snap && typeof snap.boxHigh === "number" && typeof snap.boxLow === "number" && snap.boxHigh > snap.boxLow;
        const last = snap && typeof snap.lastPrice === "number" ? snap.lastPrice : null;
        const e20 = snap && typeof snap.ema20 === "number" ? snap.ema20 : null;
        const breakoutUp = hasBox && last !== null ? last >= snap.boxHigh * 1.0006 : false;
        const breakoutDn = hasBox && last !== null ? last <= snap.boxLow * 0.9994 : false;
        if (breakoutUp || breakoutDn) return { ctx: "breakout", reason: null };
        if (e20 !== null && last !== null) {
          const pb = last <= e20 * 1.006 && last >= e20 * 0.994;
          if (pb) return { ctx: "pullback", reason: null };
        }
        return { ctx: "pullback", reason: "추세 확인 대기" };
      }
      return { ctx: "blocked", reason: mapBlockReason("no_trade_regime") };
    }

    function noPositionStateBlock(sym, bundle) {
      const s = snapBySymbol(bundle, sym) || {};
      const st = noEntryCardState(bundle, s);
      const 가격 = formatPrice(s.lastPrice);
      const est = calculateEnhancedStatus(sym, bundle, null, s);

      const audit = pickNoEntryAuditRow(bundle, sym);
      const ageMs = audit ? noEntryAuditAgeMs(audit) : null;
      const stale = audit == null || (typeof ageMs === "number" && ageMs > NO_ENTRY_STALE_MS);

      let bannerHtml = "";
      if (stale) {
        bannerHtml = `<div class="sym-audit-stale-banner">${esc(
          "최근 판단 갱신 대기 · 아래 무진입 사유는 새 스냅샷까지 표시하지 않습니다"
        )}</div>`;
      }

      const metaHtml =
        !stale && audit && typeof audit.ts === "number"
          ? `<p class="sym-audit-meta">${esc("갱신 " + formatKst(audit.ts) + " · age " + Math.max(0, Math.round(ageMs ?? 0)) + " ms")}</p>`
          : "";

      return `
        <div class="sym-state-block">
          ${bannerHtml}
          <div class="sym-state-row">
            <span class="sym-state-k">상태</span>
            <span class="sym-state-v ${st.cls}">${esc(est.main)}</span>
          </div>
          <div class="sym-state-row">
            <span class="sym-state-k">현재 추세</span>
            <span class="sym-state-v sym-state-lead">${esc(est.trend)}</span>
          </div>
          <div class="sym-state-row">
            <span class="sym-state-k">다음 대기</span>
            <span class="sym-state-v">${esc(est.next)}</span>
          </div>
          <div class="sym-state-row">
            <span class="sym-state-k">현재 가격</span>
            <span class="sym-state-v tabular-nums">${esc(가격)}</span>
          </div>
          ${metaHtml}
        </div>`;
    }

    const cards = want.map((sym) => {
      const s = snapBySymbol(bundle, sym);
      const pos = openForSymbol(bundle, sym);
      const staleLedgerPos = staleLedgerForSymbol(bundle, sym);
      const ctx = contextFor(sym, s || {});

      if (!pos && staleLedgerPos) {
        const sideK =
          staleLedgerPos.side === "long" ? "LONG" : staleLedgerPos.side === "short" ? "SHORT" : String(staleLedgerPos.side ?? "—");
        return `
        <article class="sym-card sym-card--warn">
          <div class="v2-pos-fallback-banner">ledger stale reconcile · OKX actual position 없음</div>
          <header class="pos-card-head pos-card-head--compact">
            <span class="pos-card-titleline">
              <span class="pos-card-ticker">${esc(sym)}</span>
              <span class="pos-card-side">${esc(sideK)}</span>
            </span>
          </header>
          <div class="sym-state-block" style="border-top:1px solid rgba(255,255,255,0.05); padding-top:0.8rem;">
            <div class="sym-state-row">
              <span class="sym-state-k">상태</span>
              <span class="sym-state-v">실제 포지션 없음 / ledger 정리 대기</span>
            </div>
            <div class="sym-state-row">
              <span class="sym-state-k">reconcile</span>
              <span class="sym-state-v">${esc(String(staleLedgerPos.displayReconciliationState ?? "ledger_stale_reconcile"))}</span>
            </div>
          </div>
        </article>`;
      }

      // pos 소스 조기 판별 — cardClass 결정에 사용
      const posIsOkxFallback = pos
        && (pos.displaySource === "ledger_okx_sync_preview" || pos.displaySource === "position_ops_surface");

      let cardClass = "sym-card";
      if (pos && !posIsOkxFallback) cardClass += " sym-card--hold";
      else if (pos && posIsOkxFallback) cardClass += " sym-card--hold sym-card--unconfirmed";
      else if (s && s.signal && s.signal !== "none") cardClass += " sym-card--block";


      const dir =
        s && s.signal === "paper_long_candidate"
          ? "long"
          : s && s.signal === "paper_short_candidate"
            ? "short"
            : "none";

      const fund = s && typeof s.fundingRate === "number" ? formatRate(s.fundingRate) : "—";
      const strength = s && s.candidateStrength ? String(s.candidateStrength) : "—";
      const q = s && typeof s.qualityScore === "number" ? String(s.qualityScore) : "—";

      const pip = es && es.symbol_decisions && es.symbol_decisions[sym] && es.symbol_decisions[sym].decision ? es.symbol_decisions[sym].decision : null;
      const pipVer = pip && pip.pipeline_version ? String(pip.pipeline_version) : "—";
      const pipReject = pip && pip.reject_reason ? mapBlockReason(pip.reject_reason) : null;
      const pipSuppl = pip && Array.isArray(pip.supplemental_reasons) ? pip.supplemental_reasons : [];
      const fd = pip && pip.final_decision ? String(pip.final_decision) : null;
      const fdClass = fd === "ENTER" ? "sym-pip--enter" : fd === "REJECT" ? "sym-pip--reject" : "";

      const ambigTag = es && es.is_ambiguous ? " <small style='color:var(--warn)'>(모호)</small>" : "";

      if (pos) {
        // ── pos 소스 판별 ─────────────────────────────────────────
        // displaySource가 ledger_okx_sync_preview 또는 position_ops_surface이면
        // 실제 레저 포지션이 아닌 OKX 스냅샷 폴백이다 (openPositions=[]인 상태에서 파생).
        const isOkxFallback = pos.displaySource === "ledger_okx_sync_preview"
          || pos.displaySource === "position_ops_surface";

        const n = normalizeOpenPos(pos);
        const lev = n ? n.leverage : 1;
        const mark = n ? markForOpen(bundle, sym, pos, s) : null;
        const uPnLRaw = estimateNetPnlUsd(pos, mark);
        const uPnL = uPnLRaw !== null ? uPnLRaw : n && n.marginUsd !== null ? 0 : null;
        const sizeUsd = n ? n.sizeUsd : null;
        const marginUsd = n ? n.marginUsd : null;
        const uPct = fmtPctPos(uPnL, marginUsd);
        const uClass = pnlToneClass(typeof uPnL === "number" ? uPnL : 0);
        const realized = n ? n.realized : 0;
        const rClass = pnlToneClass(realized);
        const equity = marginUsd !== null && uPnL !== null ? marginUsd + uPnL : marginUsd;
        const esN = pos.entryStage != null && pos.entryStage > 0 ? pos.entryStage : 1;
        const pes = pos.partialExitStage ?? 0;
        const sideK = pos.side === "long" ? "LONG" : pos.side === "short" ? "SHORT" : String(pos.side);

        const stopPx = n ? n.stopPx : null;
        const stopNet = stopPx !== null ? estimateNetPnlUsd(pos, stopPx) : null;
        const entryDisp =
          n && n.entryPrice !== null ? formatPrice(n.entryPrice) : "N/A";
        const markDisp = mark !== null ? formatPrice(mark) : "N/A";

        const rb = getRegimeBadge(pos);
        const trueExternalManual = isTrueExternalManualForDisplay(pos);
        
        const okxRow = okxExchangePositionForSymbol(bundle, sym);
        const okxSide = okxRow ? okxRow.side : "없음";
        const ledgerSide = pos.side || "없음";
        const sideMismatch = okxRow && (okxRow.side !== pos.side);
        
        let reconcileBanner = "";
        if (sideMismatch) {
          reconcileBanner = `<div class="v2-pos-fallback-banner">포지션 동기화 불일치 · OKX actual 기준 감시 중 (OKX actual: ${esc(okxSide)} / Engine: ${esc(ledgerSide)} / manual evidence: ${trueExternalManual ? '확인' : '없음'})</div>`;
        } else if (trueExternalManual) {
          reconcileBanner = `<div class="v2-pos-fallback-banner">외부 수동 개입 확인 · ${esc(String(pos.reconcileState || pos.ledgerSyncStatus || "EXTERNAL_MANUAL"))}</div>`;
        } else if (syncMismatchIsLedgerStaleOnly(bundle)) {
          reconcileBanner = `<div class="v2-pos-fallback-banner">ledger 정리 대기 · OKX actual 기준 감시 유지</div>`;
        }
        const badgeHtml = rb ? `<span class="badge ${rb.cls}" style="margin-top:0; margin-left:0.5rem; vertical-align:middle;">${esc(rb.text)}</span>` : "";

        const isTrend = (pos.regimeAtEntry || pos.executorAtEntry || pos.strategy) === "TREND";
        const isRange = (pos.regimeAtEntry || pos.executorAtEntry || pos.strategy) === "RANGE";

        let exitTargetLabel = "익절가";
        let exitTargetValue = "익절가 미설정";
        if (isTrend) {
          exitTargetLabel = "추세 청산 기준";
          const trail = coerceFinite(pos.trailingStopPrice);
          const inv = coerceFinite(pos.trendInvalidationPrice);
          if (trail !== null || inv !== null) {
            exitTargetValue = trail !== null ? formatPrice(trail) : formatPrice(inv);
          } else {
            exitTargetValue = "추세 청산 기준 미설정";
          }
        } else if (isRange) {
          const tp1 = coerceFinite(pos.targetPrice1);
          const tp = coerceFinite(pos.takeProfit);
          if (tp1 !== null || tp !== null) {
            exitTargetValue = formatPrice(tp1 ?? tp);
          } else {
            exitTargetValue = "익절가 미설정";
          }
        }

        // ── est: 포지션 상태 텍스트 ────────────────────────────────
        // OKX 폴백(레저 없음)이면 calculateEnhancedStatus 대신 명시적 경고 텍스트 사용.
        const est = isOkxFallback
          ? {
              main: "원격 확인 불가 / 상태 확인 필요",
              trend: "OKX 응답 없음 — 레저 포지션 없음",
              risk: "장부에 포지션 없음 (displaySource: " + esc(String(pos.displaySource)) + ")",
              next: "엔진 재동기화 대기"
            }
          : calculateEnhancedStatus(sym, bundle, pos, s);

        return `
        <article class="${cardClass}">
          ${isOkxFallback ? `<div class="v2-pos-fallback-banner">⚠ 레저 포지션 미확인 — OKX 스냅샷 폴백 데이터입니다. 실제 포지션 여부를 직접 확인하세요.</div>` : reconcileBanner}
          <div class="pos-money-strip pos-money-strip--primary" aria-label="포지션 손익 5항목">
            <div class="pos-money-cell">
              <span class="pos-money-num tabular-nums">${esc(fmtUsdPosNoDecimal(sizeUsd))}</span>
              <span class="pos-money-lbl">진입금액(USD)</span>
            </div>
            <div class="pos-money-cell">
              <span class="pos-money-num tabular-nums">${esc(fmtUsdPosNoDecimal(equity))}</span>
              <span class="pos-money-lbl">현재 평가금액(USD)</span>
            </div>
            <div class="pos-money-cell">
              <span class="pos-money-num tabular-nums ${uClass}">${esc(fmtSignedUsdPosNoDecimal(uPnL))}</span>
              <span class="pos-money-lbl">지금 청산 순손익(USD)</span>
            </div>
            <div class="pos-money-cell">
              <span class="pos-money-num tabular-nums ${uClass}">${esc(uPct)}</span>
              <span class="pos-money-lbl">순수익률</span>
            </div>
            <div class="pos-money-cell">
              <span class="pos-money-num tabular-nums">${esc(fmtHoldPos(n && n.openedAt))}</span>
              <span class="pos-money-lbl">보유시간</span>
            </div>
          </div>
          <header class="pos-card-head pos-card-head--compact">
            <span class="pos-card-titleline">
              <span class="pos-card-ticker">${esc(sym)}</span> 
              <span class="pos-card-side pos-card-side--${pos.side === "short" ? "short" : "long"}">${esc(sideK)}</span>
              ${badgeHtml}
            </span>
          </header>

          <div class="sym-state-block" style="border-top:1px solid rgba(255,255,255,0.05); padding-top:0.8rem; margin-bottom:0.8rem;">
            <div class="sym-state-row">
              <span class="sym-state-k">상태</span>
              <span class="sym-state-v sym-state-held">${esc(est.main)}</span>
            </div>
            <div class="sym-state-row">
              <span class="sym-state-k">현재 추세</span>
              <span class="sym-state-v sym-state-lead">${esc(est.trend)}</span>
            </div>
            <div class="sym-state-row">
              <span class="sym-state-k">위험 상태</span>
              <span class="sym-state-v">${esc(est.risk)}</span>
            </div>
            <div class="sym-state-row">
              <span class="sym-state-k">다음 판단</span>
              <span class="sym-state-v">${esc(est.next)}</span>
            </div>
          </div>

          <div class="pos-sub-strip">
            <div class="pos-sub-item"><span class="pos-sub-k">진입가</span><span class="pos-sub-v tabular-nums">${esc(entryDisp)}</span></div>
            <div class="pos-sub-item"><span class="pos-sub-k">현재가(Mark)</span><span class="pos-sub-v tabular-nums">${esc(markDisp)}</span></div>
            <div class="pos-sub-item"><span class="pos-sub-k">손익(USD)</span><span class="pos-sub-v tabular-nums ${uClass}">${esc(formatUsd(uPnL))}</span></div>
            <div class="pos-sub-item"><span class="pos-sub-k">수익률</span><span class="pos-sub-v tabular-nums ${uClass}">${esc(uPct)}</span></div>
            <div class="pos-sub-item"><span class="pos-sub-k">손절가</span><span class="pos-sub-v tabular-nums">${esc(fmtStopLabel(stopPx))}</span></div>
            <div class="pos-sub-item"><span class="pos-sub-k">${esc(exitTargetLabel)}</span><span class="pos-sub-v tabular-nums">${esc(exitTargetValue)}</span></div>
          </div>
          ${renderV2PositionDetail(pos, mark, bundle, sym)}
          <details class="sym-details">
            <summary>레버리지·파이프라인·운용 상세</summary>
            <dl class="sym-meta">
              ${noEntryAuditDetailHtml(sym, bundle)}
              <dt>레버리지</dt><dd>${esc(String(lev))}×</dd>
              <dt>진입가</dt><dd>${esc(entryDisp)}</dd>
              <dt>현재가(Mark)</dt><dd>${esc(markDisp)}</dd>
              <dt>손절가</dt><dd>${esc(fmtStopLabel(stopPx))}</dd>
              <dt>${esc(exitTargetLabel)}</dt><dd>${esc(exitTargetValue)}</dd>
              <dt>누적 실현</dt><dd class="${rClass}">${esc(fmtRealizedLabel(realized))}</dd>
              <dt>익절 진행</dt><dd>${esc(String(pes))}/3</dd>
              <dt>진입 단계</dt><dd>${esc(String(esN))}/3</dd>
              <dt>손절 시 순손익</dt><dd>${esc(fmtSignedUsdPos(stopNet))}</dd>
              ${typeof pos.unrealizedPnlPct === "number" ? `<dt>엔진 uPnL%</dt><dd>${esc(String(pos.unrealizedPnlPct.toFixed(2)))}%</dd>` : ""}
              ${pip ? `<dt>파이프라인</dt><dd>v${esc(pipVer)}</dd>` : ""}
              ${sym === "BTCUSDT" && pip && pip.signal_missing_reason
            ? `<dt>신호 진단</dt><dd style="font-size:0.8rem">${esc(String(pip.signal_missing_reason))}</dd>`
            : ""}
              ${sym === "BTCUSDT" && pip && pip.stage1_result_code
            ? `<dt>Stage1 코드</dt><dd style="font-size:0.8rem">${esc(String(pip.stage1_result_code))}</dd>`
            : ""}
              ${sym === "ETHUSDT" && pip
            ? `<dt>요구이동·부족</dt><dd style="font-size:0.8rem">req ${pip.required_move_pct != null ? esc(String(Number(pip.required_move_pct).toFixed(4))) : "—"}% · shortfall ${pip.shortfall_pct != null ? esc(String(Number(pip.shortfall_pct).toFixed(4))) : "—"}%</dd>`
            : ""}
              ${pip ? `<dt>signal</dt><dd class="${fdClass}">${esc(String(pip.signal_state))}</dd>` : ""}
              ${pip ? `<dt>regime</dt><dd>${esc(String(pip.regime_state))}${ambigTag}</dd>` : ""}
              ${pip ? `<dt>edge / risk / exec</dt><dd>${esc(String(pip.edge_state))} · ${esc(String(pip.risk_state))} · ${esc(String(pip.execution_state))}</dd>` : ""}
              ${pip ? `<dt>final</dt><dd class="${fdClass}"><strong>${esc(String(pip.final_decision))}</strong></dd>` : ""}
              ${pipReject ? `<dt>reject</dt><dd>${esc(pipReject)}</dd>` : ""}
              ${pipSuppl.length > 0 ? `<dt>상세 사유</dt><dd style="font-size:0.75rem; color:var(--muted)">${pipSuppl.map((r) => esc(mapBlockReason(r))).join(", ")}</dd>` : ""}
              ${pip ? `<dt>실행기</dt><dd>${esc(String(pip.strategy_executor))}</dd>` : ""}
              <dt>데이터 시각</dt><dd>${esc(formatKst(s && s.fetchedAt))}</dd>
              <dt>펀딩(원시)</dt><dd>${esc(fund)}</dd>
            </dl>
          </details>
        </article>`;
      }

      return `
        <article class="${cardClass}">
          <h3 class="sym-headline">${esc(sym)}</h3>
          ${noPositionStateBlock(sym, bundle)}
          <details class="sym-details">
            <summary>스냅샷·파이프라인·차단 상세</summary>
            <dl class="sym-meta">
            ${noEntryAuditDetailHtml(sym, bundle)}
            <dt>방향</dt><dd>${esc(dir)}</dd>
            <dt>컨텍스트</dt><dd>${esc(ctx.ctx)}${ctx.reason ? " · " + esc(ctx.reason) : ""}</dd>
            ${pip ? `<dt>파이프라인</dt><dd>v${esc(pipVer)}</dd>` : ""}
            ${sym === "BTCUSDT" && pip && pip.signal_missing_reason
          ? `<dt>신호 진단</dt><dd style="font-size:0.8rem">${esc(String(pip.signal_missing_reason))}</dd>`
          : ""}
            ${sym === "BTCUSDT" && pip && pip.stage1_result_code
          ? `<dt>Stage1</dt><dd style="font-size:0.8rem">${esc(String(pip.stage1_result_code))}</dd>`
          : ""}
            ${sym === "ETHUSDT" && pip
          ? `<dt>요구이동·부족·S1완화</dt><dd style="font-size:0.8rem">req ${pip.required_move_pct != null ? esc(String(Number(pip.required_move_pct).toFixed(4))) : "—"}% · shortfall ${pip.shortfall_pct != null ? esc(String(Number(pip.shortfall_pct).toFixed(4))) : "—"}% · leniency ${pip.stage1_leniency_applied === true ? "Y" : pip.stage1_leniency_applied === false ? "N" : "—"}</dd>`
          : ""}
            ${pip ? `<dt>signal</dt><dd class="${fdClass}">${esc(String(pip.signal_state))}</dd>` : ""}
            ${pip ? `<dt>regime</dt><dd>${esc(String(pip.regime_state))}${ambigTag}</dd>` : ""}
            ${pip ? `<dt>edge</dt><dd>${esc(String(pip.edge_state))}</dd>` : ""}
            ${pip ? `<dt>risk</dt><dd>${esc(String(pip.risk_state))}</dd>` : ""}
            ${pip ? `<dt>execution</dt><dd>${esc(String(pip.execution_state))}</dd>` : ""}
            ${pip ? `<dt>final</dt><dd class="${fdClass}"><strong>${esc(String(pip.final_decision))}</strong></dd>` : ""}
            ${pipReject ? `<dt>reject</dt><dd>${esc(pipReject)}</dd>` : ""}
            ${pipSuppl.length > 0 ? `<dt>상세 사유</dt><dd style="font-size:0.75rem; color:var(--muted)">${pipSuppl.map((r) => esc(mapBlockReason(r))).join(", ")}</dd>` : ""}
            ${pip ? `<dt>실행기</dt><dd>${esc(String(pip.strategy_executor))}</dd>` : ""}
            <dt>현재가</dt><dd>${esc(formatPrice(s && s.lastPrice))}</dd>
            <dt>데이터 시각</dt><dd>${esc(formatKst(s && s.fetchedAt))}</dd>
            <dt>펀딩(원시)</dt><dd>${esc(fund)}</dd>
            <dt>신호 강도(점수)</dt><dd>${esc(q)} · ${esc(strength)}</dd>
          </dl>
          </details>
        </article>
      `;
    });
    grid.innerHTML = cards.join("");
  }

  function formatRate(r) {
    return r.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
  }

  function renderPerf(bundle) {
    $("perf-note").textContent = renderPerfNote(bundle);
    const w7 = perfSlice(bundle, "last7d");
    const w30 = perfSlice(bundle, "last30d");
    const all = perfSlice(bundle, "all");
    const mtd = perfSlice(bundle, "monthToDate");

    function card(title, slice) {
      if (!slice) {
        return `<div class="perf-card"><h4>${esc(title)}</h4><p class="perf-metric">데이터 없음</p></div>`;
      }
      const gross = slice.totalPnlUsdGross;
      const fee = slice.totalFeeUsd;
      const fund = slice.totalFundingUsd;
      const hasLedgerDetail =
        typeof gross === "number" &&
        Number.isFinite(gross) &&
        typeof fee === "number" &&
        Number.isFinite(fee) &&
        typeof fund === "number" &&
        Number.isFinite(fund);
      const extra = hasLedgerDetail
        ? `<p class="perf-metric muted text-xs" style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.5rem">상세 수익 구조: gross ${formatUsd(
          gross
        )} · 수수료 ${formatUsd(fee)} · 펀딩 ${formatUsd(fund)}</p>`
        : "";
      const net = typeof slice.totalPnlUsdNet === "number" ? slice.totalPnlUsdNet : null;
      const netCls = net !== null ? pnlToneClass(net) : "pnl-zero";
      const netDisplay = net !== null ? formatSignedUsd(net) : "—";
      return `
        <div class="perf-card">
          <h4>${esc(title)}</h4>
          <p class="perf-metric perf-metric--lead"><span class="muted">순손익</span> <strong class="perf-pnl ${netCls} tabular-nums">${esc(netDisplay)}</strong></p>
          <p class="perf-metric">거래 <strong>${formatCount(slice.totalTrades)}</strong> · 승률 <strong>${formatPct(slice.winRate)}</strong></p>
          ${extra}
        </div>
      `;
    }

    const rangeAll = bundle.summaryRange;
    const trendAll = bundle.summaryTrend;
    const modeCard = (title, s) => {
      if (!s || typeof s !== "object") {
        return `<div class="perf-card"><h4>${esc(title)}</h4><p class="perf-metric">데이터 없음</p></div>`;
      }
      return `
        <div class="perf-card">
          <h4>${esc(title)}</h4>
          <p class="perf-metric">거래 수 <strong>${formatCount(s.totalTrades)}</strong></p>
          <p class="perf-metric">승률 <strong>${formatPct(s.winRate)}</strong></p>
          <p class="perf-metric">gross/fee/net <strong>${formatUsd(s.totalPnlUsdGross)}</strong> / ${formatUsd(
        s.totalFeeUsd
      )} / <strong class="perf-pnl">${formatUsd(s.totalPnlUsdNet)}</strong></p>
          <p class="perf-metric muted text-xs">avg net/trade ${formatUsd(s.averagePnlUsdNet)} · fee/gross ${formatRatioPlain(
        s.feeToGrossRatio
      )}</p>
        </div>
      `;
    };

    $("perf-row").innerHTML =
      card("전체 누적", all) + modeCard("RANGE 성과", rangeAll) + modeCard("TREND 성과", trendAll);

    renderFeeAnalytics(bundle);

    const mtdEl = $("panel-mtd");
    mtdEl.innerHTML =
      '<div class="perf-card" style="border:0;padding:0;background:transparent">' +
      card("이번 달 (참고 · 30일과 겹칠 수 있음)", mtd) +
      "</div>";
  }

  function renderBlockedCard(bundle) {
    const box = $("blocked-card");
    if (!box) return;
    const es = bundle.engineState;
    const allowed = es && typeof es === "object" ? es.entryAllowed : null;
    const reasons = es && typeof es === "object" && Array.isArray(es.blockedReasons) ? es.blockedReasons : [];
    const primary = reasons.length > 0 ? reasons[0] : es && typeof es === "object" ? es.blocked_reason || es.blockedReason : null;

    const recent = Array.isArray(bundle.eventsRecent) ? bundle.eventsRecent : [];
    const blocked = recent
      .filter((e) => e && (e.type === "ENTRY_BLOCKED" || e.type === "BLOCKED"))
      .slice(-5)
      .reverse();
    const rows =
      blocked.length === 0
        ? '<p class="muted text-xs">최근 차단 이벤트 없음</p>'
        : `<ul class="health-list">${blocked
          .map((e) => {
            const sym = e.symbol || "—";
            const rg = e.regime || "—";
            const ex = mapExecutorDisplay(e.executor);
            const rs = mapBlockReason(e.reason);
            const sub =
              (e.reason === "AI_FILTER" || e.reason === "AI_REJECT" || e.reason === "AI_DIRECTION_MISMATCH") &&
                e.detail &&
                e.detail.ai_reason
                ? " · " + String(e.detail.ai_reason)
                : e.reason === "AI_DIRECTION_MISMATCH"
                  ? " · 방향 불일치"
                  : "";
            return `<li><div><strong>${esc(sym)}</strong> · ${esc(rg)} · ${esc(ex)} · ${esc(rs)}${esc(sub)}</div><div class="muted text-xs">${esc(
              formatKst(e.ts)
            )}</div></li>`;
          })
          .join("")}</ul>`;

    box.innerHTML = `
      <div class="perf-card">
        <h4>차단 이유</h4>
        <p class="perf-metric">현재 진입: <strong>${allowed === false ? "차단" : allowed === true ? "가능" : "—"}</strong></p>
        <p class="perf-metric">현재 사유: <strong>${esc(mapBlockReason(primary))}</strong></p>
        ${renderAiBlockedTop(bundle)}
        <div style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem">
          <p class="panel-title">최근 차단(최신 5)</p>
          ${rows}
        </div>
      </div>
    `;
  }

  function renderAiBlockedTop(bundle) {
    const s = bundle.summary;
    const ai = s && s.observation && s.observation.aiApproval ? s.observation.aiApproval : null;
    if (!ai) return "";
    const counts = ai.blocked_reason_counts || {};
    const top = Object.entries(counts)
      .filter(([k]) => k === "AI_FILTER" || k === "AI_REJECT" || k === "AI_DIRECTION_MISMATCH")
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 3);
    if (top.length === 0) return "";
    const line = top.map(([k, v]) => mapBlockReason(k) + " " + String(v)).join(" · ");
    const q = bundle.summary && bundle.summary.observation ? bundle.summary.observation.aiBlockQuality : null;
    const qRate = q && typeof q.ai_block_quality_rate === "number" ? formatPct(q.ai_block_quality_rate) : "—";
    const c = q && q.criteria ? q.criteria : null;
    const cLine = c
      ? ` · 기준 good ≤ ${String(c.good_block_threshold_pct)}% / missed ≥ ${String(c.missed_opportunity_threshold_pct)}%`
      : "";
    const qLine =
      q
        ? ` · 품질 good ${String(q.ai_block_good_count)} / missed ${String(q.ai_block_missed_count)} / neutral ${String(
          q.ai_block_neutral_count
        )} (${qRate})${cLine}`
        : "";
    return `<p class="perf-metric muted text-xs">최근 AI 차단 Top: ${esc(line)}${esc(qLine)}</p>`;
  }

  function renderDetails(bundle) {
    const trend = bundle.dashboard && bundle.dashboard.recentTrend;
    const changed = trend && trend.changed;
    const counts = (trend && trend.statusCounts) || {};
    const statuses = Array.isArray(trend && trend.latestStatuses) ? trend.latestStatuses : [];

    const countLines = Object.entries(counts)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `<li><span class="pill">${esc(mapStatus(k))}</span> ${esc(String(v))}회</li>`)
      .join("");

    const chain = statuses
      .map((st) => `<span class="pill">${esc(mapStatus(st))}</span>`)
      .join('<span class="sep">→</span>');

    $("panel-trend").innerHTML = `
      <p class="muted text-xs">직전 대비: ${changed === true ? "변경 있음" : changed === false ? "변경 없음" : "—"}</p>
      <p class="panel-title">최근 상태 (최신→과거)</p>
      <div class="chain">${chain || "<span class='muted'>데이터 없음</span>"}</div>
      <p class="panel-title">상태 카운트(최근 10회 구간)</p>
      <ul class="health-list">${countLines || "<li class='muted'>데이터 없음</li>"}</ul>
    `;

    const hh = bundle.healthHistoryRecent || [];
    const rev = [...hh].reverse();
    $("panel-health").innerHTML =
      rev.length === 0
        ? '<p class="muted">데이터 없음</p>'
        : `<ul class="health-list">${rev
          .map((h) => {
            const rs = Array.isArray(h.reasons) ? h.reasons : [];
            const tags = rs.map((r) => `<span class="reason-tag">${esc(mapReason(r))}</span>`).join("");
            return `<li><div>${esc(formatKst(h.generatedAt))} · ${esc(mapStatus(h.status))}</div><div class="reason-tags">${tags}</div></li>`;
          })
          .join("")}</ul>`;
  }

  function show(el, on) {
    el.classList.toggle("hidden", !on);
  }

  function apiBaseAndToken() {
    const base = sessionStorage.getItem(STORAGE_BASE) || "";
    const token = sessionStorage.getItem(STORAGE_TOKEN) || "";
    const origin = window.location.origin.replace(/\/$/, "");
    const apiBase = (base || origin).replace(/\/$/, "");
    return { apiBase, token };
  }

  async function fetchBundle() {
    const { apiBase, token } = apiBaseAndToken();
    const url = apiBase + "/api/futures-paper/data";
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-orbitalpha-futures-paper-token": token,
        Authorization: token ? "Bearer " + token : ""
      },
      cache: "no-store"
    });
    if (res.status === 401 || res.status === 403) throw new Error("인증 실패 · 토큰을 확인하세요.");
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function fetchTradeControl() {
    const { apiBase, token } = apiBaseAndToken();
    const res = await fetch(apiBase + "/api/futures-paper/control", {
      method: "GET",
      headers: {
        "x-orbitalpha-futures-paper-token": token,
        Authorization: token ? "Bearer " + token : ""
      },
      cache: "no-store"
    });
    if (!res.ok) throw new Error("control GET 실패: HTTP " + res.status);
    return res.json();
  }

  async function updateTradeControl(patch) {
    const { apiBase, token } = apiBaseAndToken();
    const res = await fetch(apiBase + "/api/futures-paper/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orbitalpha-futures-paper-token": token,
        Authorization: token ? "Bearer " + token : ""
      },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw new Error("control POST 실패: HTTP " + res.status);
    return res.json();
  }

  function tradeControlStatusLine(control) {
    if (!control) return { text: "상태 불러오기 실패", cls: "off" };
    if (control.killSwitch) return { text: "킬스위치", cls: "off" };
    if (control.closeOnlyMode) return { text: "청산 전용", cls: "warn" };
    if (control.serverTradeEnabled) return { text: "자동매매 ON", cls: "on" };
    return { text: "자동매매 OFF", cls: "off" };
  }

  function renderTradeControlCard() {
    const wrap = $("trade-control-card");
    if (!wrap) return;
    const status = tradeControlStatusLine(currentTradeControl);
    const c = currentTradeControl;
    wrap.innerHTML = `
      <article class="control-card">
        <p class="control-status ${esc(status.cls)}">${esc(status.text)}</p>
        <div class="control-actions">
          <button type="button" class="btn btn-primary" id="btn-control-on">자동매매 ON</button>
          <button type="button" class="btn btn-ghost" id="btn-control-off">자동매매 OFF</button>
          <button type="button" class="btn btn-ghost" id="btn-control-closeonly">청산 전용</button>
          <button type="button" class="btn btn-ghost" id="btn-control-killswitch">킬스위치</button>
        </div>
        <p class="control-meta">
          updatedAt: ${esc(formatKst(c && c.updatedAt))} · updatedBy: ${esc((c && c.updatedBy) || "—")}
          ${c && c.reason ? " · reason: " + esc(c.reason) : ""}
        </p>
      </article>
    `;
    $("btn-control-on").addEventListener("click", async () => {
      try {
        await updateTradeControl({ serverTradeEnabled: true, closeOnlyMode: false, killSwitch: false, updatedBy: "monitor_ui", reason: "operator_enable" });
        currentTradeControl = await fetchTradeControl();
        renderTradeControlCard();
      } catch (e) {
        const errEl = $("msg-error");
        show(errEl, true);
        errEl.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    $("btn-control-off").addEventListener("click", async () => {
      try {
        await updateTradeControl({ serverTradeEnabled: false, closeOnlyMode: false, killSwitch: false, updatedBy: "monitor_ui", reason: "operator_disable" });
        currentTradeControl = await fetchTradeControl();
        renderTradeControlCard();
      } catch (e) {
        const errEl = $("msg-error");
        show(errEl, true);
        errEl.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    $("btn-control-closeonly").addEventListener("click", async () => {
      try {
        await updateTradeControl({ serverTradeEnabled: false, closeOnlyMode: true, killSwitch: false, updatedBy: "monitor_ui", reason: "operator_close_only" });
        currentTradeControl = await fetchTradeControl();
        renderTradeControlCard();
      } catch (e) {
        const errEl = $("msg-error");
        show(errEl, true);
        errEl.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    $("btn-control-killswitch").addEventListener("click", async () => {
      try {
        await updateTradeControl({ serverTradeEnabled: false, closeOnlyMode: false, killSwitch: true, updatedBy: "monitor_ui", reason: "operator_kill_switch" });
        currentTradeControl = await fetchTradeControl();
        renderTradeControlCard();
      } catch (e) {
        const errEl = $("msg-error");
        show(errEl, true);
        errEl.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }

  async function load() {
    const errEl = $("msg-error");
    const loadEl = $("msg-loading");
    const cfgEl = $("msg-config");
    show(errEl, false);
    show(cfgEl, false);
    show(loadEl, true);
    $("last-fetch").textContent = "요청 중…";
    try {
      const [bundle, control] = await Promise.all([fetchBundle(), fetchTradeControl()]);
      currentTradeControl = control;
      show(loadEl, false);
      if (!bundle.configured) {
        show(cfgEl, true);
        cfgEl.textContent = bundle.configHint || "번들 미구성";
        return;
      }
      renderHero(bundle);
      renderOkxHero(bundle);
      renderTradeControlCard();
      renderExternalMarketContext(bundle);
      renderOperatorContext(bundle);
      renderSymbols(bundle);
      renderPerf(bundle);
      renderBlockedCard(bundle);
      renderDetails(bundle);
      $("last-fetch").textContent = "갱신: " + formatKst(Date.now());
    } catch (e) {
      show(loadEl, false);
      show(errEl, true);
      errEl.textContent = e instanceof Error ? e.message : String(e);
      $("last-fetch").textContent = "실패";
    }
  }

  function initAuth() {
    $("input-base").value = sessionStorage.getItem(STORAGE_BASE) || "";
    $("input-token").value = sessionStorage.getItem(STORAGE_TOKEN) || "";
    $("btn-save-auth").addEventListener("click", () => {
      sessionStorage.setItem(STORAGE_BASE, $("input-base").value.trim());
      sessionStorage.setItem(STORAGE_TOKEN, $("input-token").value.trim());
      load();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initAuth();
    $("btn-refresh").addEventListener("click", () => load());
    load();
    setInterval(() => void load(), 5000);
  });
})();
