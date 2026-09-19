"""Import Mixamo motion or build reusable manual MOVA movement templates.

The templates are deliberately generic: they make a reliable, visible driving
motion when no suitable FBX is licensed/available.  A better Mixamo FBX can be
swapped in per movement without changing output naming or the render pipeline.
"""
from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector

from config import FRAME_END, FRAME_START, normalise_pattern


def _add_template_mannequin(armature):
    """Add a neutral, visible proxy body for manual-template control clips.

    This is only used when an FBX with a skinned human is unavailable.  It is a
    simple articulated mannequin—not a production animation asset—and ensures
    the control video still has an unambiguous full body for testing.
    """
    material = bpy.data.materials.new("MOVA_Template_Mannequin_Material")
    material.diffuse_color = (0.22, 0.25, 0.28, 1.0)
    limb_names = ["Spine", "Spine2", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"]
    for name in limb_names:
        bone = armature.pose.bones.get(name)
        if not bone:
            continue
        length = max(bone.bone.length, 0.12)
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.075 if "Leg" not in name else 0.095, depth=length * 1.04)
        segment = bpy.context.object
        segment.name = f"MOVA_Template_Body_{name}"
        segment.data.materials.append(material)
        segment.parent = armature
        segment.parent_type = "BONE"
        segment.parent_bone = name
        segment.matrix_parent_inverse.identity()
        segment.location = (0, length * 0.5, 0)
        segment.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=0.14)
    head = bpy.context.object
    head.name = "MOVA_Template_Body_Head"
    head.data.materials.append(material)
    head.parent = armature
    head.parent_type = "BONE"
    head.parent_bone = "Head"
    head.matrix_parent_inverse.identity()
    head.location = (0, 0.22, 0)

BONES = {
    "root": ("Hips", "mixamorig:Hips", "pelvis", "root"),
    "spine": ("Spine", "mixamorig:Spine", "spine"),
    "chest": ("Spine2", "mixamorig:Spine2", "Chest", "chest"),
    "head": ("Head", "mixamorig:Head", "head"),
    "left_upper_arm": ("LeftArm", "mixamorig:LeftArm", "upper_arm.L"),
    "right_upper_arm": ("RightArm", "mixamorig:RightArm", "upper_arm.R"),
    "left_forearm": ("LeftForeArm", "mixamorig:LeftForeArm", "forearm.L"),
    "right_forearm": ("RightForeArm", "mixamorig:RightForeArm", "forearm.R"),
    "left_thigh": ("LeftUpLeg", "mixamorig:LeftUpLeg", "thigh.L"),
    "right_thigh": ("RightUpLeg", "mixamorig:RightUpLeg", "thigh.R"),
    "left_shin": ("LeftLeg", "mixamorig:LeftLeg", "shin.L"),
    "right_shin": ("RightLeg", "mixamorig:RightLeg", "shin.R"),
}


def _find_bone(armature, role: str):
    names = {bone.name: bone for bone in armature.pose.bones}
    for candidate in BONES[role]:
        if candidate in names:
            return names[candidate]
    lower = {name.lower(): bone for name, bone in names.items()}
    for candidate in BONES[role]:
        if candidate.lower() in lower:
            return lower[candidate.lower()]
    return None


