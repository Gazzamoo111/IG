# MOVA Scanner v1

Static mobile frontend for the MOVA kit QR experience.

## Flow
QR → 3/5/10 → goal → MOVA selects equipment → start → completion → feedback.

## Backend
Supabase Edge Function: `mova-scan`

## Branding
The approved MOVA logo artwork is used directly by the UI. Do not recreate the logo in CSS or text.

## Demo token
The prototype kit is `MOVA-DEMO-001`.

## Deploy
Publish the `main` branch root with GitHub Pages. The kit QR points to the Pages URL with the kit token in `?t=<token>`.
