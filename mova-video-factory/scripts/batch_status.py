#!/usr/bin/env python3
"""Export a restart-safe completion report based on the canonical manifest."""
from __future__ import annotations

import argparse
import csv
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    factory = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=factory / "movements.csv")
    parser.add_argument("--asset-root", type=Path, default=factory.parent,
                        help="Directory containing media/... final outputs")
    parser.add_argument("--report", type=Path, default=factory / "output" / "batch_status.csv")
    args = parser.parse_args()
    with args.manifest.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    report_rows = []
    totals = Counter()
    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    for row in rows:
        asset = args.asset_root / row["output_path"]
        exists = asset.is_file() and asset.stat().st_size > 0
        if exists and row["qc_status"] == "approved":
            state = "complete"
        elif exists:
            state = "awaiting_qc"
        elif row["status"] == "failed":
            state = "failed"
        else:
            state = "missing"
        totals[state] += 1
        report_rows.append({
            "movement_code": row["movement_code"], "variant": row["variant"],
            "output_path": row["output_path"], "manifest_status": row["status"],
            "qc_status": row["qc_status"], "attempt_count": row["attempt_count"],
            "asset_bytes": asset.stat().st_size if exists else 0, "batch_state": state,
            "reported_at": timestamp,
        })
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(report_rows[0]) if report_rows else [])
        if report_rows:
            writer.writeheader()
            writer.writerows(report_rows)
    summary = " ".join(f"{key}={totals[key]}" for key in ("complete", "awaiting_qc", "failed", "missing"))
    print(f"batch status: {summary}; report={args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
