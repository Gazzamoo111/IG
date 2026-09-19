#!/usr/bin/env python3
"""Stage approved factory outputs into MOVA's media tree using atomic copies.

This script is deliberately local-only. API mapping happens separately in
upload_to_mova.py after human approval.
"""
from __future__ import annotations

import argparse
import csv
import os
import shutil
from pathlib import Path

from build_manifest import FIELDS


def read_rows(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_rows(path: Path, rows: list[dict]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, path)


def staged_source(factory: Path, row: dict) -> Path:
    filename = f"{row['movement_code'].lower()}_{row['variant']}_v1.mp4"
    return factory / "output" / row["variant"] / filename


def main() -> int:
    factory = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=factory / "movements.csv")
    parser.add_argument("--repo-root", type=Path, default=factory.parent,
                        help="IG repository root; output_path is relative to this directory")
    parser.add_argument("--include-unapproved", action="store_true",
                        help="Stage valid files before human QC approval")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--write-manifest", action="store_true",
                        help="Persist status=synced for copied/reused approved rows")
    args = parser.parse_args()
    rows = read_rows(args.manifest)
    copied = reused = missing = skipped = 0
    for row in rows:
        if row["qc_status"] != "approved" and not args.include_unapproved:
            skipped += 1
            continue
        source = staged_source(factory, row)
        destination = args.repo_root / row["output_path"]
        if destination.is_file() and destination.stat().st_size > 0 and not args.force:
            reused += 1
            if args.write_manifest and row["qc_status"] == "approved":
                row["status"] = "synced"
            continue
        if not source.is_file() or source.stat().st_size == 0:
            missing += 1
            continue
        copied += 1
        if not args.dry_run:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".part")
            shutil.copy2(source, temporary)
            os.replace(temporary, destination)
            if args.write_manifest and row["qc_status"] == "approved":
                row["status"] = "synced"
    if args.write_manifest and not args.dry_run:
        write_rows(args.manifest, rows)
    print(f"sync: copied={copied} reused={reused} missing={missing} skipped={skipped}")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