def _new_basic_rig(name="MOVA_Template_Rig"):
    """Create a small biped rig in Blender only, for template driving clips."""
    armature_data = bpy.data.armatures.new(name)
    armature = bpy.data.objects.new(name, armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name, head, tail, parent=None):
        result = armature_data.edit_bones.new(name)
        result.head, result.tail = head, tail
        result.parent = parent
        return result

    hips = bone("Hips", (0, 0, 1.0), (0, 0, 1.28))
    spine = bone("Spine", (0, 0, 1.28), (0, 0, 1.55), hips)
    chest = bone("Spine2", (0, 0, 1.55), (0, 0, 1.78), spine)
    bone("Head", (0, 0, 1.78), (0, 0, 2.05), chest)
    for side, x in (("Left", -1), ("Right", 1)):
        arm = bone(f"{side}Arm", (0.0, 0, 1.68), (x * 0.36, 0, 1.50), chest)
        forearm = bone(f"{side}ForeArm", (x * 0.36, 0, 1.50), (x * 0.62, 0, 1.35), arm)
        bone(f"{side}Hand", (x * 0.62, 0, 1.35), (x * 0.72, 0, 1.31), forearm)
        thigh = bone(f"{side}UpLeg", (x * 0.12, 0, 1.0), (x * 0.14, 0, 0.55), hips)
        shin = bone(f"{side}Leg", (x * 0.14, 0, 0.55), (x * 0.14, 0.02, 0.10), thigh)
        bone(f"{side}Foot", (x * 0.14, 0.02, 0.10), (x * 0.14, -0.18, 0.06), shin)
    bpy.ops.object.mode_set(mode="OBJECT")
    _add_template_mannequin(armature)
    return armature


