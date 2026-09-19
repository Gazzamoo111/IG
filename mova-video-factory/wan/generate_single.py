#!/usr/bin/env python3
"""Run one restart-safe Wan2.2 Animate job from movements.csv."""
from __future__ import annotations

import argparse
import subprocess
import traceback
from pathlib import Path
from typing import Dict, Optional

try:
    from .config import (
        command_template, find_job, job_key, load_manifest, row_output,
        update_row_status, update_state, valid_output, wan_paths,
    )
    from .preprocess import preprocess_for_wan, stage_job
except ImportError:  # pragma: no cover - direct script execution
    from config import (
        command_template, find_job, job_key, load_manifest, row_output,
        update_row_status, update_state, valid_output, wan_paths,
    )
    from preprocess import preprocess_for_wan, stage_job


def execute_job(
    row: Dict[str, str],
    *,
    manifest: Path,
    rows: list[Dict[str, str]],
    fields: list[str],
    force: bool = False,
    dry_run: bool = False,
) -> str:
    """Execute one item and return complete, skipped, failed, or dry-run.

    The state file is updated before work starts and after every terminal outcome.  A
    kernel interruption consequently leaves a visible ``running`` job which resume
    treats as eligible for a retry.
    """
    key, output = job_key(row), row_output(row)
    if not force and valid_output(output):
        update_state(key, status="complete", output_path=str(output), reason="valid output already present")
        update_row_status(manifest, rows, fields, key, "complete", qc_status=row.get("qc_status") or "pending")
        return "skipped"

    if dry_run:
        paths = wan_paths()
        staged_root = paths["staging"] / key.replace(":", "__").lower()
        command = command_template().format(
            repo_dir=str(paths["repo"]), weights_dir=str(paths["weights"]),
            presenter=str(staged_root / "presenter.png"), driving=str(staged_root / "driving.mp4"),
            processed=str(staged_root / "process_results"), output=str(output),
            job_id=key, prompt=row.get("video_brief", ""),
        )
        print(f"[{key}] PLAN: {command}")
        return "dry-run"

    attempts = int(row.get("attempt_count") or 0) + 1
    update_state(key, status="running", attempt_count=attempts, output_path=str(output), started_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())
    update_row_status(manifest, rows, fields, key, "running", attempt_count=attempts, last_error="")
    try:
        staged = stage_job(row)
        processed = preprocess_for_wan(staged)
        output.parent.mkdir(parents=True, exist_ok=True)
        paths = wan_paths()
        values = {
            "repo_dir": str(paths["repo"]), "weights_dir": str(paths["weights"]),
            "presenter": staged["presenter"], "driving": staged["driving"], "output": str(output),
            "processed": processed, "job_id": key, "prompt": row.get("video_brief", ""),
        }
        command = command_template().format(**values)
        print(f"[{key}] {command}")
        result = subprocess.run(command, shell=True, cwd=paths["repo"], text=True, capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "Wan command failed").strip()[-4000:])
        if not valid_output(output):
            raise RuntimeError(f"Wan command exited successfully but no valid output was written: {output}")
        update_state(key, status="complete", attempt_count=attempts, output_path=str(output), command=command, completed_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())
        update_row_status(manifest, rows, fields, key, "complete", attempt_count=attempts, last_error="")
        return "complete"
    except Exception as exc:  # Preserve the item failure and allow batch resume.
        error = f"{type(exc).__name__}: {exc}"[-4000:]
        update_state(key, status="failed", attempt_count=attempts, output_path=str(output), error=error)
        update_row_status(manifest, rows, fields, key, "failed", attempt_count=attempts, last_error=error)
        print(f"[{key}] FAILED: {error}")
        return "failed"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate one MOVA job using Wan2.2 Animate.")
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--job-id", required=True, help="e.g. BAR_SQUAT:standard")
    parser.add_argument("--force", action="store_true", help="Regenerate even when a valid output exists.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    manifest, rows, fields = load_manifest(args.manifest)
    status = execute_job(find_job(rows, args.job_id), manifest=manifest, rows=rows, fields=fields, force=args.force, dry_run=args.dry_run)
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
