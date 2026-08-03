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
     Applies 40/50-pt bonuses and 3PM when Sleeper omits those derived fields. */
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
    const gp = obj.gp || obj.games_played || null;
    return gp && gp > 0 ? total / gp : total;
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

  function playerDist(samples, marks){
    const arr = (samples || []).filter(v => Number.isFinite(v));
    const markList = marks || DEFAULT_MARKS;
    if (!arr.length) return null;
    const n = arr.length;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
    const stdev = Math.sqrt(variance);
    const ceiling = mean + stdev;
    const hits = {};
    const normalHits = {};
    markList.forEach(m => {
      hits[m] = empiricalHitRate(arr, m);
      normalHits[m] = normalHitRate(mean, stdev, m);
    });
    return {n, mean, stdev, ceiling, samples: arr, hits, normalHits, marks: markList};
  }

  function buildDistMap(samplesByPlayer, marks){
    const out = {};
    Object.keys(samplesByPlayer || {}).forEach(pid => {
      const d = playerDist(samplesByPlayer[pid], marks);
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
      .sort((a, b) => b.ceiling - a.ceiling);
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

  global.LockInDist = {
    DEFAULT_MARKS,
    LOCK_SLOTS,
    normalCdf,
    normalHitRate,
    empiricalHitRate,
    scoreGame,
    buildSamplesByPlayer,
    playerDist,
    buildDistMap,
    expectedLocks,
    simulateFill,
    teamLockInSummary
  };
})(window);
