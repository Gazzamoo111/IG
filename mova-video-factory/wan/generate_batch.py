#!/usr/bin/env python3
"""Generate a bounded, restart-safe set of missing MOVA video assets."""
from __future__ import annotations

import argparse
from collections import Counter
from typing import Dict, Iterable, List

try:
    from .config import job_key, load_manifest, row_output, valid_output
    from .generate_single import execute_job
except ImportError:  # pragma: no cover - direct script execution
    from config import job_key, load_manifest, row_output, valid_output
    from generate_single import execute_job


def eligible_rows(rows: Iterable[Dict[str, str]], *, force: bool, retry_failed: bool, max_attempts: int) -> List[Dict[str, str]]:
    selected: List[Dict[str, str]] = []
    for row in rows:
        status = (row.get("status") or "planned").strip().lower()
        attempts = int(row.get("attempt_count") or 0)
        try:
            complete_file = valid_output(row_output(row))
        except (ValueError, OSError):
            complete_file = False
        if not force and complete_file:
            continue
        if status in {"complete", "approved"} and not force:
            # A missing/corrupt "complete" file is intentionally retried.
            selected.append(row)
        elif status in {"failed", "running"}:
            if retry_failed and attempts < max_attempts:
                selected.append(row)
        elif status not in {"complete", "approved"}:
            selected.append(row)
    return selected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate queued MOVA videos; existing valid files are always skipped.")
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--count", type=int, default=0, help="Maximum selected jobs (0 means all eligible jobs).")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.count < 0 or args.max_attempts < 1:
        parser.error("--count must be >= 0 and --max-attempts must be >= 1")
    manifest, rows, fields = load_manifest(args.manifest)
    selected = eligible_rows(rows, force=args.force, retry_failed=args.retry_failed, max_attempts=args.max_attempts)
    if args.count:
        selected = selected[: args.count]
    if not selected:
        print("No eligible jobs. Existing valid files and exhausted failures were left untouched.")
        return 0
    outcomes: Counter[str] = Counter()
    for row in selected:
        print(f"Starting {job_key(row)}")
        outcome = execute_job(row, manifest=manifest, rows=rows, fields=fields, force=args.force, dry_run=args.dry_run)
        outcomes[outcome] += 1
    print("Batch result: " + ", ".join(f"{key}={value}" for key, value in sorted(outcomes.items())))
    return 1 if outcomes["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
