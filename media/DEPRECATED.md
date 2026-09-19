# Prototype demonstration media — deprecated for production

`motion.html` and the SVG movement files in this directory are retained so the existing prototype can continue to function while replacements are made. They are internal fallback/prototype media only; they are not approved MOVA production demonstrations and must not be represented as such.

The `mova-video-factory` produces the replacement library: photorealistic, full-body MOVA exercise MP4s in standard and easier variants. Once an asset is technically QC'd, human-approved, and uploaded through `mova-video-factory/scripts/upload_to_mova.py`, the backend field `demo_asset_url` or `easier_demo_asset_url` will point at the corresponding production asset. No session needs individual editing.
