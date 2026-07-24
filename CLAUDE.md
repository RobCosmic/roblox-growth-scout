# Roblox Growth Scout

Daily acquisition radar for Roblox games. Twice-daily scans snapshot young games'
public stats, screen for sponsored (ad-driven) CCU, and build a static HTML report
for partners. Goal: surface games worth **acquiring** — organic growth, not ad spikes.

## Architecture

- **No dependencies, plain Node 20+** (global `fetch`). Three entry points:
  - `collector.js` — the scan. Sweeps public discovery charts + keyword searches,
    fetches per-game stats, screens for ad slots, appends one JSON line to
    `data/history.jsonl`. Run by GitHub Actions cron twice daily.
  - `report.js` — builds `site/index.html` from the full history (latest snapshot +
    deltas vs previous + sponsor ledger). Run by Netlify at build time.
  - `test/dry-run.js` — validates every history line parses and the report builds
    with expected markers. Run in CI and as the Netlify build gate.
- **`data/history.jsonl` is the database.** Append-only, committed by the cron job.
  Never rewrite old lines — deltas, sparklines and the sponsor ledger all derive
  from history. One line = one snapshot: `{ts, meta, sponsorSightings, games}`.
- **Flow:** Actions cron (13:00 & 01:00 UTC ≈ 6AM/6PM PT) → `collector.js` → commit
  `data/` → push → Netlify rebuilds (`netlify.toml`: dry-run + `report.js`) → site
  refreshes. Fixed hours keep CCU snapshots comparable — don't randomize them.
- `data/notes.json` (optional): analyst notes keyed by universeId, merged into
  candidate cards. This is where per-game diligence commentary lives.

## Scan criteria (the tuning surface — all knobs in `CFG` at top of collector.js)

- Acquisition band: **1,000–2,500 CCU**, game **under 30 days old**.
- Watch band: 400+ CCU approaching from below; young games above band tracked as
  "outgrew" comps.
- **Discovery = charts + keyword search, both load-bearing** (verified 2026-07-23:
  charts alone found 2 in-band games, charts+search found 7 — charts are shallow,
  ~34 games/sort, and miss young mid-CCU games). The `QUERIES` list in collector.js
  is the coverage knob; games matching no query and no chart stay invisible, so
  keep broad generic terms ("new", "update", "beta") alongside genre terms.
- Once a game has matched or been watched, it stays **tracked** for continuity
  (refetched every scan even if it falls off every chart) for `trackDaysAfterExit`
  days — growth curves must not have holes.

## Sponsorship screening (core requirement — user call 2026-07-23)

Sponsored placement can buy CCU into the band; it is **not** a buy signal. Roblox
serves ad fill only to authenticated sessions and publishes no campaign history, so:

- Every scan checks all chart tiles + keyword-search results for `isSponsored` /
  `nativeAdData` markers and logs hits to the snapshot's `sponsorSightings`.
- The report accumulates a **sighting ledger** per game: first seen / last seen /
  N of M scans sponsored. Duration is built by us, never queried.
- **Organic-signature heuristics** flag suspicious candidates from public data
  (≥2 signals ⇒ POSSIBLY AD-DRIVEN): no organic chart presence, like ratio < 85%,
  favorites/visit < 0.2%, favorites/visit > 5% (favorite-botting — healthy is
  ~1-2%; validated 2026-07-23: flagged obby-farm games ran 11-20%), and (with
  history) flat-then-cliff CCU decay.
- **Stay anonymous.** Do not put a logged-in Roblox session into CI — polite,
  unauthenticated public-API polling is the defensible posture. Keep the retry/
  backoff and inter-request delays; do not raise request rates casually.

## Working rules

1. Iterate, don't rewrite. The mechanics evolve by prompted edits; keep changes
   targeted and update this file when a mechanic/threshold changes deliberately.
2. After every change run `node test/dry-run.js` and confirm it passes.
3. Data compatibility: new snapshot fields are fine; renames/removals need a
   migration thought — old lines stay as written.
4. `report.js` must handle 1 snapshot (baseline, no deltas) and missing fields
   from older snapshots gracefully.
5. No revenue/DAU/retention exists publicly. Top Earning chart presence is the
   only revenue proxy; favorites/visit is the return-intent proxy. Real diligence
   needs the seller's analytics — the report should never imply otherwise.

## Commands

- Manual scan: `node collector.js` (~2-3 min, polite rate limits)
- Build report: `node report.js` → `site/index.html`
- Test: `node test/dry-run.js`
- Trigger a cloud scan now: GitHub → Actions → "scan" → Run workflow
