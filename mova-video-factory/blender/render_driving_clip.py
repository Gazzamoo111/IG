"""Render one MOVA Blender driving/control clip.

Examples:
  blender -b --python blender/render_driving_clip.py -- \\
    --movement-code bar_squat --pattern squat --equipment bar --variant standard

  blender -b --python blender/render_driving_clip.py -- \\
    --movement-code band_row --pattern row --equipment handle_band --variant easier \\
    --source-type fbx --source-path motion/source/band_row.fbx
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy

from apply_movement_overrides import apply_imported_motion_override, resolve_override
from build_mova_props import build_props
from config import driving_output_path, ensure_directories, normalise_equipment, normalise_pattern
from create_scene import build_base_scene
from import_motion import create_template_motion, import_or_create


def _script_args():
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parser():
    result = argparse.ArgumentParser(description="Render a MOVA Blender driving clip")
    result.add_argument("--movement-code", required=True)
    result.add_argument("--pattern", default="weight_shift")
    result.add_argument("--equipment", default="bodyweight")
    result.add_argument("--variant", choices=("standard", "easier"), required=True)
    result.add_argument("--source-type", choices=("template", "fbx", "mixamo"), default="template")
    result.add_argument("--source-path", default="")
    result.add_argument("--output", default="", help="Override canonical motion/processed path")
    result.add_argument("--save-blend", default="", help="Optional .blend debug scene path")
    result.add_argument("--dry-run", action="store_true", help="Build configuration only; do not render")
    return result


def render_job(args) -> dict:
    ensure_directories()
    pattern, equipment = normalise_pattern(args.pattern), normalise_equipment(args.equipment)
    override = resolve_override(pattern, args.variant)
    output = Path(args.output).expanduser() if args.output else driving_output_path(equipment, args.movement_code, args.variant)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    build_base_scene(override.camera_view)
    armature = import_or_create(args.source_type, args.source_path or None)
    if args.source_type == "template":
        create_template_motion(armature, pattern, range_scale=override.range_scale)
    else:
        override = apply_imported_motion_override(armature, pattern, args.variant)
    build_props(armature, equipment, pattern)

    scene = bpy.context.scene
    scene.render.filepath = str(output)
    result = {
        "movement_code": args.movement_code,
        "pattern": pattern,
        "equipment": equipment,
        "variant": args.variant,
        "source_type": args.source_type,
        "output": str(output),
        "camera_view": override.camera_view,
        "override": override.note,
        "rendered": False,
    }
    if args.save_blend:
        save_path = Path(args.save_blend).expanduser().resolve()
        save_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(save_path))
        result["blend_file"] = str(save_path)
    if not args.dry_run:
        bpy.ops.render.render(animation=True)
        result["rendered"] = True
    return result


if __name__ == "__main__":
    arguments = parser().parse_args(_script_args())
    print("MOVA_DRIVING_RESULT=" + json.dumps(render_job(arguments), sort_keys=True))
