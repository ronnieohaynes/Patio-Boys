/* Lock-in distribution model for Patio Boys.
   Sleeper's NBA "weekly" stats rows behave like single-game lines (~one sample
   per fantasy week). Lock-in weeks sum 10 chosen game scores into starter spots,
   so per-game μ / σ / hit-rates are the right unit — not weekly totals. */
(function(global){
  'use strict';

  const DEFAULT_MARKS = [30, 40, 50];
  const LOCK_SLOTS = 10;

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

  /* Score one Sleeper stats row under league settings.
     Applies 40/50-pt bonuses and 3PM when Sleeper omits those derived fields.
     If the row includes gp (season totals), returns FP per game. */
  function scoreGame(obj, scoring){
    if (!obj || !scoring) return null;
    const keys = Object.keys(scoring);
    let total = 0;
    let matched = 0;
    keys.forEach(k => {
      if (obj[k] != null){
        total += Number(obj[k]) * Number(scoring[k]);
        matched++;
      }
    });

    const pts = Number(obj.pts);
    if (scoring.bonus_pt_40p != null && obj.bonus_pt_40p == null && Number.isFinite(pts) && pts >= 40){
      total += Number(scoring.bonus_pt_40p);
      matched++;
    }
    if (scoring.bonus_pt_50p != null && obj.bonus_pt_50p == null && Number.isFinite(pts) && pts >= 50){
      total += Number(scoring.bonus_pt_50p);
      matched++;
    }
    if (scoring.tpm != null && obj.tpm == null){
      let tpm = obj.fg3m;
      if (tpm == null && obj.tpa != null && obj.tpmi != null) tpm = Number(obj.tpa) - Number(obj.tpmi);
      if (tpm != null){
        total += Number(tpm) * Number(scoring.tpm);
        matched++;
      }
    }

    if (matched === 0) return null;
    const gp = Number(obj.gp || obj.games_played || 0);
    return gp > 0 ? total / gp : total;
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
     Raw smash base = 0.40·Avg + 0.30·Ceil + 0.30·(40·P≥40 + 50·P≥50)
     Rookies / thin samples fall back to projected FP/G.
     Lock OVR maps smash base → 50–99 on an ABSOLUTE curve (not pool
     percentile — percentile vs all NBA stuffed every roster guy into the 90s).
     Age / injury stay off OVR — those belong on Trade stars later. */
  const SMASH_WEIGHTS = { avg: 0.40, ceil: 0.30, hit: 0.30 };
  const MIN_SAMPLES_FOR_SMASH = 5;
  const LOCK_OVR_FLOOR = 50;
  const LOCK_OVR_CEIL = 99;
  const AGE_MULT = { young: 1.12, prime: 1.04, decline: 0.8, unknown: 0.95 };

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

  function lockAgeBand(age, isRookie){
    const a = Number(age);
    if (!Number.isFinite(a) || a <= 0) return isRookie ? 'young' : 'unknown';
    if (a < 24) return 'young';
    if (a <= 32) return 'prime';
    return 'decline';
  }

  function injuryStatusMult(status){
    const s = String(status || '').toLowerCase();
    if (s === 'out' || s === 'ir' || s === 'injured reserve') return 0.94;
    if (s === 'doubtful') return 0.96;
    if (s === 'questionable') return 0.98;
    return 1;
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

  function formatStars(n){
    const stars = Math.max(1, Math.min(5, Math.round(Number(n) || 1)));
    return '★'.repeat(stars) + '☆'.repeat(5 - stars);
  }

  /* Absolute tradeScore → stars (2K trade-finder style). */
  const TRADE_STAR_BANDS = [
    {min: 95, stars: 5},
    {min: 85, stars: 4},
    {min: 75, stars: 3},
    {min: 65, stars: 2},
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

  /* tradeScore = LockOVR × age × injury (+1 young bump). */
  function tradeScoreFromOvr(ovr, meta){
    const o = Number(ovr);
    if (!Number.isFinite(o)) return null;
    const info = meta || {};
    const band = info.ageBand || lockAgeBand(info.age, info.isRookie);
    const am = AGE_MULT[band] || 0.95;
    const im = injuryStatusMult(info.injuryStatus);
    let score = o * am * im;
    if (band === 'young') score += 1;
    return score;
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

  /* Mutates each dist with lockBase / lockOvr / lockTier / tradeScore / tradeStars.
     OVR is pure smash; Trade stars layer age + injury on top. */
  function attachLockValues(distMap, opts){
    const options = opts || {};
    const playerDb = options.playerDb || {};
    const projById = options.projById || null;
    let count = 0;

    Object.keys(distMap || {}).forEach(pid => {
      const d = distMap[pid];
      if (!d) return;
      const p = playerDb[pid] || playerDb[String(pid)] || {};
      const yearsExp = Number(p.years_exp);
      const isRookie = yearsExp === 0 || options.rookieIds && options.rookieIds.has(String(pid));
      const proj = projFromMap(projById, pid);
      const thin = !(d.n >= MIN_SAMPLES_FOR_SMASH);

      let base = null;
      let baseSource = null;
      if ((isRookie || thin) && proj != null){
        base = proj;
        baseSource = isRookie ? 'rookie-proj' : 'proj';
      } else {
        base = smashLockBase(d);
        baseSource = 'smash';
        if (base == null && proj != null){
          base = proj;
          baseSource = 'proj';
        }
      }
      if (base == null || !Number.isFinite(base)){
        d.lockBase = null;
        d.lockOvr = null;
        d.lockTier = null;
        d.lockTierLabel = null;
        d.lockScore = null;
        d.lockStars = null;
        d.lockPct = null;
        d.tradeScore = null;
        d.tradeStars = null;
        return;
      }

      const ovr = ovrFromSmashBase(base);
      const tier = lockOvrTier(ovr);
      const band = lockAgeBand(p.age, isRookie);
      const injuryStatus = p.injury_status || p.injuryStatus || '';
      const tradeScore = tradeScoreFromOvr(ovr, {
        ageBand: band,
        age: p.age,
        isRookie,
        injuryStatus
      });
      const tradeStars = tradeStarsFromScore(tradeScore);

      d.lockBase = base;
      d.lockBaseSource = baseSource;
      d.lockAgeBand = band;
      d.lockOvr = ovr;
      d.lockTier = tier.key;
      d.lockTierLabel = tier.label;
      d.lockScore = ovr;
      d.lockStars = null;
      d.lockPct = null;
      d.tradeScore = tradeScore;
      d.tradeStars = tradeStars;
      d.tradeAgeMult = AGE_MULT[band] || 0.95;
      d.tradeInjuryMult = injuryStatusMult(injuryStatus);
      count++;
    });
    return count;
  }

  /* Fetch season totals + weekly samples, score under league settings, attach
     Lock OVR + Trade stars. Shared by Intel / Trade Analyzer / later surfaces. */
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

    const weeks = Array.from({length: 25}, (_, i) => i + 1);
    const [seasonStats, ...weeklyResults] = await Promise.all([
      fetchImpl('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null),
      ...weeks.map(w =>
        fetchImpl('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason + '/' + w)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    ]);
    const weeksFound = weeklyResults.filter(w => w && Object.keys(w).length > 0).length;
    const samplesByPlayer = buildSamplesByPlayer(weeklyResults, scoring);
    const seasonAvgByPid = seasonStats ? buildSeasonAvgMap(seasonStats, scoring) : {};
    const distMap = buildDistMap(samplesByPlayer, DEFAULT_MARKS, seasonAvgByPid);

    playerIds.forEach(pid => {
      const id = String(pid);
      if (distMap[id] || distMap[pid]) return;
      const proj = projFromMap(projById, id);
      if (proj == null) return;
      distMap[id] = {
        n: 0, mean: proj, sampleMean: proj, stdev: 0, ceiling: proj,
        hits: {}, normalHits: {}, marks: DEFAULT_MARKS.slice(),
        samples: [], seasonAvg: null, seasonGp: null, avgSource: 'proj',
        projOnly: true
      };
    });

    const scored = attachLockValues(distMap, {playerDb, projById});
    return {
      distMap,
      statsSeason,
      weeksFound,
      scored,
      seasonAvgCount: Object.keys(seasonAvgByPid).length
    };
  }

  global.LockInDist = {
    DEFAULT_MARKS,
    LOCK_SLOTS,
    SMASH_WEIGHTS,
    MIN_SAMPLES_FOR_SMASH,
    LOCK_OVR_FLOOR,
    LOCK_OVR_CEIL,
    LOCK_OVR_ANCHORS,
    TRADE_STAR_BANDS,
    AGE_MULT,
    normalCdf,
    normalHitRate,
    empiricalHitRate,
    scoreGame,
    buildSeasonAvgMap,
    buildSamplesByPlayer,
    playerDist,
    buildDistMap,
    expectedLocks,
    simulateFill,
    teamLockInSummary,
    smashHitScore,
    smashLockBase,
    lockAgeBand,
    injuryStatusMult,
    ovrFromSmashBase,
    ovrFromPercentile,
    lockOvrTier,
    starsFromPercentile,
    formatStars,
    tradeStarsFromScore,
    tradeScoreFromOvr,
    attachLockValues,
    fetchLockValueIndex
  };
})(window);
