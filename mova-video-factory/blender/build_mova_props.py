"""Programmatic proxy equipment for Blender driving clips.

These are intentionally clean control props, not final product renders.  They
give the animation model clear equipment geometry while retaining a consistent
graphite / acid-lime MOVA visual language.
"""
from __future__ import annotations

import math

import bpy
from mathutils import Vector

from config import GRAPHITE, GRAPHITE_LIGHT, LIME, normalise_equipment
from create_scene import make_material

BONE_ALIASES = {
    "left_hand": ("LeftHand", "mixamorig:LeftHand", "hand.L", "Hand.L"),
    "right_hand": ("RightHand", "mixamorig:RightHand", "hand.R", "Hand.R"),
    "left_foot": ("LeftFoot", "mixamorig:LeftFoot", "foot.L", "Foot.L"),
    "right_foot": ("RightFoot", "mixamorig:RightFoot", "foot.R", "Foot.R"),
    "left_thigh": ("LeftUpLeg", "mixamorig:LeftUpLeg", "thigh.L", "Thigh.L"),
    "right_thigh": ("RightUpLeg", "mixamorig:RightUpLeg", "thigh.R", "Thigh.R"),
}


def _mat(name, color, metallic=0.0, roughness=0.5):
    return make_material(name, color, metallic=metallic, roughness=roughness)


def _set_material(obj, material):
    obj.data.materials.append(material)
    return obj


def _bone_name(armature, alias: str) -> str | None:
    if not armature or armature.type != "ARMATURE":
        return None
    available = {bone.name for bone in armature.pose.bones}
    for candidate in BONE_ALIASES[alias]:
        if candidate in available:
            return candidate
    # Case-insensitive fallback supports slightly different imported rigs.
    for candidate in BONE_ALIASES[alias]:
        found = next((name for name in available if name.lower() == candidate.lower()), None)
        if found:
            return found
    return None


def _follow_bone(obj, armature, alias: str, offset=(0, 0, 0), rotation=(0, 0, 0)):
    bone = _bone_name(armature, alias)
    if not bone:
        return False
    constraint = obj.constraints.new("CHILD_OF")
    constraint.name = f"MOVA_follow_{alias}"
    constraint.target = armature
    constraint.subtarget = bone
    constraint.inverse_matrix = armature.matrix_world.inverted()
    obj.location = offset
    obj.rotation_euler = rotation
    return True


def _cylinder(name, radius, depth, material, location=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    return _set_material(obj, material)


def _cube(name, dimensions, material, location=(0, 0, 0), bevel=0.08):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel_mod = obj.modifiers.new("Soft edge", "BEVEL")
    bevel_mod.width = bevel
    bevel_mod.segments = 2
    return _set_material(obj, material)


def _curve(name, points, bevel_depth, material, cyclic=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = bevel_depth
    curve.bevel_resolution = 3
    spline = curve.splines.new("NURBS")
    spline.points.add(len(points) - 1)
    for point, coordinate in zip(spline.points, points):
        point.co = (*coordinate, 1.0)
    spline.order_u = min(3, len(points))
    spline.use_endpoint_u = not cyclic
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def _prop_collection():
    name = "MOVA_Equipment_Props"
    collection = bpy.data.collections.get(name)
    if collection:
        for obj in list(collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        return collection
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def _move_to_collection(obj, collection):
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def build_bar(armature, collection):
    dark, lime = _mat("MOVA_Prop_Graphite", GRAPHITE_LIGHT, 0.55, 0.26), _mat("MOVA_Prop_Lime", LIME, 0.2, 0.3)
    bar = _move_to_collection(_cylinder("MOVA_Bar", 0.036, 1.12, dark, rotation=(0, math.pi / 2, 0)), collection)
    _follow_bone(bar, armature, "left_hand", offset=(0.28, 0.0, 0.0), rotation=(0, math.pi / 2, 0))
    for x in (-0.31, 0.31):
        collar = _move_to_collection(_cylinder("MOVA_Bar_Lime_Collar", 0.052, 0.045, lime, rotation=(0, math.pi / 2, 0)), collection)
        collar.parent = bar
        collar.location = (x, 0, 0)
    # Short proxy cords communicate foot-anchored resistance.  They are visual
    # guides, parented to the bar; operators can replace with a dynamic spline.
    for y in (-0.17, 0.17):
        cord = _move_to_collection(_curve("MOVA_Bar_Resistance_Cord", [(0, y, -0.02), (0.05, y, -0.65)], 0.012, dark), collection)
        cord.parent = bar
    return [bar]


def build_handle_band(armature, collection):
    dark, lime = _mat("MOVA_Band_Dark", GRAPHITE, 0.15, 0.32), _mat("MOVA_Band_Lime", LIME, 0.12, 0.36)
    left_handle = _move_to_collection(_cube("MOVA_Handle_Band_Left_Handle", (0.10, 0.055, 0.20), lime), collection)
    right_handle = _move_to_collection(_cube("MOVA_Handle_Band_Right_Handle", (0.10, 0.055, 0.20), lime), collection)
    left_ok = _follow_bone(left_handle, armature, "left_hand", offset=(0.0, 0.02, 0.0))
    right_ok = _follow_bone(right_handle, armature, "right_hand", offset=(0.0, 0.02, 0.0))
    # A neutral U-shaped tube is parented to the pelvis/root until a rig-aware
    # curve handler is supplied; endpoints still travel with the hand props.
    tube = _move_to_collection(_curve("MOVA_Handle_Band_Tube", [(-0.32, 0, 1.0), (0, 0.15, 0.42), (0.32, 0, 1.0)], 0.022, dark), collection)
    tube.parent = armature
    return [left_handle, right_handle, tube]


def build_mini_band(armature, collection):
    dark, lime = _mat("MOVA_MiniBand_Dark", GRAPHITE_LIGHT, 0.05, 0.4), _mat("MOVA_MiniBand_Lime", LIME, 0.1, 0.38)
    # A flattened closed loop at knee height. It follows left thigh so it
    # remains attached during templates; it is deliberately obvious to WAN.
    band = _move_to_collection(_curve(
        "MOVA_Mini_Band",
        [(-0.26, 0, 0.0), (-0.18, -0.08, 0.0), (0.18, -0.08, 0.0), (0.26, 0, 0.0), (0.18, 0.08, 0.0), (-0.18, 0.08, 0.0)],
        0.038,
        dark,
        cyclic=True,
    ), collection)
    _follow_bone(band, armature, "left_thigh", offset=(0.0, 0.0, -0.27))
    stripe = _move_to_collection(_curve("MOVA_Mini_Band_Lime_Accent", [(-0.10, -0.09, 0.01), (0.10, -0.09, 0.01)], 0.02, lime), collection)
    stripe.parent = band
    return [band, stripe]


def build_props(armature, equipment: str, movement_pattern: str = "") -> list:
    """Replace and construct proxy equipment. ``bodyweight`` returns no props."""
    collection = _prop_collection()
    equipment = normalise_equipment(equipment)
    if equipment == "bar":
        return build_bar(armature, collection)
    if equipment == "handle_band":
        return build_handle_band(armature, collection)
    if equipment == "mini_band":
        return build_mini_band(armature, collection)
    return []
