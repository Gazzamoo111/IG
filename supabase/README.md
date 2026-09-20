# MOVA Supabase backend

This folder mirrors the deployed MOVA Supabase backend.

- `functions/mova-scan/index.ts`: driver QR/session API
- `functions/mova-console/index.ts`: admin and fleet dashboard API
- `schema/demo_identity_challenges.sql`: optional participant/challenge layer and analytics population fields

Normal MOVA sessions remain anonymous by default. Named participant identity is optional and is intended for future opt-in challenges, rewards and personal progress.

The public GitHub Pages client must never contain a Supabase service-role/secret key. Edge Functions use server-side environment variables.
