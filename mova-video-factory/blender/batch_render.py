"""Resume-safe dispatcher for MOVA procedural Blender driving clips.

Default production mode is procedural Blender. Optional FBX/Mixamo support is
kept only as an explicit override; it is never required for the 86-job build.
"""
from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from config import (
    BATCH_REPORT, MOVEMENT_MANIFEST, MOTION_MANIFEST, driving_output_path,
    normalise_equipment, procedural_pattern_for_code
)


def read_rows(path: Path):
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def resolve_jobs(rows, *, source_mode="procedural"):
    jobs = []
    for row in rows:
        code = (row.get("movement_code") or row.get("code") or "").strip().upper()
        if not code:
            continue
        variant = (row.get("variant") or "").strip().lower()
        variants = [variant] if variant in {"standard", "easier"} else ["standard", "easier"]
        for current_variant in variants:
            equipment = normalise_equipment(row.get("equipment"))
            pattern = procedural_pattern_for_code(code, row.get("movement_pattern"))
            output_value = row.get("driving_video_path") or str(driving_output_path(equipment, code, current_variant))
            output = Path(output_value).expanduser()
            if not output.is_absolute():
                output = MOVEMENT_MANIFEST.parent / output
            source_type = "template"
            source_path = ""
            if source_mode != "procedural":
                explicit = (row.get("motion_source") or row.get("source_path") or "").strip()
                if explicit and explicit.lower().endswith(".fbx"):
                    source_type = "fbx"
                    source_path = explicit
            jobs.append({
                "movement_code": code,
                "movement_name": row.get("movement_name") or row.get("name") or code,
                "pattern": pattern,
                "equipment": equipment,
                "variant": current_variant,
                "source_type": source_type,
                "source_path": source_path,
                "output": str(output),
            })
    return jobs


def valid_clip(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 4096


def report_row(job, status, detail=""):
    return {
        **job,
        "status": status,
        "detail": detail[-2000:],
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
    }


def append_report(rows):
    if not rows:
        return
    BATCH_REPORT.parent.mkdir(parents=True, exist_ok=True)
    new_file = not BATCH_REPORT.exists()
    fieldnames = [
        "movement_code", "movement_name", "pattern", "equipment", "variant",
        "source_type", "source_path", "output", "status", "detail", "timestamp_utc"
    ]
    with BATCH_REPORT.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        if new_file:
            writer.writeheader()
        writer.writerows(rows)


def select_jobs(jobs, *, job_id="", max_items=0):
    if job_id:
        wanted = job_id.strip().upper()
        jobs = [j for j in jobs if f"{j['movement_code']}:{j['variant']}".upper() == wanted]
        if not jobs:
            raise SystemExit(f"Unknown job id: {job_id}")
    if max_items:
        jobs = jobs[:max_items]
    return jobs


def run():
    parser = argparse.ArgumentParser(description="Batch render MOVA procedural Blender control clips")
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--blender", default=shutil.which("blender") or "blender")
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--job-id", default="", help="Render one CODE:variant job")
    parser.add_argument("--all", action="store_true", help="Render all missing jobs (default behaviour)")
    parser.add_argument("--resume", action="store_true", help="Alias for skip-existing resume behaviour")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--source-mode", choices=("procedural", "manifest"), default="procedural")
    args = parser.parse_args()

    manifest = args.manifest or (MOVEMENT_MANIFEST if MOVEMENT_MANIFEST.exists() else MOTION_MANIFEST)
    if not manifest.exists():
        raise SystemExit(f"Manifest not found: {manifest}")
    jobs = resolve_jobs(read_rows(manifest), source_mode=args.source_mode)
    jobs = select_jobs(jobs, job_id=args.job_id, max_items=args.max_items)
    outcomes = []
    script = Path(__file__).with_name("render_driving_clip.py")

    for index, job in enumerate(jobs, start=1):
        destination = Path(job["output"]).expanduser()
        if valid_clip(destination) and not args.force:
            outcomes.append(report_row(job, "skipped_complete"))
            print(f"[{index}/{len(jobs)}] SKIP {job['movement_code']}:{job['variant']}")
            continue
        command = [
            args.blender, "-b", "--python", str(script), "--",
            "--movement-code", job["movement_code"],
            "--pattern", job["pattern"],
            "--equipment", job["equipment"],
            "--variant", job["variant"],
            "--source-type", job["source_type"],
            "--output", str(destination),
        ]
        if job["source_path"]:
            command.extend(["--source-path", job["source_path"]])
        if args.dry_run:
            outcomes.append(report_row(job, "planned", " ".join(command)))
            print(f"[{index}/{len(jobs)}] PLAN {job['movement_code']}:{job['variant']}")
            continue
        print(f"[{index}/{len(jobs)}] RENDER {job['movement_code']}:{job['variant']}")
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        status = "complete" if completed.returncode == 0 and valid_clip(destination) else "failed"
        outcomes.append(report_row(job, status, completed.stdout))
        append_report([outcomes[-1]])
        if status == "failed":
            print(f"  FAILED; continuing. See {BATCH_REPORT}")

    # Dry runs/skips may not have been persisted one-by-one.
    persisted = [row for row in outcomes if row["status"] in {"planned", "skipped_complete"}]
    append_report(persisted)
    counts = {status: sum(row["status"] == status for row in outcomes) for status in {row["status"] for row in outcomes}}
    print(f"MOVA Blender batch: {len(jobs)} jobs; {counts}; report={BATCH_REPORT}")
    return 1 if counts.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(run())
