"""Variant-aware motion overrides for MOVA's standard and easier clips.

Easier is never implemented as a speed change.  It has reduced range plus a
pattern-specific visible adjustment (stance, reach, step, or balance demand).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import bpy

from config import FRAME_END, FRAME_START, normalise_pattern


@dataclass(frozen=True)
class MovementOverride:
    range_scale: float = 1.0
    squat_depth: float = 1.0
    hinge_depth: float = 1.0
    step_distance: float = 1.0
    arm_elevation: float = 1.0
    stance_width: float = 1.0
    balance_demand: float = 1.0
    camera_view: str = "three_quarter"
    note: str = "full stated movement"


def resolve_override(pattern: str, variant: str) -> MovementOverride:
    pattern = normalise_pattern(pattern)
    if variant.lower() == "standard":
        return MovementOverride(camera_view="side" if pattern in {"hinge", "deadlift", "step_back", "split_shift"} else "three_quarter")

    # Movement-specific reduced variants. All have a changed geometry/range so
    # the driving source visibly signals the actual easier prescription.
    values = {
        "squat": dict(range_scale=.66, squat_depth=.60, stance_width=1.12, note="shallower squat with wider stance"),
        "squat_pulse": dict(range_scale=.52, squat_depth=.55, stance_width=1.12, note="small shallower pulse with wider stance"),
        "hinge": dict(range_scale=.62, hinge_depth=.58, stance_width=1.10, camera_view="side", note="reduced hip hinge range"),
        "deadlift": dict(range_scale=.62, hinge_depth=.58, stance_width=1.10, camera_view="side", note="reduced deadlift hinge depth"),
        "row": dict(range_scale=.70, arm_elevation=.74, hinge_depth=.70, note="smaller pull with less hinge"),
        "curl": dict(range_scale=.70, arm_elevation=.72, note="partial curl range"),
        "front_raise": dict(range_scale=.58, arm_elevation=.55, note="raise stays below shoulder height"),
        "chest_press": dict(range_scale=.70, arm_elevation=.75, note="shorter press reach"),
        "reverse_fly": dict(range_scale=.58, arm_elevation=.55, hinge_depth=.70, note="smaller fly with reduced arm spread"),
        "calf_raise": dict(range_scale=.72, balance_demand=.60, stance_width=1.15, note="lower heel lift and stable wider stance"),
        "lateral_step": dict(range_scale=.58, step_distance=.52, stance_width=1.10, note="shorter lateral step"),
        "lateral_tap": dict(range_scale=.58, step_distance=.52, stance_width=1.10, note="shorter lateral tap"),
        "march": dict(range_scale=.62, step_distance=.55, balance_demand=.60, note="lower controlled knee march"),
        "hip_abduction": dict(range_scale=.58, step_distance=.52, balance_demand=.65, note="reduced leg abduction"),
        "step_back": dict(range_scale=.58, step_distance=.52, balance_demand=.60, note="shorter supported step back"),
        "monster_walk": dict(range_scale=.58, step_distance=.52, stance_width=1.12, note="smaller monster-walk steps"),
        "rotation": dict(range_scale=.62, arm_elevation=.70, note="reduced trunk rotation"),
        "arm_sweep": dict(range_scale=.60, arm_elevation=.55, note="lower arm sweep"),
        "side_reach": dict(range_scale=.62, arm_elevation=.58, balance_demand=.70, note="shorter side reach"),
        "weight_shift": dict(range_scale=.65, step_distance=.60, stance_width=1.12, note="smaller stable weight shift"),
        "combined": dict(range_scale=.60, squat_depth=.58, arm_elevation=.60, note="reduced range on both movement components"),
        "hinge_row": dict(range_scale=.62, hinge_depth=.58, arm_elevation=.66, camera_view="side", note="smaller hinge and shorter row"),
        "squat_curl": dict(range_scale=.62, squat_depth=.58, arm_elevation=.66, note="shallow squat and shorter curl"),
        "squat_reach": dict(range_scale=.60, squat_depth=.56, arm_elevation=.55, note="shallow squat and lower reach"),
        "squat_side_step": dict(range_scale=.58, squat_depth=.56, step_distance=.50, note="shallow squat and shorter side step"),
        "wide_march": dict(range_scale=.58, step_distance=.50, balance_demand=.60, stance_width=1.08, note="low wide march / weight shift"),
        "split_shift": dict(range_scale=.60, step_distance=.52, balance_demand=.55, camera_view="side", note="smaller split-stance shift"),
        "heel_toe": dict(range_scale=.62, balance_demand=.60, note="smaller heel-toe rock"),
    }
    return MovementOverride(**values.get(pattern, dict(range_scale=.65, note="reduced range with stable stance")))


def _action_fcurves(armature):
    """Return F-curves from Blender 5.x Actions, with legacy fallback."""
    animation_data = armature.animation_data if armature else None
    action = animation_data.action if animation_data else None
    if not action:
        return []
    # Blender 5.0 removed Action.fcurves. Curves now live in a channelbag
    # associated with the action slot.
    slot = getattr(animation_data, "action_slot", None)
    if slot and getattr(action, "layers", None):
        try:
            strip = action.layers[0].strips[0]
            bag = strip.channelbag(slot, ensure=False)
            if bag:
                return list(bag.fcurves)
        except (AttributeError, IndexError, TypeError):
            pass
    return list(getattr(action, "fcurves", []))


def _scale_action_range(armature, scale: float) -> None:
    """Safely soften imported FBX rotations; template range is set upstream."""
    if scale >= .999:
        return
    for curve in _action_fcurves(armature):
        if not curve.data_path.endswith("rotation_euler"):
            continue
        for key in curve.keyframe_points:
            key.co[1] *= scale
            key.handle_left[1] *= scale
            key.handle_right[1] *= scale


def apply_imported_motion_override(armature, pattern: str, variant: str) -> MovementOverride:
    override = resolve_override(pattern, variant)
    if variant.lower() == "easier":
        _scale_action_range(armature, override.range_scale)
        # Wider, more stable base is visible even where a source FBX has no
        # editable IK controls. It uses a small root translation, not timing.
        root = next((bone for bone in armature.pose.bones if bone.name.lower().endswith(("hips", "pelvis", "root"))), None)
        if root:
            root.location.x = -0.035 * (override.stance_width - 1)
            root.keyframe_insert(data_path="location", frame=FRAME_START)
            root.keyframe_insert(data_path="location", frame=FRAME_END)
    armature["mova_variant"] = variant.lower()
    armature["mova_override"] = str(asdict(override))
    return override
