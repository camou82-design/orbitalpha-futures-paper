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
    risk_off: "위험회피 구간"
  };

  const MAX_OPEN = 3;

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

  function getOpenPositions(bundle) {
    const o = bundle.openPositions;
    return Array.isArray(o) ? o.filter((x) => x && x.status === "open") : [];
  }

  function openForSymbol(bundle, sym) {
    return getOpenPositions(bundle).find((p) => p.symbol === sym) || null;
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

  function inferMarketNarrative(bundle) {
    const meta = bundle.latestMeta;
    const snaps = getSnapshots(bundle);
    const opens = getOpenPositions(bundle);
    const modes = new Set();
    for (const o of opens) {
      const m = o.adaptiveModeAtEntry;
      if (m === "trend" || m === "sideways" || m === "risk_off") modes.add(m);
    }
    let modeLine = "";
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
    if (opens.length === 0) {
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
    const title = opens.length === 1 ? sides[0] + " 보유 중" : opens.length + "개 포지션 보유 · " + sides.join(", ");
    return { title, sub: "종목별 손익은 카드에서 확인", badge: "badge-ok" };
  }

  function symbolHeadline(sym, bundle) {
    const pos = openForSymbol(bundle, sym);
    const s = snapBySymbol(bundle, sym) || {};
    const mark = typeof s.lastPrice === "number" ? s.lastPrice : null;
    if (pos) {
      const sideK = pos.side === "long" ? "롱" : pos.side === "short" ? "숏" : pos.side;
      const pnl = estimatePnlUsd(pos, mark);
      const pnlStr = pnl !== null ? " · 추정 손익 " + formatUsd(pnl) : "";
      return sym + " · " + sideK + " 포지션 보유 중" + pnlStr;
    }
    const sig = s.signal || "none";
    if (sig === "paper_long_candidate") return sym + " · 롱 후보 감지";
    if (sig === "paper_short_candidate") return sym + " · 숏 후보 감지";
    return sym + " · 신규 진입 없음(중립)";
  }

  function symbolOneLiner(sym, bundle) {
    const pos = openForSymbol(bundle, sym);
    const s = snapBySymbol(bundle, sym) || {};
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
    const nar = inferMarketNarrative(bundle);
    const entry = entryAggregate(bundle);
    const pos = positionHeroLine(bundle);
    const blk = primaryBlock(bundle);
    const perf = perfSlice(bundle, "last7d");
    const perf30 = perfSlice(bundle, "last30d");
    const all = perfSlice(bundle, "all");

    const toneClass =
      blk.tone === "danger" ? "hero-card--danger" : blk.tone === "warn" ? "hero-card--warn" : "";

    const hero = $("hero");
    hero.innerHTML = `
      <article class="hero-card hero-card--accent">
        <p class="hero-label">시장 맥락</p>
        <p class="hero-value">${esc(nar.context || "스냅샷 분석 중")}</p>
        <p class="hero-sub">${esc(nar.modeLine)}</p>
        <p class="hero-sub muted">${esc(nar.sub)}</p>
      </article>
      <article class="hero-card hero-card--accent">
        <p class="hero-label">현재 포지션</p>
        <p class="hero-value">${esc(pos.title)}</p>
        <p class="hero-sub">${esc(pos.sub)}</p>
        <span class="badge ${pos.badge}">포지션</span>
      </article>
      <article class="hero-card">
        <p class="hero-label">신규 진입 상태</p>
        <p class="hero-value">${esc(entry.title)}</p>
        <p class="hero-sub">${esc(entry.detail)}</p>
        <span class="badge ${entry.badge}">진입</span>
      </article>
      <article class="hero-card ${toneClass}">
        <p class="hero-label">핵심 차단·주의</p>
        <p class="hero-value">${esc(blk.text)}</p>
      </article>
      <article class="hero-card hero-card--wide">
        <p class="hero-label">핵심 성과</p>
        <p class="hero-value tabular-nums">7일 ${formatUsd(perf && perf.totalPnlUsdNet)} · 30일 승률 ${formatPct(
      perf30 && perf30.winRate
    )} · 누적 ${formatUsd(all && all.totalPnlUsdNet)}</p>
        <p class="hero-sub">거래 수 7일/30일/전체: ${formatCount(perf && perf.totalTrades)} / ${formatCount(
      perf30 && perf30.totalTrades
    )} / ${formatCount(all && all.totalTrades)}</p>
      </article>
    `;
  }

  function formatCount(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return String(Math.trunc(n));
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderSymbols(bundle) {
    const grid = $("symbol-grid");
    const want = ["BTCUSDT", "ETHUSDT"];
    const cards = want.map((sym) => {
      const s = snapBySymbol(bundle, sym);
      const pos = openForSymbol(bundle, sym);
      const headline = symbolHeadline(sym, bundle);
      const line = symbolOneLiner(sym, bundle);
      let cardClass = "sym-card";
      if (pos) cardClass += " sym-card--hold";
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

      return `
        <article class="${cardClass}">
          <h3 class="sym-headline">${esc(sym)}</h3>
          <p class="sym-one-liner">${esc(headline)}</p>
          <p class="sym-one-liner" style="font-size:0.85rem;font-weight:400;color:var(--muted)">${esc(line)}</p>
          <dl class="sym-meta">
            <dt>방향</dt><dd>${esc(dir)}</dd>
            <dt>상태 요약</dt><dd>${esc(pos ? "포지션 보유" : s && s.entryCandidate ? "후보 단계" : "차단·중립")}</dd>
            <dt>현재가</dt><dd>${esc(formatPrice(s && s.lastPrice))}</dd>
            <dt>데이터 시각</dt><dd>${esc(formatKst(s && s.fetchedAt))}</dd>
            <dt>펀딩(원시)</dt><dd>${esc(fund)}</dd>
            <dt>신호 강도(점수)</dt><dd>${esc(q)} · ${esc(strength)}</dd>
          </dl>
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
      return `
        <div class="perf-card">
          <h4>${esc(title)}</h4>
          <p class="perf-metric">거래 수 <strong>${formatCount(slice.totalTrades)}</strong></p>
          <p class="perf-metric">승률 <strong>${formatPct(slice.winRate)}</strong></p>
          <p class="perf-metric">순손익 <strong class="perf-pnl">${formatUsd(slice.totalPnlUsdNet)}</strong></p>
          ${extra}
        </div>
      `;
    }

    $("perf-row").innerHTML =
      card("전체 누적", all) + card("최근 7일", w7) + card("최근 30일", w30);

    const mtdEl = $("panel-mtd");
    mtdEl.innerHTML =
      '<div class="perf-card" style="border:0;padding:0;background:transparent">' +
      card("이번 달 (참고 · 30일과 겹칠 수 있음)", mtd) +
      "</div>";
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

  async function fetchBundle() {
    const base = sessionStorage.getItem(STORAGE_BASE) || "";
    const token = sessionStorage.getItem(STORAGE_TOKEN) || "";
    const origin = window.location.origin.replace(/\/$/, "");
    const apiBase = (base || origin).replace(/\/$/, "");
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

  async function load() {
    const errEl = $("msg-error");
    const loadEl = $("msg-loading");
    const cfgEl = $("msg-config");
    show(errEl, false);
    show(cfgEl, false);
    show(loadEl, true);
    $("last-fetch").textContent = "요청 중…";
    try {
      const bundle = await fetchBundle();
      show(loadEl, false);
      if (!bundle.configured) {
        show(cfgEl, true);
        cfgEl.textContent = bundle.configHint || "번들 미구성";
        return;
      }
      renderHero(bundle);
      renderSymbols(bundle);
      renderPerf(bundle);
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
  });
})();
