/* Lock-in distribution model for Patio Boys.
   Smash samples prefer full-season ESPN box scores (nba-gamelogs-snapshot.js),
   scored live under league settings. Falls back to Sleeper fantasy-week rows
   when the snapshot is missing a season. Lock-in weeks sum 10 chosen game
   scores into starter spots, so per-game μ / σ / hit-rates are the unit. */
(function(global){
  'use strict';

  const DEFAULT_MARKS = [30, 40, 50];
  const LOCK_SLOTS = 10;
  const GAMELOG_FIELDS = ['pts', 'reb', 'oreb', 'ast', 'stl', 'blk', 'to', 'fgmi', 'ftmi', 'tpm', 'min'];

  /* Abramowitz & Stegun normal CDF (good enough for hit-rate display). */
  function normalCdf(z){
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    const abs = Math.abs(z);
    const t = 1 / (1 + 0.2316419 * abs);
    const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
    const p = d * t * (0.319381530
      + t * (-0.356563782
      + t * (1.781477937
      + t * (-1.821255978
      + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  }

  function normalHitRate(mean, stdev, mark){
    if (!Number.isFinite(mean)) return 0;
    if (!(stdev > 1e-9)) return mean >= mark ? 1 : 0;
    return 1 - normalCdf((mark - mean) / stdev);
  }

  function empiricalHitRate(samples, mark){
    const arr = samples || [];
    if (!arr.length) return 0;
    let hits = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] >= mark) hits++;
    return hits / arr.length;
  }

  /* Score one counting-stat row under league settings.
     Applies 40/50-pt bonuses, 3PM, and dd/td when those derived fields are omitted.
     If the row includes gp (season totals), returns FP per game. */
  function scoreGame(obj, scoring){
    if (!obj || !scoring) return null;
    const row = Object.assign({}, obj);

    const pts = Number(row.pts);
    const reb = Number(row.reb);
    const ast = Number(row.ast);
    const stl = Number(row.stl);
    const blk = Number(row.blk);
    if (scoring.dd != null && row.dd == null){
      const cats = [pts, reb, ast, stl, blk].filter(v => Number.isFinite(v) && v >= 10).length;
      if (cats >= 2) row.dd = 1;
    }
    if (scoring.td != null && row.td == null){
      const cats = [pts, reb, ast, stl, blk].filter(v => Number.isFinite(v) && v >= 10).length;
      if (cats >= 3) row.td = 1;
    }

    const keys = Object.keys(scoring);
    let total = 0;
    let matched = 0;
    keys.forEach(k => {
      if (row[k] != null){
        total += Number(row[k]) * Number(scoring[k]);
        matched++;
      }
    });

    if (scoring.bonus_pt_40p != null && row.bonus_pt_40p == null && Number.isFinite(pts) && pts >= 40){
      total += Number(scoring.bonus_pt_40p);
      matched++;
    }
    if (scoring.bonus_pt_50p != null && row.bonus_pt_50p == null && Number.isFinite(pts) && pts >= 50){
      total += Number(scoring.bonus_pt_50p);
      matched++;
    }
    if (scoring.tpm != null && row.tpm == null){
      let tpm = row.fg3m;
      if (tpm == null && row.tpa != null && row.tpmi != null) tpm = Number(row.tpa) - Number(row.tpmi);
      if (tpm != null){
        total += Number(tpm) * Number(scoring.tpm);
        matched++;
      }
    }

    if (matched === 0) return null;
    const gp = Number(row.gp || row.games_played || 0);
    return gp > 0 ? total / gp : total;
  }

  function gamelogSnapshot(){
    return (typeof global !== 'undefined' && global.NBA_GAMELOGS) ||
      (typeof window !== 'undefined' && window.NBA_GAMELOGS) ||
      null;
  }

  function parentGamelogHost(){
    try {
      if (typeof window === 'undefined') return null;
      if (window.top && window.top !== window) return window.top;
    } catch (e) { /* cross-origin */ }
    return typeof window !== 'undefined' ? window : null;
  }

  function yieldToMain(){
    if (global.PatioBoysShare && typeof global.PatioBoysShare.yieldToMain === 'function'){
      return global.PatioBoysShare.yieldToMain();
    }
    if (global.scheduler && typeof global.scheduler.yield === 'function'){
      return global.scheduler.yield();
    }
    return new Promise(function(resolve){ setTimeout(resolve, 0); });
  }

  /* Serialize gamelog parse + Lock scoring across same-origin HQ iframes.
     Re-entrant: nested calls from the same heavy job run immediately. */
  function withHeavyLock(fn){
    const host = parentGamelogHost() || global;
    if ((host.__PB_HEAVY_DEPTH || 0) > 0){
      return Promise.resolve().then(fn);
    }
    const prev = host.__PB_HEAVY || Promise.resolve();
    let release;
    const gate = new Promise(function(r){ release = r; });
    host.__PB_HEAVY = prev.then(function(){ return gate; }).catch(function(){});
    return prev.then(async function(){
      host.__PB_HEAVY_DEPTH = (host.__PB_HEAVY_DEPTH || 0) + 1;
      try { return await fn(); }
      finally {
        host.__PB_HEAVY_DEPTH = Math.max(0, (host.__PB_HEAVY_DEPTH || 1) - 1);
        release();
      }
    });
  }

  /* Lazy-load the ~1.4MB ESPN box-score snapshot so HQ tabs stay responsive.
     Fetch as text + JSON.parse (with yields) instead of <script> eval, which
     freezes the shared parent main thread for hundreds of ms.
     Same-origin HQ iframes share one parse via window.top.NBA_GAMELOGS. */
  let _gamelogLoading = null;
  function parseGamelogScriptText(text){
    const raw = String(text || '');
    const eq = raw.indexOf('=');
    if (eq < 0) throw new Error('nba-gamelogs-snapshot.js: missing assignment');
    let jsonText = raw.slice(eq + 1).trim();
    if (jsonText.charAt(jsonText.length - 1) === ';'){
      jsonText = jsonText.slice(0, -1).trim();
    }
    return JSON.parse(jsonText);
  }
  function ensureGamelogsLoaded(opts){
    const existing = gamelogSnapshot();
    if (existing) return Promise.resolve(existing);
    const host = parentGamelogHost();
    if (host && host.NBA_GAMELOGS){
      if (typeof window !== 'undefined') window.NBA_GAMELOGS = host.NBA_GAMELOGS;
      return Promise.resolve(host.NBA_GAMELOGS);
    }
    if (host && host.__PB_GAMELOG_LOADING){
      return host.__PB_GAMELOG_LOADING.then(snap => {
        if (typeof window !== 'undefined' && snap) window.NBA_GAMELOGS = snap;
        return snap;
      });
    }
    if (_gamelogLoading) return _gamelogLoading;
    const options = opts || {};
    let bust = options.cacheBust;
    if (bust == null && typeof location !== 'undefined'){
      try { bust = new URLSearchParams(location.search).get('nocache') || '20260809-uiresp2'; }
      catch (e) { bust = '20260809-uiresp2'; }
    }
    const src = options.scriptUrl || 'nba-gamelogs-snapshot.js';
    const url = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(bust || '1');
    const loadPromise = withHeavyLock(async function(){
      if (gamelogSnapshot()) return gamelogSnapshot();
      if (host && host.NBA_GAMELOGS){
        if (typeof window !== 'undefined') window.NBA_GAMELOGS = host.NBA_GAMELOGS;
        return host.NBA_GAMELOGS;
      }
      await yieldToMain();
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load ' + url + ' (HTTP ' + res.status + ')');
      const text = await res.text();
      await yieldToMain();
      const snap = parseGamelogScriptText(text);
      await yieldToMain();
      if (host) host.NBA_GAMELOGS = snap;
      if (typeof window !== 'undefined') window.NBA_GAMELOGS = snap;
      if (typeof global !== 'undefined') global.NBA_GAMELOGS = snap;
      return snap;
    }).then(function(snap){
      _gamelogLoading = null;
      if (host && host.__PB_GAMELOG_LOADING === loadPromise) host.__PB_GAMELOG_LOADING = null;
      return snap;
    }).catch(function(err){
      _gamelogLoading = null;
      if (host && host.__PB_GAMELOG_LOADING === loadPromise) host.__PB_GAMELOG_LOADING = null;
      throw err;
    });
    _gamelogLoading = loadPromise;
    if (host) host.__PB_GAMELOG_LOADING = loadPromise;
    return loadPromise;
  }

  /* Expand one compact box-score row ([pts,reb,...]) into a scoring object. */
  function rowFromGamelogFields(row, fields){
    const cols = fields && fields.length ? fields : GAMELOG_FIELDS;
    if (!row || !row.length) return null;
    const obj = {};
    for (let i = 0; i < cols.length; i++){
      if (row[i] == null) continue;
      obj[cols[i]] = Number(row[i]);
    }
    return obj;
  }

  /* Score every ESPN box-score line for a Sleeper season year.
     Returns {samplesByPlayer, per30ByPlayer, per36ByPlayer, mpgByPlayer, fpPerMinByPlayer}
     where per30/per36 are total FP / total min × 30/36, mpg is total min / games,
     and fpPerMin is total FP / total min. */
  function scoreGamelogPlayer(games, fields, scoring){
    const scored = [];
    let fpSum = 0;
    let minSum = 0;
    for (let i = 0; i < (games || []).length; i++){
      const obj = rowFromGamelogFields(games[i], fields);
      const v = scoreGame(obj, scoring);
      if (v == null || !Number.isFinite(v)) continue;
      scored.push(v);
      fpSum += v;
      const mins = obj && Number(obj.min);
      if (Number.isFinite(mins) && mins > 0) minSum += mins;
    }
    if (!scored.length) return null;
    const out = {scored, fpSum, minSum};
    if (minSum > 0){
      const rate = fpSum / minSum;
      out.fpPerMin = rate;
      out.per30 = rate * 30;
      out.per36 = rate * 36;
      out.mpg = minSum / scored.length;
    }
    return out;
  }

  function buildSamplesFromGamelogs(statsSeason, scoring){
    const snap = gamelogSnapshot();
    if (!snap || !snap.seasons) return null;
    const seasonKey = String(statsSeason);
    const byPid = snap.seasons[seasonKey];
    if (!byPid) return null;
    const fields = snap.fields || GAMELOG_FIELDS;
    const samplesByPlayer = {};
    const per30ByPlayer = {};
    const per36ByPlayer = {};
    const mpgByPlayer = {};
    const fpPerMinByPlayer = {};
    Object.keys(byPid).forEach(pid => {
      const packed = scoreGamelogPlayer(byPid[pid], fields, scoring);
      if (!packed) return;
      samplesByPlayer[pid] = packed.scored;
      if (packed.fpPerMin != null){
        fpPerMinByPlayer[pid] = packed.fpPerMin;
        per30ByPlayer[pid] = packed.per30;
        per36ByPlayer[pid] = packed.per36;
        mpgByPlayer[pid] = packed.mpg;
      }
    });
    return {samplesByPlayer, per30ByPlayer, per36ByPlayer, mpgByPlayer, fpPerMinByPlayer};
  }

  /* Chunked scoring so HQ tab clicks can paint between batches. */
  async function buildSamplesFromGamelogsAsync(statsSeason, scoring, opts){
    const options = opts || {};
    const chunk = Math.max(20, Number(options.chunk) || 40);
    const snap = gamelogSnapshot();
    if (!snap || !snap.seasons) return null;
    const seasonKey = String(statsSeason);
    const byPid = snap.seasons[seasonKey];
    if (!byPid) return null;
    const fields = snap.fields || GAMELOG_FIELDS;
    const pids = Object.keys(byPid);
    const samplesByPlayer = {};
    const per30ByPlayer = {};
    const per36ByPlayer = {};
    const mpgByPlayer = {};
    const fpPerMinByPlayer = {};
    for (let i = 0; i < pids.length; i++){
      const pid = pids[i];
      const packed = scoreGamelogPlayer(byPid[pid], fields, scoring);
      if (packed){
        samplesByPlayer[pid] = packed.scored;
        if (packed.fpPerMin != null){
          fpPerMinByPlayer[pid] = packed.fpPerMin;
          per30ByPlayer[pid] = packed.per30;
          per36ByPlayer[pid] = packed.per36;
          mpgByPlayer[pid] = packed.mpg;
        }
      }
      if ((i + 1) % chunk === 0) await yieldToMain();
    }
    return {samplesByPlayer, per30ByPlayer, per36ByPlayer, mpgByPlayer, fpPerMinByPlayer};
  }

  /* Full-season FP/G from Sleeper season totals (matches Sleeper app averages). */
  function buildSeasonAvgMap(seasonStats, scoring){
    const out = {};
    Object.keys(seasonStats || {}).forEach(pid => {
      if (String(pid).indexOf('TEAM_') === 0) return;
      const row = seasonStats[pid];
      const gp = Number(row && (row.gp || row.games_played) || 0);
      if (!(gp > 0)) return;
      const avg = scoreGame(row, scoring);
      if (avg == null || !Number.isFinite(avg)) return;
      out[pid] = {avg, gp};
    });
    return out;
  }

  function buildSamplesByPlayer(weeklyResults, scoring){
    const byPid = {};
    (weeklyResults || []).forEach(wk => {
      if (!wk) return;
      Object.keys(wk).forEach(pid => {
        if (String(pid).indexOf('TEAM_') === 0) return;
        const v = scoreGame(wk[pid], scoring);
        if (v == null || !Number.isFinite(v)) return;
        (byPid[pid] || (byPid[pid] = [])).push(v);
      });
    });
    return byPid;
  }

  function playerDist(samples, marks, seasonInfo){
    const arr = (samples || []).filter(v => Number.isFinite(v));
    const markList = marks || DEFAULT_MARKS;
    if (!arr.length) return null;
    const n = arr.length;
    const sampleMean = arr.reduce((s, v) => s + v, 0) / n;
    const variance = arr.reduce((s, v) => s + Math.pow(v - sampleMean, 2), 0) / n;
    const stdev = Math.sqrt(variance);
    /* Prefer full-season FP/G for Avg (Sleeper-aligned); keep σ from game samples. */
    const seasonAvg = seasonInfo && Number.isFinite(seasonInfo.avg) ? seasonInfo.avg : null;
    const seasonGp = seasonInfo && Number.isFinite(seasonInfo.gp) ? seasonInfo.gp : null;
    const mean = seasonAvg != null ? seasonAvg : sampleMean;
    const ceiling = mean + stdev;
    const hits = {};
    const normalHits = {};
    markList.forEach(m => {
      hits[m] = empiricalHitRate(arr, m);
      normalHits[m] = normalHitRate(mean, stdev, m);
    });
    return {
      n, mean, sampleMean, stdev, ceiling, samples: arr,
      hits, normalHits, marks: markList,
      seasonAvg, seasonGp, avgSource: seasonAvg != null ? 'season' : 'sample'
    };
  }

  function buildDistMap(samplesByPlayer, marks, seasonAvgByPid){
    const out = {};
    const seasonMap = seasonAvgByPid || {};
    Object.keys(samplesByPlayer || {}).forEach(pid => {
      const d = playerDist(samplesByPlayer[pid], marks, seasonMap[pid] || null);
      if (d) out[pid] = d;
    });
    return out;
  }

  /* Expected number of locks ≥ mark if each player on the list produces one
     lockable night at their empirical hit rate (position rules ignored). */
  function expectedLocks(dists, mark){
    return (dists || []).reduce((s, d) => s + (d && d.hits ? (d.hits[mark] || 0) : 0), 0);
  }

  /* Monte Carlo: each player contributes one draw from their samples (bootstrap)
     or N(μ,σ); take the top `slots` scores and count how many clear each mark. */
  function simulateFill(dists, opts){
    const options = opts || {};
    const slots = options.slots || LOCK_SLOTS;
    const marks = options.marks || DEFAULT_MARKS;
    const sims = options.sims || 400;
    const useNormal = !!options.useNormal;
    const list = (dists || []).filter(d => d && d.n > 0);
    const fill = {};
    marks.forEach(m => { fill[m] = 0; });
    let sumTop = 0;

    function draw(d){
      if (useNormal || !d.samples || !d.samples.length){
        if (!(d.stdev > 1e-9)) return d.mean;
        // Box-Muller
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return d.mean + d.stdev * z;
      }
      return d.samples[Math.floor(Math.random() * d.samples.length)];
    }

    for (let s = 0; s < sims; s++){
      const scores = list.map(draw).sort((a, b) => b - a).slice(0, slots);
      while (scores.length < slots) scores.push(0);
      sumTop += scores.reduce((a, b) => a + b, 0);
      marks.forEach(m => {
        fill[m] += scores.filter(v => v >= m).length;
      });
    }

    const avgFill = {};
    marks.forEach(m => { avgFill[m] = fill[m] / sims; });
    return {
      slots,
      marks,
      sims,
      avgTopTotal: sumTop / sims,
      avgFill,
      expected: Object.fromEntries(marks.map(m => [m, expectedLocks(list, m)]))
    };
  }

  function teamLockInSummary(playerDists, opts){
    const options = opts || {};
    const marks = options.marks || DEFAULT_MARKS;
    const slots = options.slots || LOCK_SLOTS;
    const ranked = (playerDists || [])
      .filter(Boolean)
      .slice()
      .sort((a, b) => {
        const as = Number(a.lockScore);
        const bs = Number(b.lockScore);
        if (Number.isFinite(as) || Number.isFinite(bs)){
          return (Number.isFinite(bs) ? bs : -1) - (Number.isFinite(as) ? as : -1);
        }
        return b.ceiling - a.ceiling;
      });
    const sim = simulateFill(ranked, {slots, marks, sims: options.sims || 400});
    const maxPts = ranked.slice(0, slots).reduce((s, d) => s + d.ceiling, 0);
    return {
      slots,
      marks,
      playerCount: ranked.length,
      maxPts,
      topMean: ranked.slice(0, slots).reduce((s, d) => s + d.mean, 0),
      sim,
      ranked
    };
  }

  /* ---- Smash-hunting Lock OVR (Intel) ----
     Raw smash base = 0.50·Avg + 0.25·Ceil + 0.25·(40·P≥40 + 50·P≥50)
     Rookies: Y1 proj + early-career comps (peak floors haircut) or draft-rank
     bands (50/50), soft-capped until smash samples exist.
     Thin vet samples (N < 5 game lines) fall back to projected FP/G.
     Lock OVR maps smash base → 50–99 on an ABSOLUTE curve (not pool
     percentile — percentile vs all NBA stuffed every roster guy into the 90s).
     Age / injury stay off OVR — those belong on Trade stars later. */
  const SMASH_WEIGHTS = { avg: 0.50, ceil: 0.25, hit: 0.25 };
  const MIN_SAMPLES_FOR_SMASH = 5;
  /* Multi-season Lock blend (smash bases, then OVR curve).
     Vet: 60% last · 20% prior · 20% next-year proj.
     Sophomore (years_exp=1): 75% last · 25% proj.
     Rookie: unchanged (proj + early-career comps). */
  const BLEND_VET = {last: 0.60, prior: 0.20, proj: 0.20};
  const BLEND_SOPH = {last: 0.75, proj: 0.25};
  const LOCK_OVR_FLOOR = 50;
  const LOCK_OVR_CEIL = 99;
  const AGE_MULT = { young: 1.10, prime: 1.0, decline: 0.9, unknown: 1.0 };
  /* Trade Potential: young flashes (up to ×1.08) and decline-age durability
     (recover up to 70% of the ×0.9 age haircut toward 1.0). Does not move Lock OVR. */
  const POTENTIAL_YOUNG_MAX = 0.08;
  const POTENTIAL_EARLY_PRIME_MAX = 0.05; /* age < 26 in prime band */
  const POTENTIAL_EARLY_PRIME_AGE = 26;
  const POTENTIAL_DECLINE_RELIEF = 0.70;
  const ROOKIE_PROJ_W = 0.5;
  const ROOKIE_COMP_W = 0.5;
  /* Peak-comp floors describe prime comps (Brown/Booker/etc). Lock OVR for
     rookies should read as early-career smash (Y1–Y3), not prime — so we
     haircut peak floors before they enter the OVR curve. */
  const ROOKIE_EARLY_CAREER_MULT = {
    franchise: 0.55,
    allstar_prospect: 0.68,
    starter: 0.70,
    default: 0.68
  };
  /* Soft ceiling until a rookie has real weekly smash samples — keeps
     unproven lottery names out of All-Star / Superstar Lock territory. */
  const ROOKIE_LOCK_OVR_CAP = 82;
  /* Draft-rank → early-career smash proxy when ESPN comps / Y1 proj are thin.
     Tuned to land lottery ~mid-60s Lock, mid-first ~high-50s, late ~low-50s. */
  const ROOKIE_RANK_BASE = [
    {maxRank: 3, base: 22},
    {maxRank: 10, base: 17},
    {maxRank: 20, base: 14},
    {maxRank: 30, base: 12},
    {maxRank: 45, base: 10},
    {maxRank: 999, base: 9}
  ];

  /* ESPN post–summer league outlook. `floor` = peak-comp FP/G proxy.
     Lock valuation uses early-career haircut of that floor (not prime). */
  const ESPN_ROOKIE_OUTLOOK = {
    ajdybantsa:{outlook:1, ceiling:'franchise', comps:'Jaylen Brown / Kawhi high · RJ Barrett low', floor:45},
    darrynpeterson:{outlook:2, ceiling:'franchise', comps:'Booker / Lillard+tools high · Murray+D low', floor:44},
    cameronboozer:{outlook:3, ceiling:'allstar_prospect', comps:'Kevin Love+ball skills · Sabonis+3', floor:24},
    calebwilson:{outlook:4, ceiling:'starter', comps:'Bouncier Siakam high · John Collins low', floor:18},
    braydenburries:{outlook:5, ceiling:'starter', comps:'Summer riser', floor:16},
    mikelbrownjr:{outlook:6, ceiling:'starter', comps:'Lottery guard', floor:15},
    mikelbrown:{outlook:6, ceiling:'starter', comps:'Lottery guard', floor:15},
    yaxellendeborg:{outlook:7, ceiling:'starter', comps:'Summer riser', floor:14},
    morezjohnsonjr:{outlook:8, ceiling:'starter', comps:'Big upside', floor:13},
    morezjohnson:{outlook:8, ceiling:'starter', comps:'Big upside', floor:13},
    kingstonflemings:{outlook:9, ceiling:'starter', comps:'Lottery guard', floor:13},
    keatonwagler:{outlook:10, ceiling:'starter', comps:'Haliburton pace high · Nembhard low', floor:12},
    dariusacuffjr:{outlook:11, ceiling:'starter', comps:'Brunson high · Bibby low', floor:12},
    dariusacuff:{outlook:11, ceiling:'starter', comps:'Brunson high · Bibby low', floor:12}
  };

  function normalizePlayerName(name){
    return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.\u2019']/g, '').replace(/[^a-z0-9]/g, '');
  }

  /* Sleeper often drops Jr./Sr.; 2K/ESPN keep them. Index both forms. */
  function playerNameKeys(name){
    const key = normalizePlayerName(name);
    if (!key) return [];
    const keys = [key];
    const stripped = key.replace(/(jr|sr|ii|iii|iv)$/,'');
    if (stripped && stripped !== key) keys.push(stripped);
    const withJr = stripped + 'jr';
    if (stripped && withJr !== key) keys.push(withJr);
    return keys;
  }

  function sleeperPlayerName(p){
    if (!p) return '';
    if (p.full_name) return p.full_name;
    return ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
  }

  function rookieNamesFromSnapshot(snapshot){
    const names = new Set();
    Object.keys(ESPN_ROOKIE_OUTLOOK).forEach(k => playerNameKeys(k).forEach(x => names.add(x)));
    const pack = snapshot || global.TWO_K_SNAPSHOT || null;
    ((pack && pack.rookies) || []).forEach(r => {
      playerNameKeys(r && r.name).forEach(x => names.add(x));
    });
    return names;
  }

  function rookieRankByName(snapshot){
    const map = new Map();
    const pack = snapshot || global.TWO_K_SNAPSHOT || null;
    ((pack && pack.rookies) || []).forEach(r => {
      const rank = Number(r && r.rank);
      if (!Number.isFinite(rank) || rank <= 0) return;
      playerNameKeys(r && r.name).forEach(key => {
        if (!map.has(key) || rank < map.get(key)) map.set(key, rank);
      });
    });
    return map;
  }

  function rookieOutlookRow(p, nameKey){
    const keys = nameKey
      ? playerNameKeys(nameKey)
      : playerNameKeys(sleeperPlayerName(p));
    for (let i = 0; i < keys.length; i++){
      const row = ESPN_ROOKIE_OUTLOOK[keys[i]];
      if (row) return row;
    }
    return null;
  }

  function rookieEarlyCareerMult(row){
    if (!row) return ROOKIE_EARLY_CAREER_MULT.default;
    const c = row.ceiling;
    if (c && ROOKIE_EARLY_CAREER_MULT[c] != null) return ROOKIE_EARLY_CAREER_MULT[c];
    const o = Number(row.outlook);
    if (o <= 2) return ROOKIE_EARLY_CAREER_MULT.franchise;
    if (o <= 3) return ROOKIE_EARLY_CAREER_MULT.allstar_prospect;
    return ROOKIE_EARLY_CAREER_MULT.starter;
  }

  /* Peak-comp floor (prime comparison FP) — kept for tooltips / diagnostics. */
  function rookieCompPeak(p, nameKey){
    const row = rookieOutlookRow(p, nameKey);
    const f = row && Number(row.floor);
    return Number.isFinite(f) && f > 0 ? f : null;
  }

  /* Early-career smash proxy from draft rank when comps are missing. */
  function rookieRankFloor(p, nameKey, snapshot){
    const keys = nameKey
      ? playerNameKeys(nameKey)
      : playerNameKeys(sleeperPlayerName(p));
    if (!keys.length) return null;
    const ranks = rookieRankByName(snapshot);
    let rank = null;
    for (let i = 0; i < keys.length; i++){
      const hit = ranks.get(keys[i]);
      if (Number.isFinite(hit) && (rank == null || hit < rank)) rank = hit;
    }
    if (!Number.isFinite(rank)) return null;
    for (let i = 0; i < ROOKIE_RANK_BASE.length; i++){
      if (rank <= ROOKIE_RANK_BASE[i].maxRank) return ROOKIE_RANK_BASE[i].base;
    }
    return null;
  }

  /* Early-career (Y1–Y3) smash proxy from peak comps — used for Lock OVR. */
  function rookieCompFloor(p, nameKey){
    const row = rookieOutlookRow(p, nameKey);
    const peak = rookieCompPeak(p, nameKey);
    if (peak == null) return null;
    return peak * rookieEarlyCareerMult(row);
  }

  /* Early-career comps with draft-rank as a floor (and fallback). Rank stops
     thin ESPN starter floors from underselling mid-lottery names; franchise
     comps still clear the rank band for the top of the class. */
  function rookieValueFloor(p, nameKey, snapshot){
    const comp = rookieCompFloor(p, nameKey);
    const rank = rookieRankFloor(p, nameKey, snapshot);
    if (comp != null && rank != null) return Math.max(comp, rank);
    if (comp != null) return comp;
    return rank;
  }

  /* 50% next-year (Y1) proj + 50% early-career comps/rank → smash-equivalent lockBase.
     Year-1 proj is already early-career; comps are haircut from peak. */
  function blendRookieBase(proj, comp){
    const p = Number(proj);
    const c = Number(comp);
    const hasP = Number.isFinite(p) && p > 0;
    const hasC = Number.isFinite(c) && c > 0;
    if (hasP && hasC) return ROOKIE_PROJ_W * p + ROOKIE_COMP_W * c;
    if (hasP) return p;
    if (hasC) return c;
    return null;
  }

  function clampRookieOvr(ovr, hasSmashSamples){
    const n = Number(ovr);
    if (!Number.isFinite(n)) return null;
    if (hasSmashSamples) return n;
    return Math.min(n, ROOKIE_LOCK_OVR_CAP);
  }

  function isRookiePlayer(p, pid, opts){
    const options = opts || {};
    const yearsExp = Number(p && p.years_exp);
    if (yearsExp === 0) return true;
    if (options.rookieIds && options.rookieIds.has(String(pid))) return true;
    const keys = playerNameKeys(sleeperPlayerName(p));
    if (!keys.length) return false;
    for (let i = 0; i < keys.length; i++){
      const key = keys[i];
      if (ESPN_ROOKIE_OUTLOOK[key]) return true;
      if (options.rookieNames && options.rookieNames.has(key)) return true;
    }
    return false;
  }

  /* Map draft-class names → Sleeper ids (prefer active / ranked rows). */
  function matchRookieIdsByName(playerDb, rookieNames){
    const best = new Map(); /* canonical nameKey → {pid, rank} */
    const names = rookieNames || rookieNamesFromSnapshot();
    Object.keys(playerDb || {}).forEach(pid => {
      if (String(pid).indexOf('TEAM_') === 0) return;
      const p = playerDb[pid];
      if (!p) return;
      const keys = playerNameKeys(sleeperPlayerName(p));
      const hit = keys.find(k => names.has(k));
      if (!hit) return;
      const rank = Number(p.search_rank);
      const score = Number.isFinite(rank) ? rank : 999999;
      const canon = keys[0];
      const prev = best.get(canon);
      if (!prev || score < prev.rank) best.set(canon, {pid: String(pid), rank: score});
    });
    const ids = new Set();
    best.forEach(row => ids.add(row.pid));
    return ids;
  }

  /* Absolute smash-base → OVR anchors (2K reading):
     Top (85+) stays tight; mid/low softened so solid/strong starters
     aren't crushed relative to All-Stars.
     50 Depth · 60 Rotation · 70 Solid · 80 Strong · 85 All-Star · 90 Superstar · 95 MVP */
  const LOCK_OVR_ANCHORS = [
    {base: 10, ovr: 50},
    {base: 16, ovr: 60},
    {base: 20, ovr: 68},
    {base: 24, ovr: 75},
    {base: 27, ovr: 80},
    {base: 30, ovr: 83},
    {base: 34, ovr: 85},
    {base: 37, ovr: 88},
    {base: 40, ovr: 91},
    {base: 44, ovr: 95},
    {base: 50, ovr: 99}
  ];

  function smashHitScore(dist){
    const h = (dist && dist.hits) || {};
    return 40 * (h[40] || 0) + 50 * (h[50] || 0);
  }

  function smashLockBase(dist){
    if (!dist || !Number.isFinite(dist.mean) || !Number.isFinite(dist.ceiling)) return null;
    return SMASH_WEIGHTS.avg * dist.mean
      + SMASH_WEIGHTS.ceil * dist.ceiling
      + SMASH_WEIGHTS.hit * smashHitScore(dist);
  }

  /* Letter grade on raw smash base (same anchors as Lock OVR curve).
     Visible “how smashy” read — Avg alone can look even while grade differs. */
  const SMASH_GRADE_BANDS = [
    {min: 40, grade: 'A+'},
    {min: 37, grade: 'A'},
    {min: 34, grade: 'A-'},
    {min: 30, grade: 'B+'},
    {min: 27, grade: 'B'},
    {min: 24, grade: 'B-'},
    {min: 20, grade: 'C+'},
    {min: 16, grade: 'C'},
    {min: 13, grade: 'C-'},
    {min: 10, grade: 'D'},
    {min: 0, grade: 'F'}
  ];

  function smashGradeFromBase(base){
    if (base == null || base === '') return null;
    const x = Number(base);
    if (!Number.isFinite(x)) return null;
    for (let i = 0; i < SMASH_GRADE_BANDS.length; i++){
      if (x >= SMASH_GRADE_BANDS[i].min) return SMASH_GRADE_BANDS[i].grade;
    }
    return 'F';
  }

  function smashParts(dist){
    if (!dist || !Number.isFinite(Number(dist.mean))) return null;
    const mean = Number(dist.mean);
    const ceiling = Number.isFinite(Number(dist.ceiling)) ? Number(dist.ceiling) : mean;
    const hit = smashHitScore(dist);
    const base = smashLockBase({
      mean: mean,
      ceiling: ceiling,
      hits: dist.hits || {}
    });
    if (base == null || !Number.isFinite(base)) return null;
    return {
      mean: mean,
      ceiling: ceiling,
      hitScore: Math.round(hit * 1000) / 1000,
      base: Math.round(base * 100) / 100,
      avgPart: Math.round(SMASH_WEIGHTS.avg * mean * 100) / 100,
      ceilPart: Math.round(SMASH_WEIGHTS.ceil * ceiling * 100) / 100,
      hitPart: Math.round(SMASH_WEIGHTS.hit * hit * 100) / 100,
      n: Number(dist.n) || 0,
      projOnly: !!dist.projOnly
    };
  }

  function attachSmashGrade(d){
    if (!d) return;
    const parts = smashParts(d);
    if (parts && parts.n >= MIN_SAMPLES_FOR_SMASH && !parts.projOnly){
      d.smashBase = parts.base;
      d.smashMean = parts.mean;
      d.smashCeiling = parts.ceiling;
      d.smashHitScore = parts.hitScore;
      d.smashAvgPart = parts.avgPart;
      d.smashCeilPart = parts.ceilPart;
      d.smashHitPart = parts.hitPart;
      d.smashGrade = smashGradeFromBase(parts.base);
      d.smashGradeSource = 'season';
      return;
    }
    /* Thin / proj stub: grade the blended lockBase so rookies still show something. */
    if (d.lockBase != null && Number.isFinite(Number(d.lockBase))){
      d.smashBase = Math.round(Number(d.lockBase) * 100) / 100;
      d.smashGrade = smashGradeFromBase(d.lockBase);
      d.smashGradeSource = d.lockBaseSource || 'blend';
      return;
    }
    d.smashBase = null;
    d.smashGrade = null;
    d.smashGradeSource = null;
  }

  /* Smash input for one season — prefer full smash; fall back to season mean. */
  function seasonLockInput(dist){
    if (!dist || dist.projOnly) return null;
    const smash = smashLockBase(dist);
    if (smash != null && Number.isFinite(smash)) return smash;
    if (Number.isFinite(Number(dist.mean)) && Number(dist.mean) > 0) return Number(dist.mean);
    return null;
  }

  /* Renormalize over whichever legs are present. parts: [{key,w,v}, ...] */
  function blendWeightedBase(parts){
    const ok = (parts || []).filter(p =>
      p && p.w > 0 && p.v != null && Number.isFinite(Number(p.v))
    );
    if (!ok.length) return null;
    const sumW = ok.reduce((s, p) => s + p.w, 0);
    if (!(sumW > 0)) return null;
    const norm = ok.map(p => ({
      key: p.key,
      w: p.w,
      wNorm: p.w / sumW,
      v: Number(p.v)
    }));
    const base = norm.reduce((s, p) => s + p.v * p.wNorm, 0);
    return {base, parts: norm, sumW};
  }

  function blendSourceLabel(isSoph, blend){
    if (!blend || !blend.parts || !blend.parts.length) return null;
    const keys = blend.parts.map(p => p.key).sort().join('+');
    if (isSoph){
      if (keys === 'last+proj') return 'blend-75-25';
      if (keys === 'last') return 'blend-last';
      if (keys === 'proj') return 'blend-proj';
      return 'blend-soph-renorm';
    }
    if (keys === 'last+prior+proj') return 'blend-60-20-20';
    if (keys === 'last+proj') return 'blend-75-25-renorm'; /* missing prior */
    if (keys === 'last+prior') return 'blend-last-prior-renorm';
    if (keys === 'prior+proj') return 'blend-prior-proj-renorm';
    if (keys === 'last') return 'blend-last';
    if (keys === 'prior') return 'blend-prior';
    if (keys === 'proj') return 'blend-proj';
    return 'blend-renorm';
  }

  function yearsExpOfPlayer(p){
    if (!p || typeof p !== 'object') return null;
    const y = p.years_exp != null ? p.years_exp : p.yearsExp;
    const n = Number(y);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function lockAgeBand(age, isRookie){
    const a = Number(age);
    if (!Number.isFinite(a) || a <= 0) return isRookie ? 'young' : 'unknown';
    if (a < 24) return 'young';
    if (a <= 32) return 'prime';
    return 'decline';
  }

  /* NBA regular season ~ mid-Oct through mid-Apr. Live Sleeper tags (DTD/Out)
     are noise in the offseason and should not move Trade ★. */
  function isNbaOffseason(now){
    const d = now instanceof Date ? now : new Date();
    const m = d.getUTCMonth(); /* 0 = Jan */
    return m >= 4 && m <= 8; /* May–September */
  }

  function injuryStatusMult(status, opts){
    const options = opts || {};
    if (options.ignoreInjuryStatus === true) return 1;
    if (options.offseason === true || (options.offseason !== false && isNbaOffseason())) return 1;
    const s = String(status || '').toLowerCase();
    if (s === 'out' || s === 'ir' || s === 'injured reserve') return 0.94;
    if (s === 'doubtful') return 0.96;
    if (s === 'questionable') return 0.98;
    return 1;
  }

  /* Chronic injury-prone slip (same list as Mock Draft). Stars stay stars —
     just slide a spot or two. Applied to Trade ★ year-round. */
  const INJURY_PRONE = {
    zionwilliamson: 0.86,
    kawhileonard: 0.88,
    anthonydavis: 0.90,
    joelembiid: 0.87,
    kristapsporzingis: 0.88,
    jamorant: 0.91,
    kyrieirving: 0.92,
    brandoningram: 0.92,
    jonathanisaac: 0.84,
    lonzoball: 0.83,
    bensimmons: 0.82,
    paulgeorge: 0.90,
    jamalmurray: 0.93,
    tylerherro: 0.94,
    scoothenderson: 0.93,
    darrynpeterson: 0.93,
    keeganmurray: 0.95,
    jalenwilliams: 0.95,
    chetholmgren: 0.94
  };

  function injuryProneMult(nameOrKey){
    if (nameOrKey && typeof nameOrKey === 'object'){
      const p = nameOrKey;
      const n = p.name || p.full_name || sleeperPlayerName(p) || '';
      const key = normalizePlayerName(n);
      const m = INJURY_PRONE[key];
      return m != null && Number.isFinite(Number(m)) ? Number(m) : 1;
    }
    const key = normalizePlayerName(nameOrKey);
    if (!key) return 1;
    const m = INJURY_PRONE[key];
    return m != null && Number.isFinite(Number(m)) ? Number(m) : 1;
  }

  /* Chronic prone × live Sleeper tag (tag ignored in offseason). */
  function injuryTradeMult(status, nameOrKey, opts){
    return injuryProneMult(nameOrKey) * injuryStatusMult(status, opts);
  }

  /* Piecewise-linear absolute curve; clamps to [50, 99]. */
  function ovrFromSmashBase(base){
    const b = Number(base);
    if (!Number.isFinite(b)) return null;
    const anchors = LOCK_OVR_ANCHORS;
    if (b <= anchors[0].base) return LOCK_OVR_FLOOR;
    if (b >= anchors[anchors.length - 1].base) return LOCK_OVR_CEIL;
    for (let i = 0; i < anchors.length - 1; i++){
      const a = anchors[i];
      const c = anchors[i + 1];
      if (b >= a.base && b <= c.base){
        const t = (b - a.base) / (c.base - a.base);
        return Math.round(a.ovr + t * (c.ovr - a.ovr));
      }
    }
    return LOCK_OVR_FLOOR;
  }

  /* @deprecated — kept for callers; prefer ovrFromSmashBase. */
  function ovrFromPercentile(pct){
    const p = Math.max(0, Math.min(1, Number(pct) || 0));
    return Math.round(LOCK_OVR_FLOOR + p * (LOCK_OVR_CEIL - LOCK_OVR_FLOOR));
  }

  function lockOvrTier(ovr){
    const n = Number(ovr);
    if (!Number.isFinite(n)) return {key:'unknown', label:'—'};
    if (n >= 95) return {key:'mvp', label:'MVP / top-5'};
    if (n >= 90) return {key:'superstar', label:'Superstar'};
    if (n >= 85) return {key:'allstar', label:'All-Star'};
    if (n >= 80) return {key:'strong', label:'Strong starter'};
    if (n >= 70) return {key:'solid', label:'Solid starter'};
    if (n >= 60) return {key:'rotation', label:'Rotation'};
    return {key:'depth', label:'Depth'};
  }

  function starsFromPercentile(pct){
    if (pct >= 0.90) return 5;
    if (pct >= 0.75) return 4;
    if (pct >= 0.50) return 3;
    if (pct >= 0.25) return 2;
    return 1;
  }

  /* Clamp to 1–5 on a half-star grid (1, 1.5, … 5). */
  function clampTradeStars(n){
    const s = Number(n);
    if (!Number.isFinite(s) || s <= 0) return null;
    const stepped = Math.round(s * 2) / 2;
    return Math.max(1, Math.min(5, stepped));
  }

  /* Plain-text stars — filled (+ optional ½) only, no empty ☆ clutter. */
  function formatStars(n){
    const stars = clampTradeStars(n);
    if (stars == null) return '—';
    const full = Math.floor(stars);
    const half = stars - full >= 0.5;
    return '★'.repeat(full) + (half ? '½' : '');
  }

  /* HTML stars: filled + half only. Empty ☆ were misaligned and noisy in tables. */
  function formatStarsHtml(n, opts){
    const stars = clampTradeStars(n);
    const cls = (opts && opts.className) || 'stars';
    if (stars == null) return '<span class="' + cls + ' dim">—</span>';
    const full = Math.floor(stars);
    const half = stars - full >= 0.5;
    let html = '<span class="' + cls + '" aria-label="' + stars + ' of 5">';
    for (let i = 0; i < full; i++) html += '<span class="star full" aria-hidden="true">★</span>';
    if (half) html += '<span class="star half" aria-hidden="true">★</span>';
    html += '</span>';
    return html;
  }

  /* Absolute tradeScore → stars (2K trade-finder style, half-star steps). */
  const TRADE_STAR_BANDS = [
    {min: 95, stars: 5},
    {min: 90, stars: 4.5},
    {min: 85, stars: 4},
    {min: 80, stars: 3.5},
    {min: 75, stars: 3},
    {min: 70, stars: 2.5},
    {min: 65, stars: 2},
    {min: 60, stars: 1.5},
    {min: 0, stars: 1}
  ];

  function tradeStarsFromScore(score){
    const s = Number(score);
    if (!Number.isFinite(s)) return null;
    for (let i = 0; i < TRADE_STAR_BANDS.length; i++){
      if (s >= TRADE_STAR_BANDS[i].min) return TRADE_STAR_BANDS[i].stars;
    }
    return 1;
  }

  function normContractName(name){
    return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.\u2019']/g, '').replace(/[^a-z0-9]/g, '');
  }

  function playerDisplayName(p, pid){
    if (!p) return '';
    if (p.full_name) return p.full_name;
    if (p.fullName) return p.fullName;
    if (p.name) return p.name;
    const first = p.first_name || p.firstName || '';
    const last = p.last_name || p.lastName || '';
    const joined = (first + ' ' + last).trim();
    return joined || String(pid || '');
  }

  /* Prefer TeamNeedsModel when present (shared with cut protect); else read snapshot. */
  function contractTradeAdjust(name, ovr){
    if (global.TeamNeedsModel && typeof TeamNeedsModel.contractProfile === 'function'){
      const profile = TeamNeedsModel.contractProfile(name, {lockOvr: ovr});
      if (!profile) return {mult: 1, why: '', profile: null};
      return {mult: profile.tradeMult || 1, why: profile.why || '', profile};
    }
    const snap = global.NBA_CONTRACTS_SNAPSHOT;
    if (!snap) return {mult: 1, why: '', profile: null};
    const key = normContractName(name);
    if (!key) return {mult: 1, why: '', profile: null};
    const salary = (snap.salaries || []).find(s => (s.key || normContractName(s.name)) === key);
    const buyout = (snap.buyouts || []).find(b => (b.key || normContractName(b.name)) === key);
    const deal = (snap.deals || []).find(d => (d.key || normContractName(d.name)) === key);
    const asOf = snap.asOfYear != null ? Number(snap.asOfYear) : new Date().getUTCFullYear();
    const buyoutFresh = !!(buyout && (asOf - Number(buyout.season || 0)) <= 2);
    const annual = (salary && salary.y1 != null) ? Number(salary.y1)
      : (deal && deal.aav != null ? Number(deal.aav) : null);
    /* Mirror TeamNeedsModel.contractSalaryMult log slider if model isn't loaded. */
    let mult = 1;
    if (Number.isFinite(annual) && annual > 0){
      const loSal = 2.5e6, midSal = 10e6, hiSal = 45e6;
      const loMult = 0.92, midMult = 1.0, hiMult = 1.065;
      const s = Math.max(1e5, annual);
      const clamp01 = x => Math.max(0, Math.min(1, x));
      const lerp = (a, b, t) => a + (b - a) * t;
      if (s <= midSal){
        const t = clamp01((Math.log(s) - Math.log(loSal)) / (Math.log(midSal) - Math.log(loSal)));
        mult = lerp(loMult, midMult, t);
      } else {
        const t = clamp01((Math.log(s) - Math.log(midSal)) / (Math.log(hiSal) - Math.log(midSal)));
        mult = lerp(midMult, hiMult, t);
      }
      if (mult < 1 && ovr != null && Number.isFinite(Number(ovr))){
        const prod = clamp01((Number(ovr) - 60) / 25);
        mult = lerp(mult, 1, prod * 0.7);
      }
      mult = Math.round(mult * 1000) / 1000;
    }
    let why = '';
    if (Number.isFinite(annual) && annual > 0){
      why = '$' + (annual >= 1e6 ? (annual / 1e6).toFixed(annual >= 10e6 ? 0 : 1) + 'M' : Math.round(annual))
        + '/yr slider ×' + mult.toFixed(3);
    }
    if (buyoutFresh){
      mult = Math.round(mult * 0.90 * 1000) / 1000;
      why = (why ? why + ' · ' : '') + 'Buyout/waive ' + buyout.season;
    }
    return {mult, why, profile: salary || buyout || deal || null};
  }

  function clamp01(x){
    return Math.max(0, Math.min(1, Number(x) || 0));
  }

  /* 0–1 “flashes of greatness”: smash premium, hit rates, base≫proj, rookie outlook. */
  function potentialFlashSignal(info){
    const row = info || {};
    const mean = Number(row.mean);
    const ceiling = Number(row.ceiling);
    const stdev = Number(row.stdev);
    const n = Number(row.n) || 0;
    const hits = row.hits || {};
    let best = 0;

    if (n >= MIN_SAMPLES_FOR_SMASH && Number.isFinite(mean) && mean > 0){
      const smash = smashLockBase({
        mean: mean,
        ceiling: Number.isFinite(ceiling) ? ceiling : mean,
        hits: hits,
        stdev: Number.isFinite(stdev) ? stdev : 0
      });
      if (smash != null && Number.isFinite(smash)){
        best = Math.max(best, clamp01((smash - mean) / Math.max(8, mean * 0.45)));
      }
      best = Math.max(best, clamp01((Number(hits[40]) || 0) / 0.12));
      best = Math.max(best, clamp01((Number(hits[50]) || 0) / 0.05));
    }

    const lockBase = Number(row.lockBase);
    const proj = Number(row.proj);
    if (Number.isFinite(lockBase) && Number.isFinite(proj) && proj > 0 && lockBase > proj){
      best = Math.max(best, clamp01((lockBase - proj) / Math.max(6, proj * 0.35)));
    }

    if (row.isRookie && n < MIN_SAMPLES_FOR_SMASH){
      const outlook = row.outlookRow || null;
      const ceil = outlook && outlook.ceiling;
      if (ceil === 'franchise') best = Math.max(best, 0.55);
      else if (ceil === 'allstar_prospect') best = Math.max(best, 0.35);
      else if (ceil === 'starter') best = Math.max(best, 0.15);
    }
    return clamp01(best);
  }

  /* 0–1 “hasn’t fallen off”: high prod OVR and/or last smash ≈ prior. */
  function potentialDurabilitySignal(info){
    const row = info || {};
    const ovr = Number(row.ovr);
    let d = 0;
    if (Number.isFinite(ovr)) d = Math.max(d, clamp01((ovr - 70) / 20));
    const last = Number(row.lastBase);
    const prior = Number(row.priorBase);
    if (Number.isFinite(last) && Number.isFinite(prior) && prior > 0){
      d = Math.max(d, clamp01((last / prior - 0.85) / 0.15));
    } else if (Number.isFinite(last) && last > 0 && Number.isFinite(ovr) && ovr >= 78){
      d = Math.max(d, 0.5);
    }
    return clamp01(d);
  }

  /* Trade-only Potential multiplier. Young/early-prime upside or decline relief. */
  function potentialTradeAdjust(meta){
    const info = meta || {};
    const band = info.ageBand || lockAgeBand(info.age, info.isRookie);
    const age = Number(info.age);
    let mult = 1;
    let why = '';
    let kind = 'none';
    let signal = 0;

    const earlyPrime = band === 'prime'
      && Number.isFinite(age)
      && age > 0
      && age < POTENTIAL_EARLY_PRIME_AGE;
    if (band === 'young' || earlyPrime){
      signal = potentialFlashSignal(info);
      if (signal > 0.05){
        const maxBump = band === 'young' ? POTENTIAL_YOUNG_MAX : POTENTIAL_EARLY_PRIME_MAX;
        mult = 1 + maxBump * signal;
        mult = Math.round(mult * 1000) / 1000;
        why = (band === 'young' ? 'Young flashes' : 'Early-prime flashes')
          + ' ×' + mult.toFixed(3);
        kind = 'upside';
      }
    } else if (band === 'decline'){
      signal = potentialDurabilitySignal(info);
      if (signal > 0.05){
        const declineMult = AGE_MULT.decline || 0.9;
        const ageGap = (1 / declineMult) - 1;
        mult = 1 + ageGap * POTENTIAL_DECLINE_RELIEF * signal;
        mult = Math.round(mult * 1000) / 1000;
        why = 'Still producing ×' + mult.toFixed(3);
        kind = 'durable';
      }
    }

    return {mult: mult, why: why, kind: kind, signal: Math.round(signal * 1000) / 1000};
  }

  /* tradeScore = LockOVR × age × injury × contract × situation × potential (+1 young bump).
     Injury = chronic INJURY_PRONE × live Sleeper tag (tag ignored offseason). */
  function tradeScoreFromOvr(ovr, meta){
    const o = Number(ovr);
    if (!Number.isFinite(o)) return null;
    const info = meta || {};
    const band = info.ageBand || lockAgeBand(info.age, info.isRookie);
    const am = AGE_MULT[band] || 1.0;
    const injOpts = {
      ignoreInjuryStatus: info.ignoreInjuryStatus,
      offseason: info.offseason
    };
    const im = info.injuryMult != null && Number.isFinite(Number(info.injuryMult))
      ? Number(info.injuryMult)
      : injuryTradeMult(info.injuryStatus, info.name || info.player, injOpts);
    const cm = info.contractMult != null && Number.isFinite(Number(info.contractMult))
      ? Number(info.contractMult)
      : 1;
    const sm = info.situationMult != null && Number.isFinite(Number(info.situationMult))
      ? Number(info.situationMult)
      : 1;
    const pm = info.potentialMult != null && Number.isFinite(Number(info.potentialMult))
      ? Number(info.potentialMult)
      : potentialTradeAdjust(Object.assign({}, info, {ageBand: band})).mult;
    let score = o * am * im * cm * sm * pm;
    if (band === 'young') score += 1;
    return score;
  }

  /* ---- Franchise situation / offseason competition ----
     Each player is graded only at their NBA depth-chart primary slot
     (multi-eligible fantasy tags are ignored for competition).
     Situation bites when that same primary slot is crowded with similar
     talent, the player is not clearly best there, or multiple stars share
     the role (e.g. two PF1s). Adjacent/cross-position stars do not auto-
     haircut — a PF is not docked for SF/SG/PG teammates.
     Situation moves Trade ★ fully and Lock OVR partially (LOCK_SIT_BLEND). */
  const LOCK_SIT_BLEND = 0.45; /* fraction of situation gap applied to Lock OVR */
  const SIT_MULT_MIN = 0.70;
  const SIT_MULT_MAX = 1.00; /* no free boost for being alone at a primary */
  const SIT_FA_MULT = 0.80;
  const VALID_PRIMARY_POS = {
    PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1
  };
  const CLEAR_POS_MARGIN = 4; /* OVR gap to count as clearly best at the slot */

  function fantasyPosSet(p){
    const out = new Set();
    const raw = (p && (p.fantasy_positions || p.fantasyPositions)) || [];
    raw.forEach(pos => {
      const s = String(pos || '').toUpperCase();
      if (s && s !== 'DEF') out.add(s);
    });
    return out;
  }

  /* NBA depth-chart primary only. Fantasy multi-eligibility never expands the
     role — a PF/SF/SG listed player who is PF1 is just a PF for situation. */
  function nbaPrimaryPos(p){
    if (!p || typeof p !== 'object') return null;
    const depth = String(p.depth_chart_position || '').trim().toUpperCase();
    if (depth && VALID_PRIMARY_POS[depth]) return depth;
    /* Fallback only when Sleeper has no depth slot yet (rookies, etc.). */
    const set = fantasyPosSet(p);
    if (!set.size) return null;
    if (set.has('PG') && !set.has('SF') && !set.has('PF') && !set.has('C') && !set.has('F')) return 'PG';
    if (set.has('C') && !set.has('PF') && !set.has('SF') && !set.has('SG') && !set.has('F')) return 'C';
    if (set.has('PF')) return 'PF';
    if (set.has('SF')) return 'SF';
    if (set.has('SG')) return 'SG';
    if (set.has('PG')) return 'PG';
    if (set.has('C')) return 'C';
    if (set.has('G')) return 'G';
    if (set.has('F')) return 'F';
    return null;
  }

  /* Same depth-chart primary only. G/F are aliases for their specific slots.
     No adjacent SF↔PF / PG↔SG spillover from multi-position eligibility. */
  function positionOverlapWeight(aPos, bPos){
    if (!aPos || !bPos) return 0;
    const a = String(aPos).toUpperCase();
    const b = String(bPos).toUpperCase();
    if (a === b) return 1;
    if ((a === 'G' && (b === 'PG' || b === 'SG')) || (b === 'G' && (a === 'PG' || a === 'SG'))) return 1;
    if ((a === 'F' && (b === 'SF' || b === 'PF')) || (b === 'F' && (a === 'SF' || a === 'PF'))) return 1;
    return 0;
  }

  function playersCompeteWeight(aP, bP){
    return positionOverlapWeight(nbaPrimaryPos(aP), nbaPrimaryPos(bP));
  }

  /* Legacy helper: fantasy-set overlap. Prefer playersCompeteWeight for situation. */
  function positionsCompete(aSet, bSet){
    if (!aSet || !bSet || !aSet.size || !bSet.size) return false;
    for (const x of aSet) if (bSet.has(x)) return true;
    const has = (s, arr) => arr.some(p => s.has(p));
    if (has(aSet, ['PG', 'SG', 'G']) && has(bSet, ['PG', 'SG', 'G'])) return true;
    if (has(aSet, ['SF', 'SG', 'PF', 'F']) && has(bSet, ['SF', 'SG', 'PF', 'F'])) return true;
    if (has(aSet, ['C']) && has(bSet, ['C'])) return true;
    if ((has(aSet, ['PF']) && has(bSet, ['C'])) || (has(bSet, ['PF']) && has(aSet, ['C']))) return true;
    return false;
  }

  function isPureCenter(posSet){
    return !!(posSet && posSet.has('C') && !posSet.has('PF') && !posSet.has('F') && !posSet.has('SF'));
  }

  function isWingPrimary(posSet){
    if (!posSet || !posSet.size) return false;
    if (posSet.has('C') && !posSet.has('PF') && !posSet.has('SF') && !posSet.has('F')) return false;
    return posSet.has('SF') || posSet.has('SG') || posSet.has('PF') || posSet.has('F');
  }

  function isNbaSkater(p){
    if (!p || typeof p !== 'object') return false;
    if (!playerHasNbaTeam(p)) return false;
    const pos = fantasyPosSet(p);
    if (!pos.size) return false;
    if (pos.size === 1 && pos.has('DEF')) return false;
    return true;
  }

  /* True when Sleeper has a real NBA club code (not FA / empty). */
  function playerHasNbaTeam(p){
    if (!p || typeof p !== 'object') return false;
    const raw = p.team != null ? p.team
      : (p.nbaTeam != null ? p.nbaTeam
        : (p.nba_team != null ? p.nba_team : null));
    if (raw == null || raw === '') return false;
    const t = String(raw).trim().toUpperCase();
    if (!t || t === 'FA' || t === 'FREE' || t === 'NONE' || t === 'NULL') return false;
    return t.length === 3;
  }

  /* Sleeper uses status "RET" for retired players. */
  function isRetiredPlayer(p){
    if (!p || typeof p !== 'object') return false;
    const s = String(p.status || '').trim().toUpperCase();
    return s === 'RET' || s === 'RETIRED';
  }

  function zeroRetiredLockValues(d){
    if (!d) return;
    const tier = lockOvrTier(0);
    d.lockBase = 0;
    d.lockBaseSource = 'retired';
    d.lockBlend = null;
    d.lockOvrProd = 0;
    d.lockOvr = 0;
    d.lockOvrUnsignedFloor = false;
    d.lockOvrRetired = true;
    d.lockTier = tier.key;
    d.lockTierLabel = tier.label;
    d.lockScore = 0;
    d.lockStars = null;
    d.lockPct = null;
    d.tradeScore = 0;
    d.tradeStars = 0;
    d.smashBase = 0;
    d.smashGrade = 'F';
    d.smashGradeSource = 'retired';
    d.tradeAgeMult = 1;
    d.tradeInjuryMult = 1;
    d.tradeInjuryProneMult = 1;
    d.tradeInjuryStatusMult = 1;
    d.tradeContractMult = 1;
    d.tradeContractNote = null;
    d.tradePotentialMult = 1;
    d.tradePotentialNote = null;
    d.tradePotentialKind = null;
    d.tradeSituationMult = 1;
    d.tradeSituationNote = 'Retired — dynasty value zeroed';
    d.tradeSituationKind = 'retired';
    d.tradeSituationPressure = null;
    d._lockMeta = null;
  }

  /* Fantasy FP/G projection. No NBA roster → 0 until signed. */
  function projectionForPlayer(raw, player){
    if (isRetiredPlayer(player)) return 0;
    if (!playerHasNbaTeam(player)) return 0;
    if (raw == null || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  /* Force every unsigned player to 0 in a proj map (Map or plain object). */
  function zeroUnsignedProjections(projById, playerDb){
    if (!projById || !playerDb) return 0;
    let n = 0;
    const setZero = (pid) => {
      const id = String(pid);
      if (typeof projById.set === 'function'){
        const cur = projById.get(id);
        if (cur === 0) return;
        projById.set(id, 0);
      } else {
        if (projById[id] === 0) return;
        projById[id] = 0;
      }
      n++;
    };
    Object.keys(playerDb).forEach(pid => {
      if (!playerHasNbaTeam(playerDb[pid])) setZero(pid);
    });
    const keys = typeof projById.keys === 'function'
      ? Array.from(projById.keys())
      : Object.keys(projById);
    keys.forEach(pid => {
      const p = playerDb[pid] || playerDb[String(pid)];
      if (p && !playerHasNbaTeam(p)) setZero(pid);
    });
    return n;
  }

  /* Read proj for UI / optimizer: unsigned always 0. */
  function readProjection(projById, pid, player){
    if (!playerHasNbaTeam(player)) return 0;
    return projFromMap(projById, pid);
  }

  function shortPlayerLabel(p){
    if (!p) return '?';
    const last = p.last_name || p.lastName || '';
    const first = p.first_name || p.firstName || '';
    if (last) return last;
    return playerDisplayName(p, '') || '?';
  }

  /* Provisional OVR for teammates missing from distMap (e.g. undrafted rookies). */
  function competitionOvrForPlayer(pid, p, distMap, opts){
    const id = String(pid);
    const d = distMap && (distMap[id] || distMap[pid]);
    if (d && d.lockOvrProd != null && Number.isFinite(Number(d.lockOvrProd))){
      return Number(d.lockOvrProd);
    }
    if (d && d.lockOvr != null && Number.isFinite(Number(d.lockOvr))){
      return Number(d.lockOvr);
    }
    const options = opts || {};
    const rookieNames = options.rookieNames || rookieNamesFromSnapshot(options.twoKSnapshot);
    const isRookie = isRookiePlayer(p, id, {
      rookieIds: options.rookieIds,
      rookieNames
    });
    const proj = lockProjFromMap(options.projById, id, p);
    if (isRookie){
      const comp = rookieValueFloor(p, null, options.twoKSnapshot);
      const base = blendRookieBase(proj, comp);
      if (base == null) return null;
      return clampRookieOvr(ovrFromSmashBase(base), false);
    }
    if (proj != null){
      const o = ovrFromSmashBase(proj);
      return o != null ? o : null;
    }
    return null;
  }

  function buildNbaTeamIndex(playerDb){
    const byTeam = new Map();
    Object.keys(playerDb || {}).forEach(pid => {
      const p = playerDb[pid];
      if (!isNbaSkater(p)) return;
      const team = String(p.team).toUpperCase();
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push({id: String(pid), p});
    });
    return byTeam;
  }

  /* Pressure from quality teammates at the same depth-chart primary only. */
  function competitionPressure(selfPid, selfP, selfOvr, teammates, strengthOf){
    const selfPrimary = nbaPrimaryPos(selfP);
    const selfDepth = selfP.depth_chart_order != null ? Number(selfP.depth_chart_order) : null;
    let pressure = 0;
    const notes = [];
    (teammates || []).forEach(row => {
      if (!row || String(row.id) === String(selfPid)) return;
      const tp = row.p;
      const overlap = playersCompeteWeight(selfP, tp);
      if (!(overlap > 0)) return;
      const status = String(tp.status || '').toUpperCase();
      const twoWay = status === 'TWO-WAY' || status === 'TWO_WAY';
      const str = strengthOf(row.id, tp);
      if (str == null || !Number.isFinite(str)) return;

      let w = 0;
      if (str >= 90) w = 0.22;
      else if (str >= 85) w = 0.16;
      else if (str >= 80) w = 0.12;
      else if (str >= 74) w = 0.08;
      else if (str >= 68) w = 0.05;
      else if (str >= 62) w = 0.025;
      else w = 0.01;

      const gap = str - selfOvr;
      /* Similar talent at the slot crowds harder; clear underdogs barely register. */
      if (gap >= 12) w *= 1.35;
      else if (gap >= 6) w *= 1.15;
      else if (Math.abs(gap) <= 4) w *= 1.12; /* all-around-the-same-level logjam */
      else if (gap <= -10) w *= 0.28;
      else if (gap <= -5) w *= 0.48;

      const years = yearsExpOfPlayer(tp);
      const tDepth = tp.depth_chart_order != null ? Number(tp.depth_chart_order) : null;
      /* Lottery / undrafted-on-chart rookies still push same-slot vets down. */
      if (years === 0){
        if (tDepth == null || tDepth > 2) w *= 1.2;
        if (str >= 70) w = Math.max(w, 0.10);
      }
      if (tDepth != null && selfDepth != null){
        if (tDepth < selfDepth) w *= 1.2;
        else if (tDepth > selfDepth + 1) w *= 0.42;
        if (tDepth === 1 && selfDepth === 1) w *= 1.12; /* two #1s at same slot */
      }
      if (twoWay) w *= 0.4;

      w *= overlap;
      pressure += w;
      if (w >= 0.075) notes.push(shortPlayerLabel(tp));
    });
    return {pressure, notes: notes.slice(0, 4), primary: selfPrimary};
  }

  /* Clear alpha = depth ≤1 and clearly best at the same primary slot. */
  function isClearAlpha(selfPid, selfOvr, selfP, teammates, strengthOf){
    const selfDepth = selfP.depth_chart_order != null ? Number(selfP.depth_chart_order) : null;
    if (selfDepth != null && selfDepth > 1) return false;
    let bestOther = null;
    (teammates || []).forEach(row => {
      if (!row || String(row.id) === String(selfPid)) return;
      if (!(playersCompeteWeight(selfP, row.p) > 0)) return;
      const str = strengthOf(row.id, row.p);
      if (str == null) return;
      if (bestOther == null || str > bestOther) bestOther = str;
    });
    if (bestOther == null) return true;
    return selfOvr >= bestOther + CLEAR_POS_MARGIN;
  }

  function situationAdjust(pid, p, prodOvr, teamIndex, strengthOf){
    const ovr = Number(prodOvr);
    if (!Number.isFinite(ovr)){
      return {mult: 1, why: '', pressure: 0, notes: [], kind: 'none'};
    }
    if (!isNbaSkater(p)){
      return {
        mult: SIT_FA_MULT,
        why: 'Free agent / no NBA roster ×' + SIT_FA_MULT.toFixed(2),
        pressure: 0,
        notes: [],
        kind: 'fa'
      };
    }
    const team = String(p.team).toUpperCase();
    const teammates = teamIndex.get(team) || [];
    const {pressure, notes} = competitionPressure(pid, p, ovr, teammates, strengthOf);
    const depth = p.depth_chart_order != null ? Number(p.depth_chart_order) : null;
    const alpha = isClearAlpha(pid, ovr, p, teammates, strengthOf);

    let mult = 1;
    let kind = 'neutral';
    /* Uncrowded at your primary = ×1.00 (no ding, no free boost).
       The old +4% "clear usage path" fired for almost every depth-chart #1
       once competition was primary-only, inflating Trade ★ league-wide. */
    if (depth != null && depth >= 4){
      mult *= 0.86;
      kind = 'crowded';
    } else if (depth != null && depth >= 3){
      mult *= 0.91;
      kind = 'crowded';
    }
    if (!(alpha && pressure < 0.18)){
      /* Crowding curve — offseason adds move value without flooring everyone. */
      const damp = 1 - Math.exp(-Math.max(0, pressure) * 1.05);
      mult *= 1 - damp * 0.28;
      if (damp >= 0.28 || (depth != null && depth >= 3)) kind = 'crowded';
    } else if (kind === 'neutral' && pressure > 0 && alpha){
      /* Clearly best at a contested primary — note only, no Trade boost. */
      kind = 'alpha';
    }
    mult = Math.max(SIT_MULT_MIN, Math.min(SIT_MULT_MAX, mult));
    mult = Math.round(mult * 1000) / 1000;

    let why = '';
    if (kind === 'alpha' && mult === 1){
      why = 'Clear primary path';
    } else if (kind === 'crowded' || mult < 0.97){
      why = 'Roster competition'
        + (notes.length ? ' (' + notes.join(', ') + ')' : '')
        + ' ×' + mult.toFixed(2);
    } else if (mult !== 1){
      why = 'Situation ×' + mult.toFixed(2);
    }
    return {mult, why, pressure, notes, kind};
  }

  function applySituationToLockOvr(prodOvr, sitMult){
    const o = Number(prodOvr);
    const m = Number(sitMult);
    if (!Number.isFinite(o)) return null;
    if (!Number.isFinite(m) || m === 1) return Math.round(o);
    const blended = 1 + (m - 1) * LOCK_SIT_BLEND;
    const n = Math.round(o * blended);
    return Math.max(LOCK_OVR_FLOOR, Math.min(LOCK_OVR_CEIL, n));
  }

  function posRoleWord(slot){
    const s = String(slot || '').toUpperCase();
    if (s === 'PG') return 'point guard';
    if (s === 'SG') return 'shooting guard';
    if (s === 'SF') return 'wing';
    if (s === 'PF') return 'power forward';
    if (s === 'C') return 'center';
    if (s === 'G') return 'guard';
    if (s === 'F') return 'forward';
    return s ? s.toLowerCase() : 'rotation piece';
  }

  function articleFor(word){
    return /^[aeiou]/i.test(String(word || '')) ? 'an' : 'a';
  }

  /*
   * Sleeper sometimes stamps two teammates as the same depth_chart_order.
   * Break ties by Lock OVR so Role never lists two at the identical NBA spot.
   * playerDb: full Sleeper map. distByPid optional. pids optional filter.
   */
  function buildEffectiveNbaDepthOrders(playerDb, distByPid, pids){
    const groups = new Map();
    const idList = pids && pids.length
      ? pids.map(String)
      : Object.keys(playerDb || {});
    idList.forEach(pid => {
      const id = String(pid);
      const p = (playerDb || {})[id] || (playerDb || {})[pid] || {};
      if (!playerHasNbaTeam(p)) return;
      if (p.status === 'FA' || p.status === 'Inactive') return;
      const slot = p.depth_chart_position
        || ((p.fantasy_positions || [])[0])
        || null;
      if (!slot) return;
      const key = String(p.team).toUpperCase() + '|' + String(slot).toUpperCase();
      if (!groups.has(key)) groups.set(key, []);
      const dist = distByPid && (distByPid[id] || distByPid[pid]);
      const lockOvr = dist && dist.lockOvr != null ? Number(dist.lockOvr) : null;
      const order = p.depth_chart_order != null ? Number(p.depth_chart_order) : null;
      groups.get(key).push({id, order, lockOvr});
    });
    const effective = Object.create(null);
    groups.forEach(list => {
      list.sort((a, b) => {
        const ao = Number.isFinite(a.order) ? a.order : 999;
        const bo = Number.isFinite(b.order) ? b.order : 999;
        if (ao !== bo) return ao - bo;
        const al = Number.isFinite(a.lockOvr) ? a.lockOvr : -1;
        const bl = Number.isFinite(b.lockOvr) ? b.lockOvr : -1;
        if (bl !== al) return bl - al;
        return String(a.id).localeCompare(String(b.id));
      });
      list.forEach((row, i) => {
        effective[row.id] = i + 1;
      });
    });
    return effective;
  }

  /* Plain-English NBA role. player = Sleeper player obj; dist = lock row. */
  function nbaRoleSentence(player, dist, opts){
    const options = opts || {};
    const p = player || {};
    const team = p.team || null;
    const rawOrder = p.depth_chart_order != null ? Number(p.depth_chart_order) : null;
    const effectiveOrder = options.effectiveOrder;
    const order = effectiveOrder != null && Number.isFinite(Number(effectiveOrder))
      ? Number(effectiveOrder)
      : rawOrder;
    const slot = p.depth_chart_position
      || ((p.fantasy_positions || p.fantasyPositions || [])[0])
      || options.fallbackPos
      || null;
    const slotWord = posRoleWord(slot);
    const injury = String(p.injury_status || p.injuryStatus || '').toUpperCase();
    const years = yearsExpOfPlayer(p);
    const ovr = dist && dist.lockOvr != null ? Number(dist.lockOvr) : null;
    const tier = dist && (dist.lockTier || dist.lockTierKey) ? (dist.lockTier || dist.lockTierKey) : null;

    if (injury === 'O' || injury === 'OUT'){
      return team
        ? ('Out for ' + team + ' — NBA role on pause.')
        : 'Currently out — NBA role on pause.';
    }
    if (injury === 'IR' || injury === 'SUS'){
      return team
        ? ('On IR/suspension for ' + team + ' — not in the active mix.')
        : 'On IR/suspension — not in the active mix.';
    }

    if (isRetiredPlayer(p) || String(p.status || '').toUpperCase() === 'RET'){
      return 'Retired — dynasty value is 0.';
    }

    if (!playerHasNbaTeam(p) || p.status === 'FA' || p.status === 'Inactive'){
      if (years === 0) return 'Rookie still waiting on a settled NBA roster role.';
      return 'Free agent — no current NBA team role.';
    }

    let core = '';
    if (order === 1){
      if (tier === 'mvp' || tier === 'superstar' || (ovr != null && ovr >= 90)){
        core = 'Franchise centerpiece at ' + slot + ' for ' + team + '.';
      } else if (tier === 'allstar' || (ovr != null && ovr >= 85)){
        core = 'Featured starter at ' + slot + ' for ' + team + '.';
      } else if (ovr != null && ovr >= 78){
        core = 'Everyday starter at ' + slot + ' for ' + team + '.';
      } else {
        core = 'Listed as the starting ' + slotWord + ' for ' + team + '.';
      }
    } else if (order === 2){
      if (ovr != null && ovr >= 78){
        core = 'High-impact backup / sixth-man type at ' + slot + ' for ' + team + '.';
      } else if (ovr != null && ovr >= 70){
        core = 'Primary backup ' + slotWord + ' for ' + team + '.';
      } else {
        core = 'Second on the ' + slot + ' depth chart for ' + team + '.';
      }
    } else if (order === 3){
      core = 'Rotation ' + slotWord + ' for ' + team + ' — third string on the depth chart.';
    } else if (order != null && order >= 4){
      core = 'Deep bench / situational minutes at ' + slot + ' for ' + team + '.';
    } else if (years === 0){
      core = 'Rookie on ' + team + ' — NBA role still taking shape.';
    } else if (ovr != null && ovr >= 78){
      core = 'Important piece for ' + team + ', though the depth chart listing is unclear.';
    } else if (ovr != null && ovr >= 65){
      core = 'On ' + team + '\'s roster as ' + articleFor(slotWord) + ' ' + slotWord + ' with an undefined depth role.';
    } else {
      core = 'End-of-roster / fringe piece for ' + team + '.';
    }

    if (injury === 'DTD'){
      return core.replace(/\.$/, '') + ' (day-to-day).';
    }
    return core;
  }

  function projFromMap(projById, pid){
    if (!projById) return null;
    const key = String(pid);
    if (typeof projById.get === 'function'){
      const v = Number(projById.get(key));
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const v = Number(projById[key]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /* Lock blend input: unsigned players contribute no upcoming proj (null),
     while UI/optimizer still show projectionForPlayer → 0. */
  function lockProjFromMap(projById, pid, player){
    if (isRetiredPlayer(player)) return null;
    if (!playerHasNbaTeam(player)) return null;
    return projFromMap(projById, pid);
  }

  /* Mutates each dist with lockBase / lockOvr / lockTier / tradeScore / tradeStars.
     OVR is smash (multi-season blend for non-rookies) or rookie proj+comp.
     Trade stars layer age + injury + contract + potential + franchise situation. */
  function attachLockValues(distMap, opts){
    const options = opts || {};
    const playerDb = options.playerDb || {};
    const projById = options.projById || null;
    const priorDistMap = options.priorDistMap || null;
    const rookieNames = options.rookieNames || rookieNamesFromSnapshot(options.twoKSnapshot);
    const skipSituation = options.skipSituation === true;
    let count = 0;

    /* Pass 1: production Lock OVR (no situation yet). */
    Object.keys(distMap || {}).forEach(pid => {
      const d = distMap[pid];
      if (!d) return;
      const p = playerDb[pid] || playerDb[String(pid)] || {};
      if (isRetiredPlayer(p)){
        zeroRetiredLockValues(d);
        return;
      }
      const isRookie = isRookiePlayer(p, pid, {
        rookieIds: options.rookieIds,
        rookieNames
      });
      const proj = lockProjFromMap(projById, pid, p);
      const peakComp = isRookie ? rookieCompPeak(p) : null;
      const earlyComp = isRookie ? rookieCompFloor(p) : null;
      const rankFloor = isRookie ? rookieRankFloor(p, null, options.twoKSnapshot) : null;
      const comp = isRookie ? rookieValueFloor(p, null, options.twoKSnapshot) : null;
      const earlyMult = isRookie ? rookieEarlyCareerMult(rookieOutlookRow(p)) : null;
      const thin = !(d.n >= MIN_SAMPLES_FOR_SMASH);
      const yearsExp = yearsExpOfPlayer(p);
      const priorD = priorDistMap
        ? (priorDistMap[pid] || priorDistMap[String(pid)] || null)
        : null;

      let base = null;
      let baseSource = null;
      let blendInfo = null;
      if (isRookie){
        base = blendRookieBase(proj, comp);
        if (base != null){
          if (proj != null && earlyComp != null) baseSource = 'rookie-proj-early';
          else if (proj != null && rankFloor != null) baseSource = 'rookie-proj-rank';
          else if (earlyComp != null && rankFloor != null && comp === rankFloor && earlyComp < rankFloor){
            baseSource = 'rookie-rank-floor';
          } else if (earlyComp != null) baseSource = 'rookie-early-comp';
          else if (rankFloor != null) baseSource = 'rookie-rank';
          else baseSource = 'rookie-proj';
        } else {
          base = smashLockBase(d);
          baseSource = base != null ? 'smash' : null;
        }
      } else {
        /* Vet / sophomore: blend smash bases across seasons + next-year proj. */
        const lastBase = seasonLockInput(d);
        const priorBase = seasonLockInput(priorD);
        const isSoph = yearsExp === 1;
        const parts = isSoph
          ? [
            {key: 'last', w: BLEND_SOPH.last, v: lastBase},
            {key: 'proj', w: BLEND_SOPH.proj, v: proj}
          ]
          : [
            {key: 'last', w: BLEND_VET.last, v: lastBase},
            {key: 'prior', w: BLEND_VET.prior, v: priorBase},
            {key: 'proj', w: BLEND_VET.proj, v: proj}
          ];
        blendInfo = blendWeightedBase(parts);
        if (blendInfo){
          base = blendInfo.base;
          baseSource = blendSourceLabel(isSoph, blendInfo);
        } else if (thin && proj != null){
          base = proj;
          baseSource = 'proj';
        } else {
          base = smashLockBase(d);
          baseSource = base != null ? 'smash' : null;
          if (base == null && proj != null){
            base = proj;
            baseSource = 'proj';
          }
        }
      }
      if (base == null || !Number.isFinite(base)){
        d.lockBase = null;
        d.lockOvr = null;
        d.lockOvrProd = null;
        d.lockTier = null;
        d.lockTierLabel = null;
        d.lockScore = null;
        d.lockStars = null;
        d.lockPct = null;
        d.tradeScore = null;
        d.tradeStars = null;
        d.lockBlend = null;
        d.tradeSituationMult = null;
        d.tradeSituationNote = null;
        d.tradePotentialMult = null;
        d.tradePotentialNote = null;
        d.tradePotentialKind = null;
        d.rookieComp = comp;
        d.rookieCompPeak = peakComp;
        d.rookieEarlyMult = earlyMult;
        d.rookieRankFloor = rankFloor;
        attachSmashGrade(d);
        return;
      }

      const rawOvr = ovrFromSmashBase(base);
      const prodOvr = isRookie ? clampRookieOvr(rawOvr, !thin) : rawOvr;
      const band = lockAgeBand(p.age, isRookie);

      d.lockBase = base;
      d.lockBaseSource = baseSource;
      d.lockBlend = blendInfo
        ? {
          yearsExp,
          parts: blendInfo.parts,
          priorSeason: options.priorStatsSeason || null
        }
        : null;
      d.lockAgeBand = band;
      d.lockOvrProd = prodOvr;
      d.lockOvr = prodOvr; /* overwritten in pass 2 when situation applies */
      d.lockStars = null;
      d.lockPct = null;
      d.rookieComp = comp;
      d.rookieCompPeak = peakComp;
      d.rookieEarlyMult = earlyMult;
      d.rookieRankFloor = rankFloor;
      d.rookieProj = proj;
      d.rookieOvrCapped = isRookie && thin && rawOvr > ROOKIE_LOCK_OVR_CAP;
      d._lockMeta = {isRookie, band, p, thin, rawOvr};
      attachSmashGrade(d);
      count++;
    });

    const teamIndex = skipSituation ? null : buildNbaTeamIndex(playerDb);
    const strengthOpts = {
      projById,
      rookieIds: options.rookieIds,
      rookieNames,
      twoKSnapshot: options.twoKSnapshot
    };
    const strengthOf = (id, pl) => competitionOvrForPlayer(id, pl, distMap, strengthOpts);

    /* Pass 2: franchise situation → Lock damp + Trade mult. */
    Object.keys(distMap || {}).forEach(pid => {
      const d = distMap[pid];
      if (!d || d.lockOvrProd == null) return;
      if (d.lockOvrRetired) return;
      const meta = d._lockMeta || {};
      const p = meta.p || playerDb[pid] || playerDb[String(pid)] || {};
      if (isRetiredPlayer(p)){
        zeroRetiredLockValues(d);
        return;
      }
      const isRookie = !!meta.isRookie;
      const band = meta.band || lockAgeBand(p.age, isRookie);
      const prodOvr = Number(d.lockOvrProd);
      const injuryStatus = p.injury_status || p.injuryStatus || '';

      let sit = {mult: 1, why: '', pressure: 0, notes: [], kind: 'none'};
      if (!skipSituation && teamIndex){
        sit = situationAdjust(pid, p, prodOvr, teamIndex, strengthOf);
      }

      /* No NBA team → Lock floor. Nothing to lock-in until they sign. */
      const unsigned = !playerHasNbaTeam(p);
      let ovr = unsigned
        ? LOCK_OVR_FLOOR
        : applySituationToLockOvr(prodOvr, sit.mult);
      if (unsigned){
        sit = {
          mult: sit.mult != null ? sit.mult : SIT_FA_MULT,
          why: 'Unsigned — Lock floored at ' + LOCK_OVR_FLOOR + ' until signed',
          pressure: sit.pressure || 0,
          notes: sit.notes || [],
          kind: 'fa'
        };
      }
      const tier = lockOvrTier(ovr);
      const displayName = playerDisplayName(p, pid);
      const contractAdj = contractTradeAdjust(displayName, ovr);
      const tradeBaseOvr = unsigned ? LOCK_OVR_FLOOR : prodOvr;
      const injOpts = {
        ignoreInjuryStatus: options.ignoreInjuryStatus,
        offseason: options.offseason
      };
      const proneMult = injuryProneMult(displayName);
      const statusMult = injuryStatusMult(injuryStatus, injOpts);
      const injuryMult = proneMult * statusMult;
      const priorD = priorDistMap
        ? (priorDistMap[pid] || priorDistMap[String(pid)] || null)
        : null;
      const proj = lockProjFromMap(projById, pid, p);
      const pot = potentialTradeAdjust({
        ageBand: band,
        age: p.age,
        isRookie: isRookie,
        ovr: tradeBaseOvr,
        mean: d.mean,
        ceiling: d.ceiling,
        stdev: d.stdev,
        n: d.n,
        hits: d.hits,
        lockBase: d.lockBase,
        proj: proj,
        lastBase: seasonLockInput(d),
        priorBase: seasonLockInput(priorD),
        outlookRow: isRookie ? rookieOutlookRow(p) : null
      });
      const tradeScore = tradeScoreFromOvr(tradeBaseOvr, {
        ageBand: band,
        age: p.age,
        isRookie,
        name: displayName,
        injuryStatus,
        injuryMult,
        ignoreInjuryStatus: options.ignoreInjuryStatus,
        offseason: options.offseason,
        contractMult: contractAdj.mult,
        situationMult: sit.mult,
        potentialMult: pot.mult
      });
      const tradeStars = tradeStarsFromScore(tradeScore);

      d.lockOvr = ovr;
      d.lockOvrUnsignedFloor = unsigned;
      d.lockTier = tier.key;
      d.lockTierLabel = tier.label;
      d.lockScore = ovr;
      d.tradeScore = tradeScore;
      d.tradeStars = tradeStars;
      d.tradeAgeMult = AGE_MULT[band] || 1.0;
      d.tradeInjuryMult = injuryMult;
      d.tradeInjuryProneMult = proneMult;
      d.tradeInjuryStatusMult = statusMult;
      d.tradeContractMult = contractAdj.mult;
      d.tradeContractNote = contractAdj.why || null;
      d.tradePotentialMult = pot.mult;
      d.tradePotentialNote = pot.why || null;
      d.tradePotentialKind = pot.kind || null;
      d.tradeSituationMult = sit.mult;
      d.tradeSituationNote = sit.why || null;
      d.tradeSituationKind = sit.kind || null;
      d.tradeSituationPressure = sit.pressure != null
        ? Math.round(sit.pressure * 1000) / 1000
        : null;
      d.contractTier = (contractAdj.profile && contractAdj.profile.tier)
        || (contractAdj.profile && contractAdj.profile.recentDeal ? 'mid' : null);
      d.contractBuyout = !!(contractAdj.why && /buyout/i.test(contractAdj.why));
      delete d._lockMeta;
    });
    return count;
  }

  /* Same as attachLockValues, yielding between player batches for HQ nav. */
  async function attachLockValuesAsync(distMap, opts){
    await yieldToMain();
    const n = attachLockValues(distMap, opts);
    await yieldToMain();
    return n;
  }

  function seedDistEntry(distMap, pid, seed, source){
    const id = String(pid);
    if (distMap[id] || distMap[pid]) return false;
    if (seed == null || !Number.isFinite(Number(seed))) return false;
    const v = Number(seed);
    distMap[id] = {
      n: 0, mean: v, sampleMean: v, stdev: 0, ceiling: v,
      hits: {}, normalHits: {}, marks: DEFAULT_MARKS.slice(),
      samples: [], seasonAvg: null, seasonGp: null, avgSource: source || 'proj',
      projOnly: true
    };
    return true;
  }

  /* Fetch one season's smash dist map (season totals + game samples).
     Prefers ESPN box-score snapshot; falls back to Sleeper weekly rows. */
  async function loadSeasonDistMap(statsSeason, scoring, fetchImpl, marks){
    const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!statsSeason) throw new Error('statsSeason required');
    if (!fetchFn) throw new Error('fetch unavailable');
    const useMarks = marks && marks.length ? marks : DEFAULT_MARKS;
    const scoreSettings = scoring || {};

    try { await ensureGamelogsLoaded(); }
    catch (e) { /* fall back to Sleeper weekly samples */ }

    await yieldToMain();
    const boxPack = await buildSamplesFromGamelogsAsync(String(statsSeason), scoreSettings);
    await yieldToMain();
    const usingBox = !!(boxPack && boxPack.samplesByPlayer
      && Object.keys(boxPack.samplesByPlayer).length);

    let seasonStats = null;
    let weeklyResults = [];
    let samplesByPlayer;
    let weeksFound = 0;
    let sampleSource = 'weekly';
    let per30ByPlayer = {};
    let per36ByPlayer = {};
    let mpgByPlayer = {};
    let fpPerMinByPlayer = {};

    if (usingBox){
      seasonStats = await fetchFn('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
      samplesByPlayer = boxPack.samplesByPlayer;
      per30ByPlayer = boxPack.per30ByPlayer || {};
      per36ByPlayer = boxPack.per36ByPlayer || {};
      mpgByPlayer = boxPack.mpgByPlayer || {};
      fpPerMinByPlayer = boxPack.fpPerMinByPlayer || {};
      weeksFound = Object.keys(samplesByPlayer).reduce((m, pid) => Math.max(m, samplesByPlayer[pid].length), 0);
      sampleSource = 'boxscore';
    } else {
      const weeks = Array.from({length: 25}, (_, i) => i + 1);
      const pack = await Promise.all([
        fetchFn('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null),
        ...weeks.map(w =>
          fetchFn('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason + '/' + w)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      ]);
      seasonStats = pack[0];
      weeklyResults = pack.slice(1);
      weeksFound = weeklyResults.filter(w => w && Object.keys(w).length > 0).length;
      samplesByPlayer = buildSamplesByPlayer(weeklyResults, scoreSettings);
      sampleSource = 'weekly';
    }

    await yieldToMain();
    const seasonAvgByPid = seasonStats ? buildSeasonAvgMap(seasonStats, scoreSettings) : {};
    const distMap = buildDistMap(samplesByPlayer, useMarks, seasonAvgByPid);
    const distPids = Object.keys(distMap);
    for (let i = 0; i < distPids.length; i++){
      const pid = distPids[i];
      const p30 = per30ByPlayer[pid];
      if (p30 != null && Number.isFinite(p30)) distMap[pid].avgPer30 = p30;
      const p36 = per36ByPlayer[pid];
      if (p36 != null && Number.isFinite(p36)) distMap[pid].avgPer36 = p36;
      const mpg = mpgByPlayer[pid];
      if (mpg != null && Number.isFinite(mpg)) distMap[pid].avgMpg = mpg;
      const fpm = fpPerMinByPlayer[pid];
      if (fpm != null && Number.isFinite(fpm)){
        distMap[pid].avgFpPerMin = fpm;
        distMap[pid].fpPerMinGrade = fpPerMinGrade(fpm);
      }
      if ((i + 1) % 80 === 0) await yieldToMain();
    }
    return {
      distMap,
      statsSeason: String(statsSeason),
      weeksFound,
      sampleSource,
      gamesFound: weeksFound,
      seasonAvgCount: Object.keys(seasonAvgByPid).length
    };
  }

  /* Fetch season totals + weekly samples, score under league settings, attach
     Lock OVR + Trade stars. Shared by Intel / Trade Analyzer / later surfaces.
     Also loads statsSeason-1 for the vet 60/20/20 blend when available. */
  async function fetchLockValueIndex(opts){
    const options = opts || {};
    const scoring = options.scoring || {};
    const statsSeason = options.statsSeason;
    const playerDb = options.playerDb || {};
    const projById = options.projById || null;
    const playerIds = options.playerIds || [];
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!statsSeason) throw new Error('statsSeason required');
    if (!fetchImpl) throw new Error('fetch unavailable');

    const rookieNames = options.rookieNames || rookieNamesFromSnapshot(options.twoKSnapshot);
    const matchedRookieIds = matchRookieIdsByName(playerDb, rookieNames);
    const rookieIds = new Set(matchedRookieIds);
    (options.rookieIds || []).forEach(id => rookieIds.add(String(id)));

    const priorSeasonNum = Number(statsSeason) - 1;
    const priorSeason = Number.isFinite(priorSeasonNum) && priorSeasonNum >= 2015
      ? String(priorSeasonNum)
      : null;
    const skipPrior = options.skipPriorSeason === true || !priorSeason;

    /* Sequential seasons (not Promise.all) so yields between them keep HQ clickable. */
    return withHeavyLock(async function(){
      const primary = await loadSeasonDistMap(statsSeason, scoring, fetchImpl);
      await yieldToMain();
      const priorPack = skipPrior
        ? null
        : await loadSeasonDistMap(priorSeason, scoring, fetchImpl).catch(() => null);
      await yieldToMain();

      const distMap = primary.distMap;
      const priorDistMap = priorPack && priorPack.weeksFound
        ? priorPack.distMap
        : null;

      const seedIds = new Set([...playerIds, ...rookieIds].map(String));
      if (projById && playerDb) zeroUnsignedProjections(projById, playerDb);
      let seeded = 0;
      seedIds.forEach(id => {
        if (distMap[id]) return;
        const p = playerDb[id] || playerDb[String(id)] || {};
        const proj = lockProjFromMap(projById, id, p);
        const rookie = isRookiePlayer(p, id, {rookieIds, rookieNames});
        const earlyComp = rookie ? rookieCompFloor(p) : null;
        const rankFloor = rookie ? rookieRankFloor(p, null, options.twoKSnapshot) : null;
        const comp = rookie ? rookieValueFloor(p, null, options.twoKSnapshot) : null;
        /* Unsigned: no upcoming proj seed (UI shows 0 via zeroUnsignedProjections). */
        const seed = !playerHasNbaTeam(p)
          ? null
          : (rookie ? blendRookieBase(proj, comp) : proj);
        let source = 'proj';
        if (rookie){
          if (proj != null && earlyComp != null) source = 'rookie-proj-early';
          else if (proj != null && rankFloor != null) source = 'rookie-proj-rank';
          else if (earlyComp != null && rankFloor != null && comp === rankFloor && earlyComp < rankFloor){
            source = 'rookie-rank-floor';
          } else if (earlyComp != null) source = 'rookie-early-comp';
          else if (rankFloor != null) source = 'rookie-rank';
          else source = 'proj';
        }
        if (seedDistEntry(distMap, id, seed, source)) seeded++;
      });
      await yieldToMain();

      const scored = await attachLockValuesAsync(distMap, {
        playerDb, projById, rookieIds, rookieNames,
        twoKSnapshot: options.twoKSnapshot,
        priorDistMap,
        priorStatsSeason: priorDistMap ? priorSeason : null
      });
      return {
        distMap,
        priorDistMap,
        statsSeason: primary.statsSeason,
        priorStatsSeason: priorDistMap ? priorSeason : null,
        weeksFound: primary.weeksFound,
        priorWeeksFound: priorPack ? priorPack.weeksFound : 0,
        sampleSource: primary.sampleSource || 'weekly',
        scored,
        seasonAvgCount: primary.seasonAvgCount,
        rookieSeeded: [...rookieIds].filter(id => distMap[id] && distMap[id].projOnly).length
      };
    });
  }

  /* Absolute FP/min letter grades (Patio Boys scoring). Not curved.
     ~1.00+ star rate · ~0.85 solid starter · ~0.75 average · below 0.75 soft drop floor. */
  const FP_PER_MIN_BANDS = [
    {min: 1.20, grade: 'A+'},
    {min: 1.10, grade: 'A'},
    {min: 1.00, grade: 'A-'},
    {min: 0.95, grade: 'B+'},
    {min: 0.90, grade: 'B'},
    {min: 0.85, grade: 'B-'},
    {min: 0.80, grade: 'C+'},
    {min: 0.75, grade: 'C'},
    {min: 0.70, grade: 'C-'},
    {min: 0.65, grade: 'D+'},
    {min: 0.60, grade: 'D'},
    {min: 0.55, grade: 'D-'},
    {min: 0, grade: 'F'}
  ];
  const FPM_ELITE = 1.00;
  const FPM_SOLID = 0.85;
  /* Soft drop floor: below C-rate (~0.75) when already off-chart / otherwise aligned. */
  const FPM_POOR = 0.75;
  const FPM_DEAD = 0.55;
  const FPM_EDGE = 0.08;
  const FPM_MIN_SAMPLES = 10;

  function fpPerMinGrade(rate){
    if (rate == null || rate === '') return null;
    const x = Number(rate);
    if (!Number.isFinite(x) || x < 0) return null;
    for (let i = 0; i < FP_PER_MIN_BANDS.length; i++){
      if (x >= FP_PER_MIN_BANDS[i].min) return FP_PER_MIN_BANDS[i].grade;
    }
    return 'F';
  }
  function fpPerMinGradeClass(grade){
    const map = {
      'A+': 'grade-ap', A: 'grade-a', 'A-': 'grade-am',
      'B+': 'grade-bp', B: 'grade-b', 'B-': 'grade-bm',
      'C+': 'grade-cp', C: 'grade-c', 'C-': 'grade-cm',
      'D+': 'grade-dp', D: 'grade-d', 'D-': 'grade-dm',
      F: 'grade-f'
    };
    return map[grade] || 'grade-pending';
  }

  function smashGradeClass(grade){
    return fpPerMinGradeClass(grade);
  }

  function readFpPerMin(dist){
    if (!dist) return null;
    const rate = Number(dist.avgFpPerMin);
    if (!Number.isFinite(rate) || rate < 0) return null;
    const n = Number(dist.n);
    if (Number.isFinite(n) && n > 0 && n < FPM_MIN_SAMPLES) return null;
    return rate;
  }

  function formatFpPerMin(rate){
    const x = Number(rate);
    if (!Number.isFinite(x)) return '';
    const g = fpPerMinGrade(x);
    return 'FP/m ' + x.toFixed(2) + (g ? (' (' + g + ')') : '');
  }

  /* Absolute Max Points barometer: score/500 → traditional school letter.
     100% = A+ territory · 90% = A- · 80% = B- · 70% = C- · 60% = D- · below = F.
     Grades are NOT curved vs the league. */
  const MAX_POINTS_BAROMETER = 500;
  function letterFromPct(pct){
    const p = Number(pct);
    if (!Number.isFinite(p)) return 'F';
    const x = p <= 1 ? p * 100 : p; /* accept 0–1 or 0–100 */
    if (x >= 97) return 'A+';
    if (x >= 93) return 'A';
    if (x >= 90) return 'A-';
    if (x >= 87) return 'B+';
    if (x >= 83) return 'B';
    if (x >= 80) return 'B-';
    if (x >= 77) return 'C+';
    if (x >= 73) return 'C';
    if (x >= 70) return 'C-';
    if (x >= 67) return 'D+';
    if (x >= 63) return 'D';
    if (x >= 60) return 'D-';
    return 'F';
  }
  function maxPointsPct(score, barometer){
    const bar = Number(barometer) > 0 ? Number(barometer) : MAX_POINTS_BAROMETER;
    const s = Number(score);
    if (!Number.isFinite(s) || !(bar > 0)) return 0;
    return Math.max(0, Math.min(1, s / bar));
  }
  function maxPointsGrade(score, barometer){
    return letterFromPct(maxPointsPct(score, barometer));
  }

  global.LockInDist = {
    DEFAULT_MARKS,
    LOCK_SLOTS,
    SMASH_WEIGHTS,
    MIN_SAMPLES_FOR_SMASH,
    BLEND_VET,
    BLEND_SOPH,
    LOCK_OVR_FLOOR,
    LOCK_OVR_CEIL,
    LOCK_OVR_ANCHORS,
    TRADE_STAR_BANDS,
    MAX_POINTS_BAROMETER,
    FP_PER_MIN_BANDS,
    FPM_ELITE,
    FPM_SOLID,
    FPM_POOR,
    FPM_DEAD,
    FPM_EDGE,
    FPM_MIN_SAMPLES,
    fpPerMinGrade,
    fpPerMinGradeClass,
    readFpPerMin,
    formatFpPerMin,
    LOCK_SIT_BLEND,
    SIT_MULT_MIN,
    SIT_MULT_MAX,
    SIT_FA_MULT,
    AGE_MULT,
    POTENTIAL_YOUNG_MAX,
    POTENTIAL_EARLY_PRIME_MAX,
    POTENTIAL_EARLY_PRIME_AGE,
    POTENTIAL_DECLINE_RELIEF,
    ROOKIE_PROJ_W,
    ROOKIE_COMP_W,
    ROOKIE_EARLY_CAREER_MULT,
    ROOKIE_LOCK_OVR_CAP,
    ROOKIE_RANK_BASE,
    ESPN_ROOKIE_OUTLOOK,
    letterFromPct,
    maxPointsPct,
    maxPointsGrade,
    normalCdf,
    normalHitRate,
    empiricalHitRate,
    scoreGame,
    buildSeasonAvgMap,
    buildSamplesByPlayer,
    buildSamplesFromGamelogs,
    buildSamplesFromGamelogsAsync,
    rowFromGamelogFields,
    gamelogSnapshot,
    yieldToMain,
    withHeavyLock,
    playerDist,
    buildDistMap,
    expectedLocks,
    simulateFill,
    teamLockInSummary,
    smashHitScore,
    smashLockBase,
    smashParts,
    smashGradeFromBase,
    smashGradeClass,
    attachSmashGrade,
    SMASH_GRADE_BANDS,
    seasonLockInput,
    blendWeightedBase,
    blendSourceLabel,
    yearsExpOfPlayer,
    normalizePlayerName,
    playerNameKeys,
    sleeperPlayerName,
    rookieNamesFromSnapshot,
    rookieOutlookRow,
    rookieEarlyCareerMult,
    rookieCompPeak,
    rookieRankByName,
    rookieRankFloor,
    rookieCompFloor,
    rookieValueFloor,
    blendRookieBase,
    clampRookieOvr,
    isRookiePlayer,
    matchRookieIdsByName,
    lockAgeBand,
    isNbaOffseason,
    INJURY_PRONE,
    injuryStatusMult,
    injuryProneMult,
    injuryTradeMult,
    ovrFromSmashBase,
    ovrFromPercentile,
    lockOvrTier,
    starsFromPercentile,
    clampTradeStars,
    formatStars,
    formatStarsHtml,
    tradeStarsFromScore,
    tradeScoreFromOvr,
    potentialFlashSignal,
    potentialDurabilitySignal,
    potentialTradeAdjust,
    fantasyPosSet,
    isNbaSkater,
    playerHasNbaTeam,
    isRetiredPlayer,
    projectionForPlayer,
    zeroUnsignedProjections,
    readProjection,
    lockProjFromMap,
    projFromMap,
    positionsCompete,
    nbaPrimaryPos,
    positionOverlapWeight,
    playersCompeteWeight,
    competitionOvrForPlayer,
    buildNbaTeamIndex,
    competitionPressure,
    situationAdjust,
    applySituationToLockOvr,
    posRoleWord,
    articleFor,
    buildEffectiveNbaDepthOrders,
    nbaRoleSentence,
    attachLockValues,
    attachLockValuesAsync,
    loadSeasonDistMap,
    fetchLockValueIndex,
    ensureGamelogsLoaded,
    gamelogSnapshot
  };
})(window);
