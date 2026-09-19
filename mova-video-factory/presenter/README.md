# MOVA presenter reference

Place the approved reference image at `presenter/presenter.png`. Every Wan job uses this one image; do not make per-movement presenter files.

Required image standard:

- a photorealistic, approachable adult aged roughly 30–45 with a normal athletic build;
- black fitted MOVA-style t-shirt, black work/training pants, and black trainers;
- full body, neutral standing pose, no cropped feet or hands;
- clean, dark graphite industrial studio with restrained acid-lime accents;
- no text, watermark, or visible brand other than subtle supplied MOVA clothing.

Use a portrait PNG/JPG at least 1024 px on its short edge. Keep the person centred with a little floor and headroom. The file is intentionally not included in git: it is the human-approved visual source for the whole production library.

Before a batch, run `python wan/preprocess.py --presenter presenter/presenter.png --driving motion/processed/example.mp4` from the factory root to verify that the image and a representative driving clip can be staged.
