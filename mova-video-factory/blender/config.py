"""Shared settings for MOVA Blender driving clips.

All paths are derived from this file so the factory can move with a clone of
the repository.  The module deliberately has no ``bpy`` dependency: the
batch dispatcher can read it with ordinary Python as well as Blender Python.
"""
from __future__ import annotations

from pathlib import Path

BLENDER_DIR = Path(__file__).resolve().parent
FACTORY_DIR = BLENDER_DIR.parent
MOTION_DIR = FACTORY_DIR / "motion"
MOTION_SOURCE_DIR = MOTION_DIR / "source"
DRIVING_DIR = MOTION_DIR / "processed"
MOTION_MANIFEST = MOTION_DIR / "motion_manifest.csv"
MIXAMO_MOTION_MAP = MOTION_DIR / "mixamo_motion_map.csv"
MOVEMENT_MANIFEST = FACTORY_DIR / "movements.csv"
BATCH_REPORT = MOTION_DIR / "blender_batch_report.csv"

# A compact, 4:5, deliberately plain control video.  WAN may crop/scale this
# but its camera framing remains consistent between all movements.
FPS = 30
DURATION_SECONDS = 8
FRAME_START = 1
FRAME_END = FPS * DURATION_SECONDS
RESOLUTION_X = 720
RESOLUTION_Y = 900
OUTPUT_EXTENSION = ".mp4"

# Fixed camera.  The target lives around the presenter pelvis; side views are
# reserved for hinge/deadlift patterns where the mechanics communicate better.
CAMERA_3Q_LOCATION = (6.8, -8.4, 4.9)
CAMERA_SIDE_LOCATION = (8.8, 0.0, 4.1)
CAMERA_TARGET = (0.0, 0.0, 1.25)
CAMERA_LENS_MM = 52

GRAPHITE = (0.035, 0.045, 0.055, 1.0)
GRAPHITE_LIGHT = (0.13, 0.16, 0.18, 1.0)
LIME = (0.46, 0.86, 0.10, 1.0)
BACKGROUND = (0.018, 0.022, 0.028, 1.0)

EQUIPMENT_ALIASES = {
    "bar": "bar",
    "mova bar": "bar",
    "handle_band": "handle_band",
    "handle band": "handle_band",
    "band": "handle_band",
    "mini_band": "mini_band",
    "mini band": "mini_band",
    "bodyweight": "bodyweight",
    "none": "bodyweight",
    "": "bodyweight",
}


def normalise_equipment(value: str | None) -> str:
    return EQUIPMENT_ALIASES.get((value or "").strip().lower(), (value or "bodyweight").strip().lower())


def normalise_pattern(value: str | None) -> str:
    pattern = (value or "weight_shift").strip().lower().replace("-", "_").replace(" ", "_")
    # The canonical MOVA library also uses broad taxonomy labels.  Translate
    # them to a visible reusable template rather than rendering an idle pose.
    return {
        "combo": "combined",
        "lateral": "lateral_step",
        "locomotion": "march",
        "lower_leg": "calf_raise",
        "pull": "row",
        "push": "chest_press",
        "shoulder": "front_raise",
    }.get(pattern, pattern)


def procedural_pattern_for_code(movement_code: str, fallback: str | None = None) -> str:
    """Return the specific procedural motion family for a MOVA movement code."""
    code = (movement_code or "").strip().upper()
    suffix_map = (
        ("SQUAT_SIDE_STEP", "squat_side_step"),
        ("SQUAT_REACH", "squat_reach"),
        ("SQUAT_CURL", "squat_curl"),
        ("HINGE_ROW", "hinge_row"),
        ("SQUAT_PULSE", "squat_pulse"),
        ("HIP_ABDUCTION", "hip_abduction"),
        ("LATERAL_TAP", "lateral_tap"),
        ("LATERAL_STEP", "lateral_step"),
        ("MONSTER_WALK", "monster_walk"),
        ("WIDE_MARCH", "wide_march"),
        ("STEP_BACK", "step_back"),
        ("SPLIT_SHIFT", "split_shift"),
        ("THORACIC_ROTATION", "rotation"),
        ("SIDE_REACH", "side_reach"),
        ("ARM_SWEEP", "arm_sweep"),
        ("HEEL_TOE_ROCK", "heel_toe"),
        ("CALF_RAISE", "calf_raise"),
        ("FRONT_RAISE", "front_raise"),
        ("REVERSE_FLY", "reverse_fly"),
        ("CHEST_PRESS", "chest_press"),
        ("DEADLIFT", "deadlift"),
        ("HINGE", "hinge"),
        ("SQUAT", "squat"),
        ("CURL", "curl"),
        ("ROW", "row"),
        ("MARCH", "march"),
    )
    for suffix, pattern in suffix_map:
        if code.endswith(suffix):
            return pattern
    return normalise_pattern(fallback)

def mixamo_source_for_movement(movement_code: str) -> dict[str, str] | None:
    """Resolve the acquisition map without requiring per-row manifest edits.

    Procedural Blender is the production default. This optional resolver is
    retained only for an explicit future FBX override.
    """
    if not MIXAMO_MOTION_MAP.exists():
        return None
    import csv

    with MIXAMO_MOTION_MAP.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            if row.get("movement_code", "").strip().upper() != movement_code.strip().upper():
                continue
            filename = row.get("source_filename", "").strip()
            mode = row.get("source_mode", "").strip().lower()
            if mode == "mixamo" and filename:
                return {
                    "source_type": "mixamo",
                    "source_path": str(MOTION_SOURCE_DIR / filename),
                    "pattern": normalise_pattern(row.get("blender_pattern")),
                    "source_filename": filename,
                    "source_mode": mode,
                }
            return {
                "source_type": "template",
                "source_path": "",
                "pattern": normalise_pattern(row.get("blender_pattern")),
                "source_filename": "",
                "source_mode": mode or "scripted_blender",
            }
    return None


def driving_output_path(equipment: str, movement_code: str, variant: str) -> Path:
    """Canonical non-final control-asset location, e.g. motion/processed/bar/foo/standard_v1.mp4."""
    return DRIVING_DIR / normalise_equipment(equipment) / movement_code.lower() / f"{variant.lower()}_v1{OUTPUT_EXTENSION}"


def ensure_directories() -> None:
    MOTION_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    DRIVING_DIR.mkdir(parents=True, exist_ok=True)
