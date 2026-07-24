# Roblox Growth Scout

Twice-daily acquisition radar for young Roblox games, with sponsorship screening.
Static report built from committed snapshot history — see `CLAUDE.md` for the full
mechanics spec and working rules.

- `node collector.js` — run a scan (appends to `data/history.jsonl`)
- `node report.js` — build `site/index.html`
- `node test/dry-run.js` — validate history + report build

Deploys: GitHub Actions (`.github/workflows/scan.yml`) scans and commits twice
daily; Netlify rebuilds the site on every push (`netlify.toml`).
