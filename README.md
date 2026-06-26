# kyrios-web

Marketing landing page for **Kyrios** — the lead engine for the AI era.

Static site (HTML + Tailwind CDN). No build step.

## Structure
- `index.html` — main landing page
- `use-case.html` — use-case detail pages (routed via `#slug`)
- `assets/` — brand icon, favicon, and integration/source logos

## Deploy on Vercel
This is a zero-config static site. In Vercel:
1. Import this repo.
2. Framework preset: **Other** (no build command, output dir = root).
3. Deploy.

`index.html` is served at `/` and `use-case.html` at `/use-case.html`.
