#!/usr/bin/env python3
"""Validate and stage the image + Blender driving clip for a Wan Animate job."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict

try:  # Works both as `python wan/preprocess.py` and `python -m wan.preprocess`.
    from .config import job_key, preprocess_template, row_driving, row_presenter, wan_paths
except ImportError:  # pragma: no cover - direct script execution
    from config import job_key, preprocess_template, row_driving, row_presenter, wan_paths


def _run(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or " ".join(command))


def stage_job(row: Dict[str, str], *, force: bool = False) -> Dict[str, str]:
    """Create a deterministic staging directory and return Wan-ready source paths.

    Sources are copied, rather than modified in place.  This lets a job safely resume
    after an interrupted notebook kernel and makes the exact input set inspectable.
    """
    presenter, driving = row_presenter(row), row_driving(row)
    missing = [str(path) for path in (presenter, driving) if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing required job input(s): " + ", ".join(missing))
    job_dir = wan_paths()["staging"] / job_key(row).replace(":", "__").lower()
    job_dir.mkdir(parents=True, exist_ok=True)
    staged_image = job_dir / f"presenter{presenter.suffix.lower() or '.png'}"
    staged_video = job_dir / "driving.mp4"
    if force or not staged_image.exists():
        shutil.copy2(presenter, staged_image)
    # Convert unusual container/codec input to the dependable H.264/MP4 control clip.
    if force or not staged_video.exists():
        if not shutil.which("ffmpeg"):
            if driving.suffix.lower() != ".mp4":
                raise RuntimeError("ffmpeg is required to convert a non-MP4 driving clip")
            shutil.copy2(driving, staged_video)
        else:
            _run([
                "ffmpeg", "-y", "-i", str(driving), "-an", "-vf", "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2",
                "-r", "16", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(staged_video),
            ])
    metadata = {"job_id": job_key(row), "presenter": str(staged_image), "driving": str(staged_video), "processed": str(job_dir / "process_results")}
    (job_dir / "inputs.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return {key: str(value) for key, value in metadata.items()}


def preprocess_for_wan(staged: Dict[str, str], *, force: bool = False) -> str:
    """Run the official Animate preprocessing step once per durable staged job."""
    processed = Path(staged["processed"])
    marker = processed / "src_pose.mp4"
    if marker.is_file() and marker.stat().st_size > 1024 and not force:
        return str(processed)
    if processed.exists():
        shutil.rmtree(processed)
    processed.parent.mkdir(parents=True, exist_ok=True)
    paths = wan_paths()
    command = preprocess_template().format(
        repo_dir=str(paths["repo"]), weights_dir=str(paths["weights"]),
        presenter=staged["presenter"], driving=staged["driving"], processed=str(processed),
    )
    completed = subprocess.run(command, shell=True, text=True, capture_output=True)
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "Wan preprocessing failed").strip()[-4000:]
        raise RuntimeError(detail)
    if not marker.is_file() or marker.stat().st_size <= 1024:
        raise RuntimeError(f"Wan preprocessing did not create a usable pose video: {marker}")
    return str(processed)


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage image and driving video for one Wan job.")
    parser.add_argument("--presenter", required=True)
    parser.add_argument("--driving", required=True)
    parser.add_argument("--job-id", default="manual:standard")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--run-wan-preprocess", action="store_true", help="Run official Wan2.2 Animate preprocessing after staging")
    args = parser.parse_args()
    row = {"movement_code": args.job_id.split(":", 1)[0], "variant": args.job_id.split(":", 1)[-1], "reference_image_path": args.presenter, "driving_video_path": args.driving}
    staged = stage_job(row, force=args.force)
    if args.run_wan_preprocess:
        staged["processed"] = preprocess_for_wan(staged, force=args.force)
    print(json.dumps(staged, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
