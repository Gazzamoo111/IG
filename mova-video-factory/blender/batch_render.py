"""Resume-safe dispatcher for MOVA Blender driving clips.

Run with normal Python (recommended):
    python blender/batch_render.py --dry-run
    python blender/batch_render.py --blender /path/to/blender --max-items 4

It accepts either the factory's 86-row ``movements.csv`` or the smaller
``motion/motion_manifest.csv`` template catalogue. Existing non-empty MP4s are
skipped unless ``--force`` is passed, and every attempt is written to CSV.
"""
from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from config import BATCH_REPORT, MOVEMENT_MANIFEST, MOTION_MANIFEST, driving_output_path, normalise_equipment, normalise_pattern


def read_rows(path: Path):
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def resolve_jobs(rows):
    jobs = []
    for row in rows:
        code = (row.get("movement_code") or row.get("code") or "").strip()
        if not code:
            continue
        variants = [row.get("variant", "").strip().lower()] if row.get("variant", "").strip().lower() in {"standard", "easier"} else ["standard", "easier"]
        for variant in variants:
            motion_source = (row.get("motion_source") or "").strip()
            source_path = (row.get(f"{variant}_source_path") or row.get("motion_source_path") or row.get("source_path") or "").strip()
            source_type = (row.get(f"{variant}_source_type") or row.get("source_type") or "").strip().lower()
            if not source_type and motion_source.lower().endswith(".fbx"):
                source_type, source_path = "fbx", source_path or motion_source
            source_type = source_type or "template"
            if source_type in {"manual", "keyframe", "procedural"}:
                source_type = "template"
            if source_type not in {"template", "fbx", "mixamo"}:
                source_type = "template"
            equipment = normalise_equipment(row.get("equipment"))
            output_value = row.get("driving_video_path") or str(driving_output_path(equipment, code, variant))
            output = Path(output_value).expanduser()
            if not output.is_absolute():
                output = MOVEMENT_MANIFEST.parent / output
            jobs.append({
                "movement_code": code,
                "pattern": normalise_pattern(row.get("movement_pattern")),
                "equipment": equipment,
                "variant": variant,
                "source_type": source_type,
                "source_path": source_path,
                "output": str(output),
            })
    return jobs


def valid_clip(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 4096


def report_row(job, status, detail=""):
    return {**job, "status": status, "detail": detail[-1000:], "timestamp_utc": datetime.now(timezone.utc).isoformat()}


def append_report(rows):
    BATCH_REPORT.parent.mkdir(parents=True, exist_ok=True)
    new_file = not BATCH_REPORT.exists()
    fieldnames = ["movement_code", "pattern", "equipment", "variant", "source_type", "source_path", "output", "status", "detail", "timestamp_utc"]
    with BATCH_REPORT.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        if new_file:
            writer.writeheader()
        writer.writerows(rows)


def run():
    parser = argparse.ArgumentParser(description="Batch render MOVA Blender control clips")
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--blender", default=shutil.which("blender") or "blender")
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    manifest = args.manifest or (MOVEMENT_MANIFEST if MOVEMENT_MANIFEST.exists() else MOTION_MANIFEST)
    if not manifest.exists():
        raise SystemExit(f"Manifest not found: {manifest}")
    jobs = resolve_jobs(read_rows(manifest))
    if args.max_items:
        jobs = jobs[: args.max_items]
    outcomes = []
    script = Path(__file__).with_name("render_driving_clip.py")
    for job in jobs:
        destination = Path(job["output"]).expanduser()
        if valid_clip(destination) and not args.force:
            outcomes.append(report_row(job, "skipped_complete"))
            continue
        command = [args.blender, "-b", "--python", str(script), "--", "--movement-code", job["movement_code"], "--pattern", job["pattern"], "--equipment", job["equipment"], "--variant", job["variant"], "--source-type", job["source_type"], "--output", str(destination)]
        if job["source_path"]:
            command.extend(["--source-path", job["source_path"]])
        if args.dry_run:
            outcomes.append(report_row(job, "planned", " ".join(command)))
            continue
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        outcomes.append(report_row(job, "complete" if completed.returncode == 0 and valid_clip(destination) else "failed", completed.stdout))
    append_report(outcomes)
    counts = {status: sum(row["status"] == status for row in outcomes) for status in {row["status"] for row in outcomes}}
    print(f"MOVA Blender batch: {len(jobs)} jobs; {counts}; report={BATCH_REPORT}")
    return 1 if counts.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(run())
