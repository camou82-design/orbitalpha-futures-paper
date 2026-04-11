#!/usr/bin/env python3
"""
decision_funnel_* 객체가 "왼쪽에서 오른쪽으로 단조 비증가"인지 검사합니다.

기대 부등식 (연속 비교):
  raw_signal_count >= regime_pass_count >= edge_pass_count >= risk_pass_count
  >= execution_ready_count >= ai_pass_count >= enter_count

주의: 엔진의 computeFunnelTick 정의는 심볼별 **독립 조건 합**이라
이 부등식이 항상 성립하지 않을 수 있습니다 (docs/decision-funnel.md 참고).
기본은 경고만 출력하고 exit 0; CI에서 강제하려면 --strict.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

FUNNEL_KEYS = (
    "raw_signal_count",
    "regime_pass_count",
    "edge_pass_count",
    "risk_pass_count",
    "execution_ready_count",
    "ai_pass_count",
    "enter_count",
)


def _extract_funnel(obj: dict[str, Any], nested: str | None) -> dict[str, Any] | None:
    if nested:
        inner = obj.get(nested)
        if isinstance(inner, dict):
            return inner
        return None
    return obj


def _check_one(label: str, f: dict[str, Any]) -> list[str]:
    violations: list[str] = []
    vals: list[tuple[str, int]] = []
    for k in FUNNEL_KEYS:
        v = f.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            violations.append(f"{label}: missing or non-numeric {k}={v!r}")
            return violations
        vals.append((k, int(v)))
    for i in range(len(vals) - 1):
        a, av = vals[i]
        b, bv = vals[i + 1]
        if av < bv:
            violations.append(f"{label}: {a}({av}) < {b}({bv})")
    return violations


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--input",
        default="reports/engine-state.json",
        help="JSON 파일 (기본: reports/engine-state.json)",
    )
    ap.add_argument(
        "--nested",
        action="append",
        default=None,
        metavar="KEY",
        help="검사할 중첩 키 (여러 번 지정). 미지정 시 decision_funnel_tick, decision_funnel_50",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="위반 시 exit 1",
    )
    args = ap.parse_args()

    path = Path(args.input)
    if not path.is_file():
        print(f"[error] file not found: {path}", file=sys.stderr)
        return 2

    try:
        root = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[error] invalid JSON: {e}", file=sys.stderr)
        return 2

    if not isinstance(root, dict):
        print("[error] root must be a JSON object", file=sys.stderr)
        return 2

    nested_keys = args.nested or ["decision_funnel_tick", "decision_funnel_50"]
    all_violations: list[str] = []

    for nk in nested_keys:
        sub = _extract_funnel(root, nk if nk else None)
        if nk and sub is None:
            print(f"[skip] key {nk!r} missing or not an object", file=sys.stderr)
            continue
        label = nk or "(root)"
        if sub is None:
            continue
        all_violations.extend(_check_one(label, sub))

    if not all_violations:
        print("OK: monotonic (non-increasing) funnel chain holds for checked object(s).")
        return 0

    for line in all_violations:
        print(line)

    if args.strict:
        print(f"FAIL: {len(all_violations)} issue(s)", file=sys.stderr)
        return 1
    print(
        f"[warn] {len(all_violations)} check note(s); engine may still be correct (see docs/decision-funnel.md).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
