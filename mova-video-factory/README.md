# MOVA Video Factory

This is the production pipeline for the MOVA exercise-demonstration library. It turns the 43 active movement definitions in MOVA into 86 tracked jobs: a **standard** and an **easier** photorealistic video for each movement. It does not create browser animations, SVG demos, stick figures, or placeholder final media.

The factory creates **control assets** first (Blender driving clips), then uses one still presenter reference with Wan2.2 Animate to produce the final MP4s. Every job has a durable manifest row, result status, retry count, output path, and QC result. A rerun skips an existing, valid, approved output unless `--force` is explicitly requested.

## What is automated

1. Extracting active movement definitions from the MOVA admin read endpoint or a saved JSON export.
2. Creating the 86-row manifest, output paths, motion-clip paths, prompts, and versioned status fields.
3. Creating a repeatable Blender scene, camera, proxy MOVA equipment, driving clips, and visibly different easier overrides.
4. Calling a locally installed open-source Wan2.2 Animate workflow from a Kaggle GPU or another GPU machine.
5. Restarting failed/interrupted batches, retrying failed jobs, and never silently overwriting an approved result.
6. Technical QC, review-contact-sheet generation where FFmpeg is available, and MOVA media mapping after approval.

## Required inputs

| Input | Location | Notes |
| --- | --- | --- |
| Presenter reference | `presenter/presenter.png` | One full-body, neutral-pose PNG for all 86 videos. It is intentionally not committed. |
| Motion source | Procedural Blender by default | Mixamo FBX files in `motion/source/` are optional legacy/fallback inputs only. |
| Blender driving clips | `motion/processed/` | Generated MP4 control assets. |
| Wan2.2 weights | Kaggle/local cache | Obtain from the official Wan2.2 release/license source; do not commit weights. |
| Canonical MOVA data | Admin endpoint or JSON export | The generated `movements.json` is the immutable build snapshot. |

Final media names are always:

```text
media/{equipment}/{movement_code_lower}/standard_v1.mp4
media/{equipment}/{movement_code_lower}/easier_v1.mp4
```

The repository’s existing `media/motion.html` and SVG files remain in place only as deprecated internal/prototype fallback. See [`../media/DEPRECATED.md`](../media/DEPRECATED.md). They are not approved production demonstrations.

## 1. Build or refresh the movement manifest

The repository already has a public MOVA admin-read endpoint configured in `admin.js`. To snapshot its active records, run this from the repository root:

```bash
cd mova-video-factory
python3 scripts/build_manifest.py --from-api
python3 scripts/validate_manifest.py --csv movements.csv --json movements.json
```

For an offline/reproducible build, export the source response first and use it instead:

```bash
python3 scripts/build_manifest.py --source-json /path/to/mova-admin.json
python3 scripts/validate_manifest.py --csv movements.csv --json movements.json
```

This creates exactly two rows per active movement. It retains the canonical movement code, equipment, cues, space requirement, and video brief; the `variant` field selects the standard name/cue or the existing easier name/cue. Do not hand-edit status columns: batch scripts own them.

## 2. Add the presenter reference

Place the approved still at:

```text
mova-video-factory/presenter/presenter.png
```

Use one approachable, athletic adult (roughly 30–45), full body, black MOVA-style shirt/work pants/trainers, neutral stance, and a dark graphite industrial studio with restrained acid-lime accents. No text, extra people, or changing presenter identities. The pipeline intentionally rejects a run without this exact file.

## 3. Generate the 86 procedural Blender driving clips

Procedural Blender is the production default. No Mixamo download is required.

From `mova-video-factory/`:

```bash
python3 blender/batch_render.py --manifest movements.csv --all
```

The batch dispatcher:

- resolves every MOVA movement to a specific procedural movement family
- creates Standard and Easier variants
- uses the fixed 720×900, 30 FPS, 8-second driving-video contract
- adds MOVA Bar / Handle Band / Mini Band proxy equipment where required
- skips existing valid clips on rerun
- continues after individual failures
- supports `--job-id CODE:variant`, `--max-items`, `--resume`, `--force`, and `--dry-run`

Mixamo support remains available only as an optional fallback and is not required for the standard 86-job build.

After rendering:

```bash
python3 scripts/qc_driving_motion.py
```

This creates:

- `motion/driving_motion_qc.csv`
- `motion/driving_motion_contact_sheet.html`

