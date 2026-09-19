#!/usr/bin/env python3
"""Technical QC for MOVA final MP4s; never grants human approval automatically."""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def probe(path: Path) -> tuple[dict[str, object] | None, str]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None, "ffprobe unavailable"
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        text=True, capture_output=True,
    )
    if result.returncode:
        return None, (result.stderr.strip() or "unreadable/corrupt media")[-600:]
    try:
        return json.loads(result.stdout), ""
    except json.JSONDecodeError:
        return None, "ffprobe returned malformed metadata"


def video_stream(info: dict[str, object]) -> dict[str, object] | None:
    return next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)


def qc_row(row: dict[str, str], asset_root: Path) -> dict[str, str]:
    output = asset_root / row["variant"] / f"{row['movement_code'].lower()}_{row['variant']}_v1.mp4"
    issues: list[str] = []
    metrics = {"width": "", "height": "", "fps": "", "duration_seconds": ""}
    if not output.is_file() or output.stat().st_size == 0:
        issues.append("file missing or empty")
    else:
        info, probe_error = probe(output)
        if probe_error:
            issues.append(probe_error)
        elif info:
            stream = video_stream(info)
            if not stream:
                issues.append("no video stream")
            else:
                width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
                rate = str(stream.get("avg_frame_rate", "0/0"))
                try:
                    numerator, denominator = rate.split("/", 1)
                    fps = float(numerator) / float(denominator) if float(denominator) else 0
                except (ValueError, ZeroDivisionError):
                    fps = 0
                duration = float(info.get("format", {}).get("duration", 0) or 0)
                metrics.update({"width": str(width), "height": str(height), "fps": f"{fps:.3f}", "duration_seconds": f"{duration:.3f}"})
                if not width or not height or abs((width / height) - 0.8) > 0.025:
                    issues.append("resolution is not 4:5")
                if not 6 <= duration <= 10:
                    issues.append("duration outside 6–10 seconds")
                if fps < 20 or fps > 60:
                    issues.append("frame rate outside 20–60 FPS")
    return {
        "render_id": f"{row['movement_code']}:{row['variant']}", "movement_code": row["movement_code"], "variant": row["variant"],
        "output_path": row["output_path"], "staging_path": str(output), "generation_status": row.get("status", ""),
        "qc_status": "flagged" if issues else "needs_human_review",
        "issues": "; ".join(issues), **metrics,
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def create_contact_sheets(report: list[dict[str, str]], folder: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("Contact sheets skipped: ffmpeg unavailable")
        return
    folder.mkdir(parents=True, exist_ok=True)
    for row in report:
        if row["qc_status"] != "needs_human_review":
            continue
        destination = folder / f"{row['render_id']}.jpg"
        subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", "2", "-i", row["staging_path"], "-frames:v", "1", str(destination)], check=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="movements.csv")
    parser.add_argument("--report", default="output/qc/qc_report.csv")
    parser.add_argument("--asset-root", default="output", help="Factory output directory with standard/ and easier/")
    parser.add_argument("--contact-sheets", action="store_true")
    args = parser.parse_args()
    with Path(args.manifest).open(newline="", encoding="utf-8") as handle:
        report = [qc_row(row, Path(args.asset_root)) for row in csv.DictReader(handle)]
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(report[0]) if report else ["render_id", "qc_status"])
        writer.writeheader()
        writer.writerows(report)
    if args.contact_sheets:
        create_contact_sheets(report, destination.parent / "contact_sheets")
    flagged = sum(row["qc_status"] == "flagged" for row in report)
    print(f"QC report written to {destination}: {len(report) - flagged} ready for review, {flagged} flagged")
    return 1 if flagged else 0


if __name__ == "__main__":
    raise SystemExit(main())
