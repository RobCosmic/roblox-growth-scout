#!/usr/bin/env node
// Roblox Growth Scout — report builder. Reads data/history.jsonl, computes
// deltas/series/sponsor-ledger, writes site/index.html. Must handle a single
// baseline snapshot (no deltas) and missing fields in old lines gracefully.
'use strict';
const fs = require('fs');
const path = require('path');

const HISTORY = path.join(__dirname, 'data', 'history.jsonl');
const NOTES = path.join(__dirname, 'data', 'notes.json');
const OUT = path.join(__dirname, 'site', 'index.html');

function loadHistory() {
  if (!fs.existsSync(HISTORY)) throw new Error('no data/history.jsonl — run collector.js first');
  return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => n == null ? '—' : n.toLocaleString('en-US');
const compact = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : num(n);
const pct = (a, b) => (b ? (a / b * 100) : null);

function sparkline(series, w = 120, h = 28) {
  const vals = series.map(p => p.ccu).filter(v => v != null);
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - (v - min) / span * (h - 8)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="CCU trend">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="var(--accent)"/></svg>`;
}

function deltaChip(cur, prev, gapH) {
  if (prev == null || cur == null) return '<span class="delta">Δ — baseline</span>';
  const d = cur - prev;
  const cls = d > 0 ? 'dup' : d < 0 ? 'ddown' : '';
  const sign = d > 0 ? '+' : '';
  return `<span class="delta ${cls}">Δ ${sign}${compact(d)} / ${gapH}h</span>`;
}

function build() {
  const snaps = loadHistory();
  const latest = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const gapH = prev ? Math.max(1, Math.round((new Date(latest.ts) - new Date(prev.ts)) / 36e5)) : null;
  const notes = fs.existsSync(NOTES) ? JSON.parse(fs.readFileSync(NOTES, 'utf8')) : {};
  const cfg = (latest.meta && latest.meta.cfg) || { ccuMin: 1000, ccuMax: 2500, maxAgeDays: 30 };
  const nowT = new Date(latest.ts).getTime();

  const prevById = new Map((prev ? prev.games || [] : []).map(g => [g.id, g]));
  const series = new Map();
  for (const s of snaps) for (const g of s.games || []) {
    if (!series.has(g.id)) series.set(g.id, []);
    series.get(g.id).push({ ts: s.ts, ccu: g.ccu, visits: g.visits });
  }

  // Sponsor ledger across all snapshots
  const ledger = new Map(); // id -> {first, last, count, surfaces:Set}
  for (const s of snaps) for (const sg of s.sponsorSightings || []) {
    const e = ledger.get(sg.universeId) || { first: s.ts, last: s.ts, count: 0, surfaces: new Set(), name: sg.name };
    e.last = s.ts; e.count++; if (sg.surface) e.surfaces.add(sg.surface.split(':')[0]);
    ledger.set(sg.universeId, e);
  }

  const age = g => (nowT - new Date(g.created).getTime()) / 86400e3;
  const young = (latest.games || []).filter(g => age(g) >= 0 && age(g) <= cfg.maxAgeDays);
  const inBand = young.filter(g => g.ccu >= cfg.ccuMin && g.ccu <= cfg.ccuMax);
  const below = young.filter(g => g.ccu >= 400 && g.ccu < cfg.ccuMin).sort((a, b) => b.ccu - a.ccu);
  const outgrew = young.filter(g => g.ccu > cfg.ccuMax).sort((a, b) => b.ccu - a.ccu);
  const faded = young.filter(g => g.ccu < 400).sort((a, b) => b.ccu - a.ccu);

  function sponsorStatus(g) {
    const led = ledger.get(g.id);
    if (led) {
      const d1 = led.first.slice(0, 10), d2 = led.last.slice(0, 10);
      return { cls: 'flagchip', label: `SPONSORED ${led.count}/${snaps.length} scans`, detail: `Ad slots sighted ${led.count} of ${snaps.length} scans (${d1} → ${d2}) on ${[...led.surfaces].join('+')}. Treat CCU in that span as partly paid.` };
    }
    const likeP = pct(g.up, (g.up ?? 0) + (g.down ?? 0));
    const favP = pct(g.favs, g.visits);
    const suspicious = [];
    if (!(g.sorts || []).length) suspicious.push((g.srch || []).length ? 'search-discovered, no chart presence' : 'no organic chart or search presence');
    if (likeP != null && likeP < 85) suspicious.push(`like ratio ${likeP.toFixed(0)}%`);
    if (favP != null && favP < 0.2) suspicious.push(`fav/visit ${favP.toFixed(2)}%`);
    if (suspicious.length >= 2) return { cls: 'flagchip', label: 'POSSIBLY AD-DRIVEN', detail: 'Heuristic flags: ' + suspicious.join('; ') + '. No ad slot directly sighted (anonymous scans see little ad fill).' };
    const found = (g.sorts || []).length ? 'charted: ' + g.sorts.join(', ') : (g.srch || []).length ? 'via search ("' + g.srch[0] + '")' : 'uncharted';
    return { cls: 'band', label: 'SPONSOR: none detected', detail: `No ad slot sighted in ${snaps.length} scan${snaps.length > 1 ? 's' : ''}; organic signature (${found}${likeP != null ? `, ${likeP.toFixed(1)}% likes` : ''}${favP != null ? `, ${favP.toFixed(2)}% fav/visit` : ''}).` };
  }

  function card(g) {
    const p = prevById.get(g.id);
    const likeP = pct(g.up, (g.up ?? 0) + (g.down ?? 0));
    const favP = pct(g.favs, g.visits);
    const vpd = g.visits / Math.max(0.1, age(g));
    const sp = sponsorStatus(g);
    const note = notes[g.id];
    return `<div class="card">
    <div class="head">
      <a href="https://www.roblox.com/games/${g.place}" target="_blank" rel="noopener">${esc(g.name)}</a>
      <span class="chip band">IN BAND</span>
      ${g.genre ? `<span class="chip">${esc(g.genre)}</span>` : ''}
      ${g.creator ? `<span class="chip">${esc(g.creator.name)}${g.creator.type === 'Group' ? ' (group)' : ''}</span>` : ''}
      <span class="chip">${age(g).toFixed(1)} days old</span>
      <span class="chip ${sp.cls}">${esc(sp.label)}</span>
      ${sparkline(series.get(g.id) || [])}
    </div>
    <div class="metrics">
      <div class="metric"><b>${num(g.ccu)}</b><span>CCU now</span>${deltaChip(g.ccu, p && p.ccu, gapH)}</div>
      <div class="metric"><b>${compact(g.visits)}</b><span>visits</span>${deltaChip(g.visits, p && p.visits, gapH)}</div>
      <div class="metric"><b>≈${compact(Math.round(vpd))}</b><span>visits / day</span><span class="delta">lifetime avg</span></div>
      <div class="metric"><b>${num(g.favs)}</b><span>favorites</span><span class="delta">${favP != null ? favP.toFixed(2) + '% of visits' : ''}</span></div>
      <div class="metric"><b>${likeP != null ? likeP.toFixed(1) + '%' : '—'}</b><span>like ratio</span><span class="delta">${g.up != null ? num(g.up) + ' ▲ / ' + num(g.down) + ' ▼' : ''}</span></div>
    </div>
    <ul class="notes">
      <li><b>Sponsor read:</b> ${esc(sp.detail)}</li>
      ${(g.sorts || []).includes('top-earning') ? '<li><span class="plus">Signal:</span> on the Top Earning chart — the only public revenue proxy.</li>' : ''}
      ${(g.sorts || []).includes('up-and-coming') ? '<li><span class="plus">Signal:</span> charted on Up-and-Coming.</li>' : ''}
      ${note ? `<li><b>Analyst note:</b> ${esc(note)}</li>` : ''}
    </ul>
  </div>`;
  }

  function row(g, extra) {
    const p = prevById.get(g.id);
    const led = ledger.get(g.id);
    const spCell = led ? `<td class="down">ad ×${led.count}</td>` : '<td>—</td>';
    return `<tr><td>${esc(g.name)}</td><td class="num">${num(g.ccu)}</td>` +
      `<td class="num">${p ? (g.ccu - p.ccu > 0 ? '<span class="up">+' : '<span class="down">') + num(g.ccu - p.ccu) + '</span>' : '—'}</td>` +
      `<td class="num">${age(g).toFixed(1)}</td><td class="num">${compact(g.visits)}</td>${spCell}${extra || ''}</tr>`;
  }

  const sightingRows = [...ledger.entries()].map(([id, e]) =>
    `<tr><td>${esc(e.name || id)}</td><td>${[...e.surfaces].join(', ')}</td><td class="num">${e.count} / ${snaps.length}</td><td>${e.first.slice(0, 10)}</td><td>${e.last.slice(0, 10)}</td></tr>`).join('\n');

  const updated = new Date(latest.ts).toUTCString().replace(':00 GMT', ' UTC');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Roblox Growth Scout</title>
<style>
  :root{--bg:#f6f7f5;--panel:#fff;--ink:#1c2420;--muted:#5c6a63;--line:#dde3df;--accent:#1e6f5c;--good:#1d7a3e;--bad:#b3392e;--warn:#8a6a1f;--chip:#eef1ee;--band:#e7efec}
  @media (prefers-color-scheme:dark){:root{--bg:#141917;--panel:#1c2320;--ink:#e6ece8;--muted:#93a29a;--line:#2c3630;--accent:#4fae93;--good:#5cc27d;--bad:#e0766c;--warn:#d0b05c;--chip:#242d29;--band:#20302a}}
  html{background:var(--bg)}
  body{font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:2.2rem 1.2rem 4rem;line-height:1.55}
  .wrap{max-width:880px;margin:0 auto}
  .eyebrow{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
  h1{font-size:1.7rem;margin:.15rem 0 .2rem;text-wrap:balance;font-weight:700}
  .sub{color:var(--muted);font-size:.92rem;margin:0 0 1.6rem}
  h2{font-size:1.05rem;margin:2.2rem 0 .7rem;font-weight:700}
  h2 .count{color:var(--muted);font-weight:500}
  .summary{display:flex;flex-wrap:wrap;gap:.6rem}
  .stat{flex:1 1 130px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.65rem .8rem}
  .stat b{display:block;font-size:1.25rem;font-weight:600;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
  .stat span{font-size:.74rem;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin:.8rem 0}
  .card .head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem}
  .card .head a{color:var(--ink);font-weight:700;font-size:1.06rem;text-decoration:none;border-bottom:1px solid var(--accent)}
  .chip{font-size:.7rem;background:var(--chip);border-radius:999px;padding:.15rem .55rem;color:var(--muted);white-space:nowrap}
  .chip.band{background:var(--band);color:var(--accent);font-weight:600}
  .chip.flagchip{background:var(--band);color:var(--warn);font-weight:700}
  .spark{margin-left:auto}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:.5rem;margin:.8rem 0 .6rem}
  .metric{border:1px solid var(--line);border-radius:7px;padding:.45rem .6rem}
  .metric b{display:block;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums;font-size:1rem;font-weight:600}
  .metric span{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  .delta{display:block;font-size:.72rem;color:var(--muted);text-transform:none;letter-spacing:0}
  .delta.dup{color:var(--good)} .delta.ddown{color:var(--bad)}
  .notes{margin:.4rem 0 0;padding-left:1.1rem;font-size:.88rem}
  .notes li{margin:.2rem 0}
  .plus{color:var(--good);font-weight:600} .flag{color:var(--warn);font-weight:600}
  .tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
  table{border-collapse:collapse;width:100%;font-size:.86rem}
  th{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;font-weight:600}
  th,td{padding:.5rem .75rem;border-bottom:1px solid var(--line);white-space:nowrap}
  tr:last-child td{border-bottom:none}
  td.num,th.num{text-align:right;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
  .up{color:var(--good)} .down{color:var(--bad)}
  .method{font-size:.86rem;color:var(--muted)} .method p{margin:.45rem 0} .method strong{color:var(--ink)}
  a{color:var(--accent)}
</style></head><body>
<div class="wrap">
  <div class="eyebrow">Growth Scout · scan ${snaps.length} · updated ${esc(updated)}</div>
  <h1>Roblox acquisition radar</h1>
  <p class="sub">Criteria: <b>${num(cfg.ccuMin)}–${num(cfg.ccuMax)} concurrent players</b> · <b>under ${cfg.maxAgeDays} days old</b>. ${prev ? `Deltas vs previous scan (${gapH}h earlier).` : 'Baseline scan — deltas start next run.'}</p>
  <div class="summary">
    <div class="stat"><b>${num(latest.meta ? latest.meta.detailed : (latest.games || []).length)}</b><span>games scanned</span></div>
    <div class="stat"><b>${young.length}</b><span>under ${cfg.maxAgeDays} days</span></div>
    <div class="stat"><b>${inBand.length}</b><span>in CCU band</span></div>
    <div class="stat"><b>${below.length}</b><span>below band</span></div>
    <div class="stat"><b>${outgrew.length}</b><span>outgrew band</span></div>
    <div class="stat"><b>${(latest.sponsorSightings || []).length}</b><span>ad slots this scan</span></div>
  </div>

  <h2>In-band candidates <span class="count">· ${inBand.length}</span></h2>
  ${inBand.length ? inBand.map(card).join('\n') : '<p class="method">No games in the band this scan — see the approach list below.</p>'}

  <h2>Approaching from below <span class="count">· 400+ CCU, may qualify soon</span></h2>
  <div class="tblwrap"><table>
    <tr><th>Game</th><th class="num">CCU</th><th class="num">Δ CCU</th><th class="num">Age (d)</th><th class="num">Visits</th><th>Sponsor</th></tr>
    ${below.map(g => row(g)).join('\n') || '<tr><td colspan="6">None this scan.</td></tr>'}
  </table></div>

  <h2>Outgrew the band <span class="count">· young breakouts, tracked as comps</span></h2>
  <div class="tblwrap"><table>
    <tr><th>Game</th><th class="num">CCU</th><th class="num">Δ CCU</th><th class="num">Age (d)</th><th class="num">Visits</th><th>Sponsor</th></tr>
    ${outgrew.slice(0, 12).map(g => row(g)).join('\n') || '<tr><td colspan="6">None this scan.</td></tr>'}
  </table></div>
  ${outgrew.length > 12 ? `<p class="method">Showing top 12 of ${outgrew.length}.</p>` : ''}

  ${faded.length ? `<h2>Fading / sub-400 <span class="count">· still tracked</span></h2>
  <div class="tblwrap"><table>
    <tr><th>Game</th><th class="num">CCU</th><th class="num">Δ CCU</th><th class="num">Age (d)</th><th class="num">Visits</th><th>Sponsor</th></tr>
    ${faded.map(g => row(g)).join('\n')}
  </table></div>` : ''}

  <h2>Sponsorship ledger <span class="count">· all ad-slot sightings, all scans</span></h2>
  ${ledger.size ? `<div class="tblwrap"><table>
    <tr><th>Game</th><th>Surfaces</th><th class="num">Scans sighted</th><th>First seen</th><th>Last seen</th></tr>
    ${sightingRows}
  </table></div>` : `<p class="method">No sponsored slots sighted in ${snaps.length} scan${snaps.length > 1 ? 's' : ''}. Anonymous scans receive little ad fill — the ledger accumulates any that do appear; heuristic screening (chart presence, like ratio, fav/visit, decay shape) covers the rest and is reported per candidate above.</p>`}

  <h2>Method</h2>
  <div class="method">
    <p><strong>Scans run twice daily at fixed hours</strong> (~6 AM / 6 PM PT) so CCU snapshots compare cleanly. Sources: ${(latest.meta && latest.meta.sortsSwept) || 23} public discovery charts + ${(latest.meta && latest.meta.queriesSwept) || 10} keyword sweeps; per-game stats and votes from the public games API. Once a game is spotted it stays tracked even after it falls off every chart.</p>
    <p><strong>Sponsored CCU is not growth.</strong> Every tile is checked for Roblox's ad markers; sightings accumulate in the ledger above (Roblox publishes no campaign history — duration is built from our scans). Candidates with no organic explanation for their CCU are flagged POSSIBLY AD-DRIVEN.</p>
    <p><strong>Public data only:</strong> revenue, DAU and retention are not exposed. Top Earning chart presence is the closest revenue proxy; favorites-per-visit proxies return intent. Real diligence needs the seller's analytics.</p>
  </div>
</div>
</body></html>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  return { snaps: snaps.length, inBand: inBand.length, below: below.length, outgrew: outgrew.length, ledger: ledger.size, out: OUT };
}

if (require.main === module) {
  const r = build();
  console.error(`report: scan ${r.snaps} → ${r.inBand} in band, ${r.below} below, ${r.outgrew} outgrew, ledger ${r.ledger} → ${r.out}`);
}
module.exports = { build };
