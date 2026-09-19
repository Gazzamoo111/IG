#!/usr/bin/env python3
"""Validate MOVA's 86 procedural Blender driving clips and build a review page.

The report is intentionally separate from final-media QC: a driving clip is a
control asset for Wan, so it must meet a tighter, deterministic technical
contract before it is used to generate a presenter video.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import math
import shutil
import subprocess
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_WIDTH = 720
EXPECTED_HEIGHT = 900
EXPECTED_FPS = 30.0
MIN_DURATION_SECONDS = 6.0
MAX_DURATION_SECONDS = 8.0


def run(command: list[str], *, text: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=text, check=False)


def parse_rate(value: object) -> float:
    try:
        numerator, denominator = str(value or "0/0").split("/", 1)
        return float(numerator) / float(denominator)
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def probe_video(path: Path) -> tuple[dict[str, Any] | None, str]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None, "ffprobe unavailable"
    result = run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], text=True)
    if result.returncode:
        return None, (result.stderr.strip() or "unreadable/corrupt media")[-600:]
    try:
        return json.loads(result.stdout), ""
    except json.JSONDecodeError:
        return None, "ffprobe returned malformed metadata"


def video_stream(info: dict[str, Any]) -> dict[str, Any] | None:
    return next((stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"), None)


def occupancy_sample(path: Path) -> dict[str, str]:
    """Return a lightweight centre-frame foreground estimate using FFmpeg only.

    This cannot recognise a person. It detects a subject-shaped luminance region
    against the deliberately plain driving-video background and reports a REVIEW
    signal when it reaches the frame edge or occupies a suspiciously small area.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"occupancy_percent": "", "subject_bbox": "", "crop_flag": "unavailable (ffmpeg missing)"}
    width, height = 90, 112
    result = run([
        ffmpeg, "-v", "error", "-ss", "3", "-i", str(path), "-frames:v", "1",
        "-vf", f"scale={width}:{height}:flags=area,format=gray", "-f", "rawvideo", "-",
    ])
    pixels = result.stdout
    if result.returncode or len(pixels) != width * height:
        return {"occupancy_percent": "", "subject_bbox": "", "crop_flag": "unavailable (frame sample failed)"}
    border: list[int] = []
    for y in range(height):
        for x in range(width):
            if x in {0, 1, width - 2, width - 1} or y in {0, 1, height - 2, height - 1}:
                border.append(pixels[y * width + x])
    background = sorted(border)[len(border) // 2]
    foreground = [(x, y) for y in range(height) for x in range(width) if abs(pixels[y * width + x] - background) >= 22]
    if not foreground:
        return {"occupancy_percent": "0.0", "subject_bbox": "", "crop_flag": "REVIEW: no foreground detected"}
    x_values = [point[0] for point in foreground]
    y_values = [point[1] for point in foreground]
    x0, x1, y0, y1 = min(x_values), max(x_values), min(y_values), max(y_values)
    occupancy = len(foreground) * 100 / (width * height)
    flags: list[str] = []
    if x0 <= 1 or x1 >= width - 2 or y0 <= 1 or y1 >= height - 2:
        flags.append("REVIEW: foreground touches frame edge")
    if occupancy < 3.0:
        flags.append("REVIEW: unusually low foreground occupancy")
    if occupancy > 82.0:
        flags.append("REVIEW: unusually high foreground occupancy")
    return {
        "occupancy_percent": f"{occupancy:.1f}",
        "subject_bbox": f"{x0},{y0},{x1},{y1}",
        "crop_flag": "; ".join(flags) or "",
    }


def factory_path(value: str, factory: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else factory / path


def qc_row(row: dict[str, str], factory: Path) -> dict[str, str]:
    clip = factory_path(row.get("driving_video_path", ""), factory)
    failures: list[str] = []
    reviews: list[str] = []
    metrics = {"codec": "", "width": "", "height": "", "fps": "", "duration_seconds": ""}
    occupancy = {"occupancy_percent": "", "subject_bbox": "", "crop_flag": ""}
    if not clip.is_file() or clip.stat().st_size == 0:
        failures.append("file missing or empty")
    else:
        info, error = probe_video(clip)
        if error:
            failures.append(error)
        elif info:
            stream = video_stream(info)
            if not stream:
                failures.append("no video stream")
            else:
                codec = str(stream.get("codec_name", ""))
                width, height = int(stream.get("width", 0) or 0), int(stream.get("height", 0) or 0)
                fps = parse_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
                duration = float(info.get("format", {}).get("duration", 0) or stream.get("duration", 0) or 0)
                metrics = {
                    "codec": codec,
                    "width": str(width),
                    "height": str(height),
                    "fps": f"{fps:.3f}",
                    "duration_seconds": f"{duration:.3f}",
                }
                if codec != "h264":
                    failures.append(f"codec is {codec or 'unknown'}, expected h264")
                if (width, height) != (EXPECTED_WIDTH, EXPECTED_HEIGHT):
                    failures.append(f"resolution is {width}x{height}, expected {EXPECTED_WIDTH}x{EXPECTED_HEIGHT}")
                if not math.isclose(fps, EXPECTED_FPS, abs_tol=0.02):
                    failures.append(f"frame rate is {fps:.3f}, expected {EXPECTED_FPS:.0f}")
                if not MIN_DURATION_SECONDS <= duration <= MAX_DURATION_SECONDS:
                    failures.append(f"duration is {duration:.3f}s, expected {MIN_DURATION_SECONDS:.0f}–{MAX_DURATION_SECONDS:.0f}s")
                if not failures:
                    occupancy = occupancy_sample(clip)
                    if occupancy["crop_flag"]:
                        reviews.append(occupancy["crop_flag"])
    status = "FAIL" if failures else ("REVIEW" if reviews else "PASS")
    return {
        "render_id": f"{row.get('movement_code', '')}:{row.get('variant', '')}",
        "movement_code": row.get("movement_code", ""),
        "movement_name": row.get("movement_name", ""),
        "equipment": row.get("equipment", ""),
        "movement_pattern": row.get("movement_pattern", ""),
        "variant": row.get("variant", ""),
        "driving_video_path": row.get("driving_video_path", ""),
        "resolved_path": str(clip),
        "qc_status": status,
        "issues": "; ".join(failures + reviews),
        **metrics,
        **occupancy,
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def video_markup(path: Path, html_path: Path, status: str) -> str:
    try:
        relative = path.relative_to(html_path.parent)
    except ValueError:
        relative = path
    source = html.escape(relative.as_posix())
    if path.is_file() and path.stat().st_size:
        return f'<video controls preload="metadata" muted playsinline src="{source}"></video>'
    return '<div class="missing-video">Clip unavailable</div>'


def write_contact_sheet(report: list[dict[str, str]], destination: Path) -> None:
    factory = Path(__file__).resolve().parents[1]
    destination.parent.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, dict[str, list[dict[str, str]]]] = defaultdict(lambda: defaultdict(list))
    for row in report:
        grouped[row["equipment"]][row["movement_code"]].append(row)
    sections: list[str] = []
    for equipment in sorted(grouped):
        cards: list[str] = []
        for code in sorted(grouped[equipment]):
            rows = sorted(grouped[equipment][code], key=lambda item: item["variant"])
            first = rows[0]
            clips = "".join(
                '<section class="clip">'
                f'<h4>{html.escape(row["variant"].title())} <span class="status {row["qc_status"].lower()}">{row["qc_status"]}</span></h4>'
                f'{video_markup(Path(row["resolved_path"]), destination, row["qc_status"])}'
                f'<p>{html.escape(row["issues"] or "Technical checks passed.")}</p>'
                f'<small>{html.escape(row["codec"] or "—")} · {html.escape(row["width"] or "—")}×{html.escape(row["height"] or "—")} · {html.escape(row["fps"] or "—")} fps · {html.escape(row["duration_seconds"] or "—")} s</small>'
                '</section>'
                for row in rows
            )
            cards.append(
                '<article class="movement">'
                f'<h3>{html.escape(first["movement_name"])} <code>{html.escape(code)}</code></h3>'
                f'<p class="meta">{html.escape(first["movement_pattern"])} · {html.escape(equipment)}</p>'
                f'<div class="clips">{clips}</div></article>'
            )
        sections.append(f'<section class="equipment"><h2>{html.escape(equipment.replace("_", " ").title())}</h2><div class="grid">{"".join(cards)}</div></section>')
    counts = {status: sum(row["qc_status"] == status for row in report) for status in ("PASS", "REVIEW", "FAIL")}
    destination.write_text(f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOVA driving-motion contact sheet</title><style>
body{{margin:0;background:#101419;color:#eff5f4;font:14px/1.45 system-ui,sans-serif}} main{{max-width:1520px;margin:auto;padding:28px}}h1{{margin:0}}h2{{border-bottom:1px solid #344048;padding-bottom:8px;text-transform:capitalize}}.summary{{color:#b9c4c5}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:16px}}.movement{{background:#1a2128;border:1px solid #33414a;border-radius:10px;padding:14px}}h3{{margin:0}}code{{color:#9fe870;font-size:.78em}}.meta,small{{color:#aebcc0}}.clips{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}.clip{{min-width:0}}h4{{margin:10px 0 5px}}video,.missing-video{{width:100%;aspect-ratio:4/5;background:#050708;border-radius:6px;object-fit:contain}}.missing-video{{display:grid;place-items:center;color:#f4b2a5}}.status{{font-size:.72em;border-radius:999px;padding:3px 6px;color:#111}}.pass{{background:#9fe870}}.review{{background:#ffd166}}.fail{{background:#ff8a7a}}.clip p{{min-height:2.8em;margin:5px 0;color:#d2dcdd}}@media(max-width:700px){{main{{padding:14px}}.grid,.clips{{grid-template-columns:1fr}}}}
</style></head><body><main><h1>MOVA procedural driving-motion review</h1>
<p class="summary">Expected 86 clips · PASS {counts["PASS"]} · REVIEW {counts["REVIEW"]} · FAIL {counts["FAIL"]}. Generated {html.escape(datetime.now(timezone.utc).isoformat(timespec="seconds"))}.</p>
{''.join(sections)}</main></body></html>''', encoding="utf-8")


def main() -> int:
    factory = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=factory / "movements.csv")
    parser.add_argument("--report", type=Path, default=factory / "motion" / "driving_motion_qc.csv")
    parser.add_argument("--contact-sheet", type=Path, default=factory / "motion" / "driving_motion_contact_sheet.html")
    args = parser.parse_args()
    with args.manifest.open(newline="", encoding="utf-8-sig") as handle:
        manifest = list(csv.DictReader(handle))
    expected = {(row.get("movement_code", ""), row.get("variant", "")) for row in manifest}
    if len(manifest) != 86 or len(expected) != 86:
        raise SystemExit(f"Manifest must contain 86 distinct standard/easier jobs; found {len(manifest)} rows / {len(expected)} ids")
    report = [qc_row(row, factory) for row in manifest]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(report[0]))
        writer.writeheader()
        writer.writerows(report)
    write_contact_sheet(report, args.contact_sheet)
    counts = {status: sum(row["qc_status"] == status for row in report) for status in ("PASS", "REVIEW", "FAIL")}
    print(f"Driving-motion QC: {len(report)} expected clips; PASS={counts['PASS']} REVIEW={counts['REVIEW']} FAIL={counts['FAIL']}")
    print(f"Report: {args.report}\nContact sheet: {args.contact_sheet}")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
