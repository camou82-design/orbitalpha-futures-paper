#!/usr/bin/env python3
"""
레거시 executor 계층의 문자열 "NONE" 이 지정 필드에 남는지 검사합니다.

signal_state 등 파이프라인용 NONE은 대상이 아닙니다 (JSON 트리에서 지정 키만 검사).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

EXECUTOR_LIKE_KEYS = frozenset(
    {
        "executor",
        "strategy_executor",
        "executorAtEntry",
        "active_mode_executor",
    }
)


def _walk(obj: Any, path: str, hits: list[tuple[str, str]]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}" if path else k
            if k in EXECUTOR_LIKE_KEYS and v == "NONE":
                hits.append((p, "NONE"))
            _walk(v, p, hits)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            _walk(item, f"{path}[{i}]", hits)


def scan_jsonl(path: Path) -> tuple[list[tuple[int, str, str]], int]:
    """
    Returns (findings as (line_no, field_name, value), corrupt_line_count).
    field_name is the last segment of json path for readability, or full path if nested.
    """
    findings: list[tuple[int, str, str]] = []
    corrupt = 0
    text = path.read_text(encoding="utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            corrupt += 1
            print(f"{path}: line {lineno} corrupt JSON ({e})", file=sys.stderr)
            continue
        hits: list[tuple[str, str]] = []
        _walk(obj, "", hits)
        for jp, vr in hits:
            field = jp.split(".")[-1].split("[")[0]
            findings.append((lineno, field, vr))
    return findings, corrupt


def strict_grep_scan(path: Path) -> list[tuple[int, str]]:
    """JSON 파싱 없이 줄 단위로 executor 계열 키 뒤 NONE 탐지."""
    out: list[tuple[int, str]] = []
    # "key" : "NONE" 또는 'NONE' (간단 모드)
    patterns = [
        (name, re.compile(rf'"{re.escape(name)}"\s*:\s*"NONE"'))
        for name in sorted(EXECUTOR_LIKE_KEYS)
    ]
    text = path.read_text(encoding="utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), start=1):
        for name, rx in patterns:
            if rx.search(line):
                out.append((lineno, name))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "paths",
        nargs="*",
        default=["reports/decisions.jsonl", "reports/events.jsonl"],
        help="검사할 JSONL 파일",
    )
    ap.add_argument(
        "--strict-grep",
        action="store_true",
        help="JSON 파싱 없이 문자열 패턴으로만 탐지 (수동 확인용)",
    )
    args = ap.parse_args()

    total = 0
    total_corrupt = 0
    checked = 0

    for rel in args.paths:
        p = Path(rel)
        if not p.is_file():
            print(f"[skip] not a file: {p}", file=sys.stderr)
            continue

        checked += 1
        if args.strict_grep:
            hits = strict_grep_scan(p)
            if hits:
                total += len(hits)
                for lineno, field in hits:
                    print(f"{p}:{lineno} field={field} value=NONE")
        else:
            findings, corrupt = scan_jsonl(p)
            total_corrupt += corrupt
            if findings:
                total += len(findings)
                for lineno, field, value in findings:
                    print(f"{p}:{lineno} field={field} value={value}")

    if total_corrupt > 0:
        print(f"summary: corrupt JSON lines skipped: {total_corrupt}", file=sys.stderr)
    if checked == 0:
        print("[warn] no existing files checked", file=sys.stderr)

    if total == 0:
        print("OK: no NONE in executor-like fields.")
        return 0
    print(f"FAIL: NONE count={total}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
