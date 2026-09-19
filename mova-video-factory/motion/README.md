# MOVA motion sources

`source/` holds licensed Mixamo FBX files or other approved source motions.
`processed/` holds rendered Blender driving clips, not final presenter media.

`mixamo_motion_map.csv` is the canonical acquisition map. It covers every active
MOVA movement while requiring only the seven FBX files listed in
`mixamo_download_list.md`. The Blender batch dispatcher reads this map first:
place the listed files in `source/` with their exact internal filenames and it
will select the correct shared FBX automatically. Rows marked
`source_mode=scripted_blender` intentionally select the deterministic Blender
template instead—no Mixamo file is required for them.

The `motion_manifest.csv` file is a reusable pattern catalogue. For every
movement the batch renderer creates both `standard` and `easier` clips. The
easier variant changes range and pattern geometry (depth, reach, stance, or
step distance), never simply timing.

To acquire Mixamo sources, download an animation in **FBX Binary** with **Skin**
from a properly licensed Mixamo/Adobe account and put it below `source/`. Put
the relative path in `motion_source_path`; do not commit unlicensed files.

Typical run from the factory root:

```bash
python blender/batch_render.py --dry-run
python blender/batch_render.py --blender /Applications/Blender.app/Contents/MacOS/Blender --max-items 2
```

The dispatcher appends `blender_batch_report.csv`, skips non-empty existing MP4s
on re-run, and supports `--force` only for intentional re-rendering.
