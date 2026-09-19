#!/usr/bin/env python3
"""Validate MOVA's canonical CSV/JSON production manifest without network access."""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path

from build_manifest import FIELDS, VARIANTS


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != FIELDS:
            raise ValueError(f"CSV fields differ from the canonical schema: {reader.fieldnames}")
        return list(reader)


def comparable(rows: list[dict]) -> list[dict]:
    """CSV is text; normalise JSON scalar values before parity comparison."""
    return [{field: str(row.get(field, "")) for field in FIELDS} for row in rows]


def expected_path(row: dict) -> str:
    return "media/{}/{}/{}_v1.mp4".format(row["equipment"], row["movement_code"].lower(), row["variant"])


def validate(rows: list[dict], source_json: Path | None) -> list[str]:
    problems: list[str] = []
    if len(rows) != 86:
        problems.append(f"expected 86 manifest rows, found {len(rows)}")
    pairs = [(row.get("movement_code"), row.get("variant")) for row in rows]
    if len(pairs) != len(set(pairs)):
        problems.append("duplicate movement_code/variant pairs")
    by_code = Counter(code for code, _ in pairs)
    if len(by_code) != 43:
        problems.append(f"expected 43 movement codes, found {len(by_code)}")
    for code, count in by_code.items():
        variants = {variant for candidate, variant in pairs if candidate == code}
        if count != 2 or variants != set(VARIANTS):
            problems.append(f"{code}: requires exactly standard and easier rows")
    for index, row in enumerate(rows, start=2):
        blank = [field for field in FIELDS if not str(row.get(field, "")).strip() and field != "attempt_count"]
        if blank:
            problems.append(f"row {index}: blank required fields: {', '.join(blank)}")
        if row.get("output_path") != expected_path(row):
            problems.append(f"row {index}: non-deterministic output_path")
        if row.get("reference_image_path") != "presenter/presenter.png":
            problems.append(f"row {index}: unexpected presenter reference")
        try:
            int(row.get("attempt_count", ""))
        except ValueError:
            problems.append(f"row {index}: attempt_count is not an integer")
    if source_json:
        data = json.loads(source_json.read_text(encoding="utf-8"))
        movements = data.get("movements", data) if isinstance(data, dict) else data
        active = {item["code"] for item in movements if item.get("active") is True}
        if set(by_code) != active:
            problems.append("manifest movement codes do not match active canonical source")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    factory = Path(__file__).resolve().parents[1]
    parser.add_argument("--csv", type=Path, default=factory / "movements.csv")
    parser.add_argument("--json", type=Path, default=factory / "movements.json")
    parser.add_argument("--source-json", type=Path, help="Optional canonical source comparison")
    args = parser.parse_args()
    rows = read_csv(args.csv)
    json_rows = json.loads(args.json.read_text(encoding="utf-8"))
    problems = validate(rows, args.source_json)
    if rows != comparable(json_rows):
        problems.append("CSV and JSON rows are not identical")
    if problems:
        print("INVALID manifest")
        print("\n".join(f"- {problem}" for problem in problems))
        return 1
    print(f"Valid manifest: {len(rows)} jobs / {len({r['movement_code'] for r in rows})} movements / 43 standard + 43 easier")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
