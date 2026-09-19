#!/usr/bin/env python3
"""Build MOVA's 86-job video manifest from a canonical admin JSON export."""
from __future__ import annotations

import argparse
import csv
import json
import urllib.request
from pathlib import Path

FIELDS = [
    "movement_code", "movement_name", "equipment", "movement_pattern", "difficulty",
    "standard_name", "easier_name", "primary_cue", "easier_cue", "setup_cue",
    "space_requirement", "video_brief", "variant", "motion_source",
    "driving_video_path", "reference_image_path", "output_path", "status",
    "attempt_count", "qc_status",
]
VARIANTS = ("standard", "easier")


def load_movements(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    records = data.get("movements", data) if isinstance(data, dict) else data
    if not isinstance(records, list):
        raise ValueError("Source JSON must be a list or have a 'movements' list.")
    active = [record for record in records if record.get("active") is True]
    codes = [record.get("code") for record in active]
    if not active or any(not code for code in codes) or len(codes) != len(set(codes)):
        raise ValueError("Active movements must have unique non-empty codes.")
    return sorted(active, key=lambda record: record["code"])


def fetch_source(url: str) -> dict:
    """Fetch the read-only MOVA admin snapshot; no write credential is used."""
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("movements"), list):
        raise ValueError("MOVA admin endpoint did not return a movements list")
    return payload


def make_rows(movements: list[dict]) -> list[dict]:
    rows = []
    for movement in movements:
        code = movement["code"]
        code_lower = code.lower()
        equipment = movement.get("equipment", "")
        for variant in VARIANTS:
            display_name = movement["name"] if variant == "standard" else movement.get("easier_name", "")
            if not display_name:
                raise ValueError(f"{code} has no easier_name")
            rows.append({
                "movement_code": code,
                "movement_name": movement["name"],
                "equipment": equipment,
                "movement_pattern": movement.get("movement_pattern", ""),
                "difficulty": movement.get("difficulty", ""),
                "standard_name": movement["name"],
                "easier_name": movement.get("easier_name", ""),
                "primary_cue": movement.get("short_cue", ""),
                "easier_cue": movement.get("easier_cue", ""),
                "setup_cue": movement.get("setup_cue", ""),
                "space_requirement": movement.get("space_requirement", ""),
                "video_brief": movement.get("video_brief", ""),
                "variant": variant,
                "motion_source": f"motion/source/{code_lower}_{variant}.fbx",
                "driving_video_path": f"motion/processed/{code_lower}_{variant}_driving.mp4",
                "reference_image_path": "presenter/presenter.png",
                "output_path": f"media/{equipment}/{code_lower}/{variant}_v1.mp4",
                "status": "pending",
                "attempt_count": "0",
                "qc_status": "pending",
            })
    return rows


def write_manifest(rows: list[dict], csv_path: Path, json_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    json_path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-json", type=Path, help="Canonical MOVA admin JSON export")
    source.add_argument("--from-api", action="store_true", help="Fetch the configured read-only MOVA admin snapshot")
    parser.add_argument("--api-url", default="https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console?key=mova_console_demo_v1&mode=admin",
                        help="Read-only MOVA admin endpoint used with --from-api")
    parser.add_argument("--save-source", type=Path, help="Optional path to save the fetched source snapshot")
    parser.add_argument("--csv", type=Path, default=Path(__file__).resolve().parents[1] / "movements.csv")
    parser.add_argument("--json", type=Path, default=Path(__file__).resolve().parents[1] / "movements.json")
    args = parser.parse_args()
    if args.from_api:
        source_payload = fetch_source(args.api_url)
        if args.save_source:
            args.save_source.write_text(json.dumps(source_payload, indent=2) + "\n", encoding="utf-8")
        records = source_payload["movements"]
        movements = load_movements(Path(args.save_source)) if args.save_source else sorted(
            [record for record in records if record.get("active") is True], key=lambda record: record["code"]
        )
    else:
        movements = load_movements(args.source_json)
    rows = make_rows(movements)
    write_manifest(rows, args.csv, args.json)
    print(f"Built {len(rows)} jobs from {len(movements)} active movements: {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
