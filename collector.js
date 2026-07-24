#!/usr/bin/env node
// Roblox Growth Scout — collector. Sweeps public discovery charts + keyword
// searches, snapshots young-game stats, screens for sponsored ad slots, and
// appends one JSON line to data/history.jsonl. No dependencies (Node 20+).
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = {
  ccuMin: 1000, ccuMax: 2500,      // acquisition band
  watchCcuMin: 400,                // below-band watch floor
  maxAgeDays: 30,                  // "young" window
  trackDaysAfterExit: 14,          // keep refetching games after they leave the window
  sortPages: 6,                    // pagination depth per chart
  detailBatch: 50,                 // universeIds per games-API call (API max 100; stay modest)
  delayMs: { page: 250, detail: 700, votes: 400, search: 300 },
};

const SORTS = ['top-trending', 'up-and-coming', 'top-playing-now', 'fun-with-friends',
  'top-revisited', 'top-earning', 'top-rated', 'most-popular', 'trending-music-experiences',
  'trending-in-rpg', 'trending-in-sports-and-racing', 'trending-in-shooter',
  'trending-in-action', 'trending-in-adventure', 'trending-in-entertainment',
  'trending-in-obby-and-platformer', 'trending-in-party-and-casual', 'trending-in-puzzle',
  'trending-in-roleplay-and-avatar-sim', 'trending-in-shopping', 'trending-in-simulation',
  'trending-in-strategy', 'trending-in-survival'];

// Keyword sweeps are a full discovery channel AND the ad-slot screen. Charts are
// shallow (~34 games/sort) and miss young mid-CCU games entirely — verified
// 2026-07-23: search found 3.5x more in-band young games than charts alone. The
// query list is a coverage knob: widening it widens discovery. Games matching no
// query AND no chart remain invisible — keep generic terms in the list.
const QUERIES = ['simulator', 'tycoon', 'obby', 'anime', 'horror', 'rpg', 'clicker',
  'tower defense', 'soccer', 'pet', 'new', 'beta', 'update', 'fight', 'escape',
  'build', 'survive', 'race', 'merge', 'idle', 'draft', 'clean', 'find the',
  'capybara', 'brainrot', 'story', 'hide and seek', 'dungeon', 'card', 'football',
  'basketball', 'prison', 'school', 'hospital', 'restaurant', 'mining', 'fishing',
  'farm', 'steal', 'sword', 'magic', 'dress up', 'roleplay', 'parkour', 'puzzle',
  'zombie', 'boss'];

const HISTORY = path.join(__dirname, 'data', 'history.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(2500 * (t + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (t === tries - 1) throw e; await sleep(1500 * (t + 1)); }
  }
  throw new Error('rate-limited after retries: ' + url);
}

function loadHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Games seen in recent snapshots stay tracked so growth curves have no holes.
function trackedIds(history, now) {
  const cutoff = now - (CFG.maxAgeDays + CFG.trackDaysAfterExit) * 86400e3;
  const ids = new Set();
  for (const snap of history) {
    if (new Date(snap.ts).getTime() < cutoff) continue;
    for (const g of snap.games || []) ids.add(g.id);
  }
  return ids;
}

function adSighting(tile, surface) {
  return {
    universeId: tile.universeId, name: tile.name || null, surface,
    ccuAtSighting: tile.playerCount ?? null, ad: tile.nativeAdData ?? true,
  };
}

