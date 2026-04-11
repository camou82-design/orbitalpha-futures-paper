#!/usr/bin/env python3
"""
reports/decisions.jsonl 운영 요약 마크다운 생성 (표준 라이브러리만).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TOP_N = 15
STATE_KEYS = (
    "signal_state",
    "regime_state",
    "edge_state",
    "risk_state",
    "execution_state",
)


def _ts(obj: dict[str, Any]) -> str | None:
    for k in ("timestamp", "ts", "generatedAt"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            try:
                return datetime.fromtimestamp(v / 1000.0 if v > 1e12 else float(v), tz=timezone.utc).isoformat()
            except (OSError, OverflowError, ValueError):
                pass
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", default="reports/decisions.jsonl", help="입력 JSONL")
    ap.add_argument("--out", default="reports/decision-report.md", help="출력 마크다운")
    args = ap.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.out)

    if not in_path.is_file():
        out_path.parent.mkdir(parents=True, exist_ok=True)
        msg = f"# decisions 분석 리포트\n\n입력 파일이 없습니다: `{in_path}`\n\n분석을 건너뜁니다.\n"
        out_path.write_text(msg, encoding="utf-8")
        print(f"wrote empty report: {out_path}", file=sys.stderr)
        return 0

    rows: list[dict[str, Any]] = []
    corrupt = 0
    for lineno, line in enumerate(in_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            corrupt += 1
            print(f"{in_path}: line {lineno} skipped (invalid JSON)", file=sys.stderr)

    if corrupt:
        print(f"summary: skipped corrupt lines: {corrupt}", file=sys.stderr)

    lines: list[str] = []
    lines.append("# decisions.jsonl 분석 리포트\n")

    if not rows:
        lines.append("\n데이터 행이 없습니다. 엔진이 아직 decision 로그를 쓰지 않았거나 파일이 비어 있습니다.\n")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
        return 0

    first_ts = _ts(rows[0])
    last_ts = _ts(rows[-1])
    lines.append("\n## 기간\n")
    lines.append(f"- 첫 줄 시각: `{first_ts or '—'}`")
    lines.append(f"- 마지막 줄 시각: `{last_ts or '—'}`")
    lines.append(f"- 전체 행 수: **{len(rows)}**")

    by_sym = Counter(str(r.get("symbol") or "?") for r in rows)
    lines.append("\n## 심볼별 행 수\n")
    lines.append("| 심볼 | 행 수 |")
    lines.append("| --- | ---: |")
    for sym, c in by_sym.most_common():
        lines.append(f"| {sym} | {c} |")

    fd = Counter(str(r.get("final_decision") or "?") for r in rows)
    lines.append("\n## final_decision 분포\n")
    lines.append("| 값 | 건수 | 비율 |")
    lines.append("| --- | ---: | ---: |")
    n = len(rows)
    for k, c in fd.most_common():
        lines.append(f"| {k} | {c} | {100.0 * c / n:.1f}% |")

    enter_total = sum(1 for r in rows if r.get("final_decision") == "ENTER")
    lines.append(f"\n- **전체 ENTER 비율**: {100.0 * enter_total / n:.2f}% ({enter_total}/{n})")

    lines.append("\n## 심볼별 ENTER 비율\n")
    lines.append("| 심볼 | ENTER | 행 수 | 비율 |")
    lines.append("| --- | ---: | ---: | ---: |")
    for sym in sorted(by_sym.keys()):
        sub = [r for r in rows if str(r.get("symbol")) == sym]
        ec = sum(1 for r in sub if r.get("final_decision") == "ENTER")
        sc = len(sub)
        lines.append(f"| {sym} | {ec} | {sc} | {100.0 * ec / sc:.1f}% |")

    rr = Counter()
    for r in rows:
        v = r.get("reject_reason")
        if v is None or v == "":
            continue
        rr[str(v)] += 1
    lines.append(f"\n## reject_reason Top {TOP_N} (null 제외)\n")
    if not rr:
        lines.append("(없음)\n")
    else:
        lines.append("| 코드 | 건수 |")
        lines.append("| --- | ---: |")
        for k, c in rr.most_common(TOP_N):
            lines.append(f"| {k} | {c} |")

    se = Counter(str(r.get("strategy_executor") or "?") for r in rows)
    lines.append("\n## strategy_executor 분포\n")
    lines.append("| 값 | 건수 |")
    lines.append("| --- | ---: |")
    for k, c in se.most_common():
        lines.append(f"| {k} | {c} |")

    lines.append("\n## 단계별 상태 빈도 (상위)\n")
    for sk in STATE_KEYS:
        ct = Counter(str(r.get(sk) or "?") for r in rows)
        lines.append(f"\n### {sk}\n")
        lines.append("| 값 | 건수 |")
        lines.append("| --- | ---: |")
        for k, c in ct.most_common(12):
            lines.append(f"| {k} | {c} |")

    lines.append("\n---\n*자동 생성 (`scripts/report_decisions_jsonl.py`)*\n")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
