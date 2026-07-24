#!/usr/bin/env node
// Dry run: every history line must parse with required fields, and the report
// must build and contain its structural markers. Exits non-zero on any failure.
// This gates both the Netlify deploy and the Actions scan commit.
'use strict';
const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (ok, msg) => { if (!ok) { console.error('FAIL:', msg); fails++; } };

const HISTORY = path.join(__dirname, '..', 'data', 'history.jsonl');
check(fs.existsSync(HISTORY), 'data/history.jsonl missing');

if (fs.existsSync(HISTORY)) {
  const lines = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
  check(lines.length >= 1, 'history is empty');
  lines.forEach((l, i) => {
    let s;
    try { s = JSON.parse(l); } catch (e) { return check(false, `line ${i + 1} unparseable`); }
    check(typeof s.ts === 'string' && !isNaN(new Date(s.ts)), `line ${i + 1}: bad ts`);
    check(Array.isArray(s.games), `line ${i + 1}: games not an array`);
    check(Array.isArray(s.sponsorSightings), `line ${i + 1}: sponsorSightings not an array`);
    for (const g of s.games || []) {
      check(typeof g.id === 'number' && typeof g.ccu === 'number' && g.created, `line ${i + 1}: malformed game ${g && g.id}`);
      if (fails > 20) break;
    }
  });
  // ts must be monotonically increasing (append-only discipline)
  const ts = lines.map(l => new Date(JSON.parse(l).ts).getTime());
  for (let i = 1; i < ts.length; i++) check(ts[i] >= ts[i - 1], `snapshots out of order at line ${i + 1}`);
}

if (!fails) {
  const { build } = require('../report.js');
  try {
    const r = build();
    const html = fs.readFileSync(r.out, 'utf8');
    for (const marker of ['Roblox acquisition radar', 'Sponsorship ledger', 'in CCU band', 'Method'])
      check(html.includes(marker), `report missing marker: ${marker}`);
    check(html.length > 5000, 'report suspiciously small');
    console.error(`report built: scan ${r.snaps}, ${r.inBand} in band, ledger ${r.ledger}`);
  } catch (e) { check(false, 'report build threw: ' + e.message); }
}

if (fails) { console.error(`dry-run: ${fails} failure(s)`); process.exit(1); }
console.error('dry-run: OK');