async function main() {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const session = 'scout-' + Math.floor(Math.random() * 1e9);
  const origin = {};          // universeId -> Set of chart sortIds (organic presence)
  const discovered = new Set();
  const sightings = [];

  // 1) Chart sweep — discovery + ad-slot screen
  for (const sortId of SORTS) {
    let token = null;
    for (let p = 0; p < CFG.sortPages; p++) {
      let url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${session}&sortId=${sortId}&device=computer&country=all`;
      if (token) url += '&pageToken=' + encodeURIComponent(token);
      let d;
      try { d = await getJSON(url); } catch (e) { console.error('sort fail', sortId, e.message); break; }
      const games = d.games || [];
      for (const g of games) {
        if (!g.universeId) continue;
        if (g.isSponsored || g.nativeAdData) { sightings.push(adSighting(g, 'chart:' + sortId)); continue; }
        discovered.add(g.universeId);
        (origin[g.universeId] = origin[g.universeId] || new Set()).add(sortId);
      }
      token = d.nextPageToken;
      if (!token || !games.length) break;
      await sleep(CFG.delayMs.page);
    }
    await sleep(CFG.delayMs.page);
  }
  console.error(`charts: ${discovered.size} organic universes, ${sightings.length} ad slots`);

  // 2) Keyword sweep — discovery + ad-slot screen on search surfaces
  const searchOrigin = {}; // universeId -> Set of queries (search presence ≠ chart presence)
  for (const q of QUERIES) {
    try {
      const d = await getJSON(`https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&pageType=all&sessionId=${session}`);
      for (const grp of d.searchResults || [])
        for (const c of grp.contents || []) {
          if (!c.universeId) continue;
          if (c.isSponsored || c.nativeAdData) { sightings.push(adSighting(c, 'search:' + q)); continue; }
          discovered.add(c.universeId);
          (searchOrigin[c.universeId] = searchOrigin[c.universeId] || new Set()).add(q);
        }
    } catch (e) { console.error('search fail', q, e.message); }
    await sleep(CFG.delayMs.search);
  }
  console.error(`search: ${Object.keys(searchOrigin).length} universes across ${QUERIES.length} queries`);

  // 3) Details for discovered ∪ tracked
  const history = loadHistory();
  const tracked = trackedIds(history, now);
  const ids = [...new Set([...discovered, ...tracked])];
  const all = [];
  const failedChunks = [];
  for (let i = 0; i < ids.length; i += CFG.detailBatch) {
    const chunk = ids.slice(i, i + CFG.detailBatch);
    try {
      const d = await getJSON('https://games.roblox.com/v1/games?universeIds=' + chunk.join(','));
      all.push(...(d.data || []));
    } catch (e) { console.error('detail batch fail at', i, e.message); failedChunks.push(chunk); }
    await sleep(CFG.delayMs.detail);
  }
  // Second pass: rate-limited chunks get one more shot after a long cooldown so
  // an unattended cron run doesn't silently drop games.
  if (failedChunks.length) {
    console.error(`cooling down 45s, retrying ${failedChunks.length} failed batch(es)`);
    await sleep(45000);
    for (const chunk of failedChunks) {
      try {
        const d = await getJSON('https://games.roblox.com/v1/games?universeIds=' + chunk.join(','), 5);
        all.push(...(d.data || []));
      } catch (e) { console.error('retry batch still failing', e.message); }
      await sleep(CFG.delayMs.detail * 3);
    }
  }
  console.error(`details: ${all.length}/${ids.length}`);

  // 4) Keep what the report needs: young games, tracked games, ad-sighted games
  const ageDays = g => (now - new Date(g.created).getTime()) / 86400e3;
  const sightedIds = new Set(sightings.map(s => s.universeId));
  const keep = all.filter(g => {
    const a = ageDays(g);
    return (a >= 0 && a <= CFG.maxAgeDays && g.playing >= 1) || tracked.has(g.id) || sightedIds.has(g.id);
  });

  // 5) Votes for kept games
  for (let i = 0; i < keep.length; i += CFG.detailBatch) {
    const chunk = keep.slice(i, i + CFG.detailBatch);
    try {
      const d = await getJSON('https://games.roblox.com/v1/games/votes?universeIds=' + chunk.map(g => g.id).join(','));
      for (const v of d.data || []) {
        const m = chunk.find(g => g.id === v.id);
        if (m) { m.upVotes = v.upVotes; m.downVotes = v.downVotes; }
      }
    } catch (e) { console.error('votes fail', e.message); }
    await sleep(CFG.delayMs.votes);
  }

  const snapshot = {
    ts,
    meta: {
      discovered: discovered.size, tracked: tracked.size, detailed: all.length,
      kept: keep.length, sortsSwept: SORTS.length, queriesSwept: QUERIES.length,
      cfg: { ccuMin: CFG.ccuMin, ccuMax: CFG.ccuMax, maxAgeDays: CFG.maxAgeDays },
    },
    sponsorSightings: sightings,
    games: keep.map(g => ({
      id: g.id, place: g.rootPlaceId, name: g.name,
      creator: g.creator ? { name: g.creator.name, type: g.creator.type, verified: g.creator.hasVerifiedBadge } : null,
      genre: g.genre_l1 || g.genre || null, created: g.created,
      ccu: g.playing, visits: g.visits, favs: g.favoritedCount,
      up: g.upVotes ?? null, down: g.downVotes ?? null,
      sorts: [...(origin[g.id] || [])],
      srch: [...(searchOrigin[g.id] || [])].slice(0, 5),
    })).sort((a, b) => b.ccu - a.ccu),
  };

  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(snapshot) + '\n');
  const inBand = snapshot.games.filter(g => g.ccu >= CFG.ccuMin && g.ccu <= CFG.ccuMax && ageDays({ created: g.created }) <= CFG.maxAgeDays).length;
  console.error(`snapshot ${ts}: kept ${keep.length} games (${inBand} in band), ${sightings.length} sponsored sightings`);
}

main().catch(e => { console.error(e); process.exit(1); });