The contact sheet is the fast human review step before Wan generation.

## 4. Run Wan2.2 Animate locally or on Kaggle

The free Kaggle workflow is the recommended route:

1. Provide `presenter/presenter.png` plus the generated `motion/processed/` clips to the notebook. The source repository may be cloned normally; generated control clips can be added as private Kaggle input if they are not committed.
2. Create a Kaggle notebook with a GPU accelerator. Enable Internet only when the chosen official Wan source/weights require it.
3. Upload/open `kaggle/MOVA_Video_Factory.ipynb`.
4. Set the configuration cell (`TEST_ONE`, `BATCH_COUNT`, `RESUME`, `GENERATE_ALL_MISSING`, dataset/repository paths, and Wan weights source), then run all cells in order.

The notebook installs Wan2.2 Animate from the configured open-source repository, verifies GPU/presenter/driving clips, performs an initial test job, runs the selected batch, runs QC, and leaves reports in `output/qc/`. It has no paid-API dependency.

For a configured local Wan checkout, the equivalent commands are:

```bash
python3 wan/setup_wan.py --clone --install --download-weights
python3 wan/generate_single.py --manifest movements.csv --job-id BAR_SQUAT:standard
python3 wan/generate_batch.py --manifest movements.csv --count 8
python3 wan/resume_batch.py --manifest movements.csv --retry-failed
```

The Wan command is configured in `wan/config.py`/`config.json`. You must set the exact official Wan2.2 Animate checkout and weights locations for the version you install; the factory deliberately does not guess model links or accept a paid API as a substitute.

## 5. Test, batch, and resume

Test one job first. Confirm that it is a photorealistic full-body 4:5, fixed-camera, silent, loopable 6–10 second MP4 and that the equipment/variant are correct. Then run a small batch.

```bash
python3 scripts/batch_status.py --manifest movements.csv
python3 wan/generate_batch.py --manifest movements.csv --count 8
python3 wan/resume_batch.py --manifest movements.csv --retry-failed --max-attempts 3
```

`status=complete` is assigned only after a non-empty output exists. `qc_status=approved` is never set automatically. The resume tool skips only complete, valid files and retries failed/pending rows according to the retry limit. Use `--force` to intentionally regenerate a valid complete item.

## 6. QC and human approval

```bash
python3 scripts/qc_media.py --manifest movements.csv --report output/qc/qc_report.csv --contact-sheets
```

The report checks existence, readable/corrupt files, 4:5 geometry, duration, frame rate, and basic frame continuity where FFprobe/FFmpeg is installed. It also flags a likely subject leaving the frame when the optional OpenCV dependency is present. `output/qc/` holds report and review assets. A human must inspect each flagged item and manually change `qc_status` to `approved` only after checking presenter consistency, technique, equipment, and loop quality.

## 7. Upload approved media to MOVA

Approved files map directly to the existing backend fields: `demo_asset_url` for standard and `easier_demo_asset_url` for easier. The same movement asset is reused by every session that selects that movement.

After human approval, first stage the reviewed factory outputs at their required `media/{equipment}/...` paths in the IG repository:

```bash
python3 scripts/sync_mova_media.py --manifest movements.csv --repo-root .. --write-manifest
```

```bash
# Inspect what would be sent; no files or database records are changed.
python3 scripts/upload_to_mova.py --manifest movements.csv --mode dry-run

# Upload files to your configured storage endpoint, then update MOVA mappings.
export MOVA_ADMIN_API_URL='https://your-mova-admin-write-endpoint'
export MOVA_ADMIN_KEY='your-admin-key'
python3 scripts/upload_to_mova.py --manifest movements.csv --mode upload

# Confirm every approved row resolves to its expected media location.
python3 scripts/upload_to_mova.py --manifest movements.csv --mode verify
```

The integration uses configuration/environment variables because the static frontend exposes no safe write credential. Never commit a production MOVA admin key.

## Status and directories

```text
output/standard/  final standard results before publishing
output/easier/    final easier results before publishing
output/failed/    renderer logs and failed-work artefacts
output/qc/        QC CSVs, previews, and contact sheets
```

Manifest fields persist generation version, attempt count, generation status, output path, and QC state. The pipeline is safe to interrupt between any two jobs because it rewrites the manifest atomically after each result.
