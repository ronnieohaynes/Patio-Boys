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

  /* ---- Smash-hunting Lock Value (Intel) ----
     lockBase = 0.40·Avg + 0.30·Ceil + 0.30·(40·P≥40 + 50·P≥50)
     Rookies / thin samples fall back to projected FP/G.
     Then × age × injury. Stars = percentile vs the scored pool. */
  const SMASH_WEIGHTS = { avg: 0.40, ceil: 0.30, hit: 0.30 };
  const MIN_SAMPLES_FOR_SMASH = 5;
  const AGE_MULT = { young: 1.12, prime: 1.04, decline: 0.8, unknown: 0.95 };

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

  /* Mutates each dist with lockBase / lockScore / lockStars / lockPct. */
  function attachLockValues(distMap, opts){
    const options = opts || {};
    const playerDb = options.playerDb || {};
    const projById = options.projById || null;
    const scored = [];

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
        d.lockScore = null;
        d.lockStars = null;
        return;
      }

      const band = lockAgeBand(p.age, isRookie);
      const am = AGE_MULT[band] || 0.95;
      const im = injuryStatusMult(p.injury_status || p.injuryStatus);
      let score = base * am * im;
      if (band === 'young') score += 1;

      d.lockBase = base;
      d.lockBaseSource = baseSource;
      d.lockAgeBand = band;
      d.lockScore = score;
      scored.push({pid, score});
    });

    const sorted = scored.map(s => s.score).sort((a, b) => a - b);
    scored.forEach(({pid, score}) => {
      const d = distMap[pid];
      let lo = 0;
      for (let i = 0; i < sorted.length; i++) if (sorted[i] < score) lo = i + 1;
      const pct = sorted.length <= 1 ? 1 : lo / (sorted.length - 1);
      d.lockPct = pct;
      d.lockStars = starsFromPercentile(pct);
    });
    return scored.length;
  }

  global.LockInDist = {
    DEFAULT_MARKS,
    LOCK_SLOTS,
    SMASH_WEIGHTS,
    MIN_SAMPLES_FOR_SMASH,
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
    starsFromPercentile,
    formatStars,
    attachLockValues
  };
})(window);
