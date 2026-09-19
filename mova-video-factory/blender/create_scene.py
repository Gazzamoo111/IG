"""Create the fixed, low-distraction MOVA driving-video scene.

Run directly for a scene sanity check:
    blender -b --python blender/create_scene.py -- --save /tmp/mova_scene.blend
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

from config import (
    BACKGROUND, CAMERA_3Q_LOCATION, CAMERA_LENS_MM, CAMERA_SIDE_LOCATION,
    CAMERA_TARGET, FRAME_END, FRAME_START, FPS, GRAPHITE, GRAPHITE_LIGHT,
    RESOLUTION_X, RESOLUTION_Y,
)


def _look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def make_material(name: str, color, metallic: float = 0.0, roughness: float = 0.5):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    return material


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        # Keep nothing from a previous render setup. Unused datablocks are fine,
        # but named props below deliberately retrieve their own materials.
        for item in list(datablocks):
            if item.users == 0:
                datablocks.remove(item)


def add_floor() -> None:
    mat = make_material("MOVA_Floor", GRAPHITE, metallic=0.15, roughness=0.38)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "MOVA_Driving_Floor"
    floor.data.materials.append(mat)

    # A narrow lime floor marker makes orientation visible to the video model
    # without becoming a fake studio background.
    lime = make_material("MOVA_Floor_Marker", (0.18, 0.48, 0.04, 1.0), roughness=0.45)
    bpy.ops.mesh.primitive_cube_add(location=(0, 1.7, 0.012), scale=(1.6, 0.018, 0.012))
    marker = bpy.context.object
    marker.name = "MOVA_Floor_Orientation_Marker"
    marker.data.materials.append(lime)


def add_camera(view: str = "three_quarter") -> bpy.types.Object:
    bpy.ops.object.camera_add(location=CAMERA_SIDE_LOCATION if view == "side" else CAMERA_3Q_LOCATION)
    camera = bpy.context.object
    camera.name = "MOVA_Driving_Camera"
    camera.data.lens = CAMERA_LENS_MM
    camera.data.sensor_width = 32
    _look_at(camera, CAMERA_TARGET)
    bpy.context.scene.camera = camera
    return camera


def add_lights() -> None:
    def area(name, location, energy, size, color):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        _look_at(light, (0, 0, 1.1))

    area("MOVA_Key", (4.5, -4.0, 6.5), 1100, 4.5, (0.88, 0.94, 1.0))
    area("MOVA_Fill", (-4.0, -1.0, 4.0), 700, 3.0, (0.56, 0.68, 0.8))
    area("MOVA_Rim", (0.5, 4.0, 5.5), 950, 3.0, (0.55, 0.92, 0.16))


def configure_render() -> None:
    scene = bpy.context.scene
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
    scene.render.fps = FPS
    scene.render.resolution_x = RESOLUTION_X
    scene.render.resolution_y = RESOLUTION_Y
    scene.render.resolution_percentage = 100
    # Blender's macOS build may not include FFmpeg output support. Render
    # deterministic PNG frames here; render_driving_clip.py encodes them with
    # the system ffmpeg binary installed on the host.
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.image_settings.color_mode = "RGB"
    scene.world.color = BACKGROUND[:3]
    scene.view_settings.look = "AgX - Medium High Contrast"


def build_base_scene(view: str = "three_quarter") -> bpy.types.Object:
    """Reset Blender and make the canonical full-body driving-video setup."""
    clear_scene()
    configure_render()
    add_floor()
    add_lights()
    return add_camera(view)


def _argv() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


if __name__ == "__main__":
    args = _argv()
    view = args[args.index("--view") + 1] if "--view" in args else "three_quarter"
    build_base_scene(view)
    if "--save" in args:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(args[args.index("--save") + 1]).expanduser()))