def import_fbx(path: str | Path):
    path = Path(path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Motion source not found: {path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True, automatic_bone_orientation=True)
    imported = [obj for obj in bpy.data.objects if obj not in before]
    armature = next((obj for obj in imported if obj.type == "ARMATURE"), None)
    if not armature:
        raise RuntimeError(f"No armature found in FBX: {path}")
    armature.name = "MOVA_Presenter_Rig"
    return armature


def import_or_create(source_type: str = "template", source_path: str | None = None):
    if source_type.lower() in {"fbx", "mixamo"}:
        if not source_path:
            raise ValueError("source_path is required when source_type is fbx/mixamo")
        return import_fbx(source_path)
    return _new_basic_rig()


def _set_rotation(armature, role, frame, rotation, strength=1.0):
    bone = _find_bone(armature, role)
    if not bone:
        return
    bone.rotation_mode = "XYZ"
    bone.rotation_euler = tuple(axis * strength for axis in rotation)
    bone.keyframe_insert(data_path="rotation_euler", frame=frame)


def _set_location(armature, role, frame, location):
    bone = _find_bone(armature, role)
    if not bone:
        return
    bone.location = location
    bone.keyframe_insert(data_path="location", frame=frame)


def _frame_cycle(armature, poses, range_scale=1.0):
    """Key start/middle/end, matching start/end for an almost seamless loop."""
    start, middle, end = FRAME_START, (FRAME_START + FRAME_END) // 2, FRAME_END
    for role, start_rotation, middle_rotation in poses:
        _set_rotation(armature, role, start, start_rotation, range_scale)
        _set_rotation(armature, role, middle, middle_rotation, range_scale)
        _set_rotation(armature, role, end, start_rotation, range_scale)


def _template_poses(pattern: str):
    d = math.radians
    common_squat = [
        ("left_thigh", (0, 0, 0), (d(-45), 0, 0)), ("right_thigh", (0, 0, 0), (d(-45), 0, 0)),
        ("left_shin", (0, 0, 0), (d(32), 0, 0)), ("right_shin", (0, 0, 0), (d(32), 0, 0)),
    ]
    templates = {
        "squat": common_squat,
        "squat_pulse": common_squat,
        "hinge": [("spine", (0, 0, 0), (d(35), 0, 0)), ("left_thigh", (0, 0, 0), (d(-24), 0, 0)), ("right_thigh", (0, 0, 0), (d(-24), 0, 0))],
        "deadlift": [("spine", (0, 0, 0), (d(31), 0, 0)), ("left_thigh", (0, 0, 0), (d(-28), 0, 0)), ("right_thigh", (0, 0, 0), (d(-28), 0, 0)), ("left_forearm", (0, 0, 0), (d(10), 0, 0)), ("right_forearm", (0, 0, 0), (d(10), 0, 0))],
        "row": [("left_upper_arm", (0, 0, 0), (d(-20), 0, 0)), ("right_upper_arm", (0, 0, 0), (d(-20), 0, 0)), ("left_forearm", (0, 0, 0), (d(-75), 0, 0)), ("right_forearm", (0, 0, 0), (d(-75), 0, 0)), ("spine", (0, 0, 0), (d(16), 0, 0))],
        "curl": [("left_forearm", (0, 0, 0), (d(-105), 0, 0)), ("right_forearm", (0, 0, 0), (d(-105), 0, 0))],
        "front_raise": [("left_upper_arm", (0, 0, 0), (d(-92), 0, 0)), ("right_upper_arm", (0, 0, 0), (d(-92), 0, 0))],
        "chest_press": [("left_upper_arm", (0, 0, 0), (d(-35), 0, 0)), ("right_upper_arm", (0, 0, 0), (d(-35), 0, 0)), ("left_forearm", (0, 0, 0), (d(60), 0, 0)), ("right_forearm", (0, 0, 0), (d(60), 0, 0))],
        "reverse_fly": [("left_upper_arm", (0, 0, 0), (0, d(-62), 0)), ("right_upper_arm", (0, 0, 0), (0, d(62), 0)), ("spine", (0, 0, 0), (d(18), 0, 0))],
        "calf_raise": [],
        "lateral_step": [],
        "lateral_tap": [],
        "march": [],
        "hip_abduction": [],
        "step_back": [],
        "monster_walk": [],
        "rotation": [("spine", (0, 0, 0), (0, 0, d(30))), ("chest", (0, 0, 0), (0, 0, d(40)))],
        "arm_sweep": [("left_upper_arm", (0, 0, 0), (0, d(-72), d(-15))), ("right_upper_arm", (0, 0, 0), (0, d(72), d(15)))],
        "side_reach": [("left_upper_arm", (0, 0, 0), (0, d(-70), 0)), ("spine", (0, 0, 0), (0, 0, d(-22)))],
        "weight_shift": [],
        "combined": common_squat + [("left_upper_arm", (0, 0, 0), (d(-45), 0, 0)), ("right_upper_arm", (0, 0, 0), (d(-45), 0, 0))],
    }
    return templates.get(pattern, templates["weight_shift"])


def _locomotion(armature, pattern: str, range_scale: float):
    start, middle, end = FRAME_START, (FRAME_START + FRAME_END) // 2, FRAME_END
    d = math.radians
    if pattern == "calf_raise":
        _set_location(armature, "root", start, (0, 0, 0)); _set_location(armature, "root", middle, (0, 0, 0.10 * range_scale)); _set_location(armature, "root", end, (0, 0, 0))
    elif pattern in {"lateral_step", "lateral_tap", "hip_abduction", "monster_walk"}:
        _set_location(armature, "root", start, (0, 0, 0)); _set_location(armature, "root", middle, (0.42 * range_scale, 0, 0)); _set_location(armature, "root", end, (0, 0, 0))
        _set_rotation(armature, "left_thigh", middle, (d(-25), 0, 0), range_scale)
    elif pattern in {"march", "step_back"}:
        _set_location(armature, "root", start, (0, 0, 0)); _set_location(armature, "root", middle, (0, -0.22 * range_scale, 0)); _set_location(armature, "root", end, (0, 0, 0))
        _set_rotation(armature, "left_thigh", middle, (d(-42), 0, 0), range_scale)
    elif pattern == "weight_shift":
        _set_location(armature, "root", start, (0, 0, 0)); _set_location(armature, "root", middle, (0.20 * range_scale, 0, 0)); _set_location(armature, "root", end, (0, 0, 0))


def create_template_motion(armature, movement_pattern: str, range_scale: float = 1.0):
    pattern = normalise_pattern(movement_pattern)
    if armature.animation_data:
        armature.animation_data_clear()
    _frame_cycle(armature, _template_poses(pattern), range_scale)
    _locomotion(armature, pattern, range_scale)
    action = armature.animation_data.action if armature.animation_data else None
    if action:
        for curve in action.fcurves:
            for key in curve.keyframe_points:
                key.interpolation = "BEZIER"
    return armature
