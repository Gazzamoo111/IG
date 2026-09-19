#!/usr/bin/env python3
"""Shared, dependency-light configuration and durable state helpers for Wan jobs.

The actual Wan command is deliberately configurable: Wan2.2 Animate distributions
have changed their CLI flags over time.  Set WAN_COMMAND_TEMPLATE in the environment
or in config.json rather than editing pipeline code.
"""
from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


FACTORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = FACTORY_ROOT / "movements.csv"
STATE_PATH = FACTORY_ROOT / ".state" / "wan_jobs.json"


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def factory_path(value: str | Path | None) -> Path:
    """Resolve factory-relative paths without depending on the current directory."""
    if value is None:
        return FACTORY_ROOT
    path = Path(value)
    return path if path.is_absolute() else FACTORY_ROOT / path


def read_config() -> Dict[str, Any]:
    path = FACTORY_ROOT / "config.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in {path}: {exc}") from exc
    return payload if isinstance(payload, dict) else {}


def setting(name: str, default: str = "") -> str:
    """Resolve a setting from env first, then config.json (top-level or wan key)."""
    if name in os.environ and os.environ[name].strip():
        return os.environ[name].strip()
    config = read_config()
    value = config.get(name.lower()) or config.get("wan", {}).get(name.lower())
    return str(value) if value not in (None, "") else default


def wan_paths() -> Dict[str, Path]:
    repo = Path(setting("WAN_REPO_DIR", str(FACTORY_ROOT / "wan" / "Wan2.2"))).expanduser()
    weights = Path(setting("WAN_WEIGHTS_DIR", str(FACTORY_ROOT / "wan" / "weights"))).expanduser()
    return {"repo": repo, "weights": weights, "staging": FACTORY_ROOT / "wan" / "staging"}


def command_template() -> str:
    paths = wan_paths()
    return setting(
        "WAN_COMMAND_TEMPLATE",
        (
            'python "{repo_dir}/generate.py" --task animate-14B --ckpt_dir "{weights_dir}" '
            '--src_root_path "{processed}" --refert_num 1 --frame_num 241 '
            '--offload_model True --convert_model_dtype --save_file "{output}"'
        ),
    )


def preprocess_template() -> str:
    """Official Wan2.2 Animate preprocessing contract; override only for a pinned fork."""
    return setting(
        "WAN_PREPROCESS_COMMAND_TEMPLATE",
        (
            'python "{repo_dir}/wan/modules/animate/preprocess/preprocess_data.py" '
            '--ckpt_path "{weights_dir}/process_checkpoint" --video_path "{driving}" '
            '--refer_path "{presenter}" --save_path "{processed}" '
            '--resolution_area 576 720 --retarget_flag --use_flux'
        ),
    )


def load_manifest(path: str | Path | None = None) -> tuple[Path, List[Dict[str, str]], List[str]]:
    manifest = factory_path(path) if path else DEFAULT_MANIFEST
    if not manifest.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest}")
    with manifest.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fields = list(reader.fieldnames or [])
    if not fields:
        raise RuntimeError(f"Manifest has no header: {manifest}")
    return manifest, rows, fields


def write_manifest(path: Path, rows: Iterable[Dict[str, str]], fields: List[str]) -> None:
    """Atomically persist the manifest so an interrupted notebook does not corrupt it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", delete=False, dir=path.parent) as temp:
        writer = csv.DictWriter(temp, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
        temporary = Path(temp.name)
    temporary.replace(path)


def job_key(row: Dict[str, str]) -> str:
    code = row.get("movement_code") or row.get("code") or row.get("movement_id") or row.get("movement")
    variant = row.get("variant") or "standard"
    return f"{str(code).strip().upper()}:{str(variant).strip().lower()}"


def row_output(row: Dict[str, str]) -> Path:
    """Return the factory staging file; manifest output_path remains the published URL path."""
    code = (row.get("movement_code") or row.get("code") or "").strip().lower()
    variant = (row.get("variant") or "standard").strip().lower()
    if not code:
        raise ValueError(f"{job_key(row)} has no movement code")
    return FACTORY_ROOT / "output" / variant / f"{code}_{variant}_v1.mp4"


def row_presenter(row: Dict[str, str]) -> Path:
    return factory_path(row.get("reference_image_path") or row.get("presenter_reference_image") or "presenter/presenter.png")


def row_driving(row: Dict[str, str]) -> Path:
    value = row.get("driving_video_path") or row.get("driving_video")
    if not value:
        raise ValueError(f"{job_key(row)} has no driving_video_path")
    return factory_path(value)


def _ffprobe(path: Path) -> Optional[Dict[str, Any]]:
    if not shutil.which("ffprobe"):
        return None
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        return {"valid": False, "error": probe.stderr.strip()}
    try:
        duration = float(json.loads(probe.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"valid": False, "error": "ffprobe did not return a duration"}
    return {"valid": duration > 0, "duration": duration}


def valid_output(path: Path) -> bool:
    """A non-empty readable video is safe to skip.  ffprobe is used where available."""
    if not path.is_file() or path.stat().st_size < 1024:
        return False
    probe = _ffprobe(path)
    return probe is None or bool(probe.get("valid"))


def read_state() -> Dict[str, Any]:
    if not STATE_PATH.exists():
        return {"version": 1, "jobs": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # Keep an unreadable state file for diagnosis; the CSV remains authoritative.
        return {"version": 1, "jobs": {}}
    return data if isinstance(data, dict) and isinstance(data.get("jobs"), dict) else {"version": 1, "jobs": {}}


def update_state(key: str, **changes: Any) -> Dict[str, Any]:
    state = read_state()
    item = state["jobs"].setdefault(key, {})
    item.update(changes)
    item["updated_at"] = now()
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(STATE_PATH)
    return item


def update_row_status(
    manifest: Path, rows: List[Dict[str, str]], fields: List[str], key: str, status: str, **details: Any
) -> None:
    for row in rows:
        if job_key(row) != key:
            continue
        if "status" in fields:
            row["status"] = status
        for name, value in details.items():
            # Keep movements.csv in the fixed canonical schema. Rich diagnostics,
            # timestamps, commands and errors are deliberately persisted in the
            # sidecar state JSON instead of silently altering its header.
            if name in fields:
                row[name] = "" if value is None else str(value)
        break
    write_manifest(manifest, rows, fields)


def find_job(rows: Iterable[Dict[str, str]], selector: str) -> Dict[str, str]:
    normalized = selector.strip().upper()
    matches = [row for row in rows if job_key(row).upper() == normalized]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one job matching {selector!r}; found {len(matches)}")
    return matches[0]
