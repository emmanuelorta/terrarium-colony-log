# Terrarium Station — Colony Log v2

Internal breeding/husbandry log. **Live (login-gated) at** `terrariumstation.com/colony-log/`.

## Architecture
- `index.html` — the full single-file app (38 KB). Served by WordPress, not from this repo.
- `snippet-A-cpt.php` — Code Snippets snippet 100: registers CPT `sv_colony` (+ meta `svc_data`, REST base `colonies`).
- `snippet-B-page.php` — Code Snippets snippet 101: `parse_request` route for `/colony-log/`, serves the app from a gzip+base64 payload, injects `__WPNONCE__`, noindex.

## Storage
Records live in **WordPress** (`wp_posts` via `/wp-json/wp/v2/colonies`), not localStorage and not this repo. Colony records are the upstream half of the SpeciesVault pedigree chain and must share a DB with accessions.

## Deploying a change
Edit `index.html` → gzip+base64 → replace payload in snippet 101 (byte-verify length). This repo is the source of record only.

## Caveats
- CPT is invisible in wp-admin (REST-only by design).
- Deactivating snippet 100 hides rows (data persists in wp_posts).
- Export JSON monthly from the app.
