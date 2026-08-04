/* Shared lineup-optimization model for Team Intel and Mock Draft.
   Need = marginal gain to the team's OPTIMAL legal starting lineup:
   each player may occupy at most one of the league's starting slots.
   Position age: aging locks (33+) raise need for younger producers at that slot. */
(function(global){
  'use strict';

  const CORE = ['PG','SG','SF','PF','C'];
  const NON_STARTING = new Set(['BN','IR','TAXI','RES','RESERVE','IL']);
  /* IR / taxi sit outside the active 18 (starters + bench). */
  const NON_REGULAR = new Set(['IR','TAXI','RES','RESERVE','IL']);
  const EPS = 1e-7;
  const AGE_BAND_ORDER = { young: 0, prime: 1, unknown: 2, decline: 3 };
  const DEFAULT_TAXI_YEARS = 2; /* Sleeper taxi_years=2 → years_exp 0–2 (< 3 seasons) */

  /* <24 young · 25–32 prime · 33+ decline. Rookies without age count as young. */
  function ageBand(playerOrAge, source){
    const player = (playerOrAge && typeof playerOrAge === 'object') ? playerOrAge : null;
    const a = Number(player ? player.age : playerOrAge);
    const src = source || (player && player.source) || null;
    if (!Number.isFinite(a) || a <= 0) return src === 'rookie' ? 'young' : 'unknown';
    if (a < 24) return 'young';
    if (a <= 32) return 'prime';
    return 'decline';
  }

  /* How urgently a filled (or empty) slot needs younger talent. */
  function agePressure(player){
    if (!player) return 0.55; // empty slot — prefer youth when filling
    const band = ageBand(player);
    if (band === 'decline') return 1.0;
    if (band === 'prime') return 0.28;
    if (band === 'young') return 0;
    return 0.35;
  }

  function parseSlots(rosterPositions){
    return (rosterPositions || [])
      .map(s => String(s || '').toUpperCase())
      .filter(s => s && !NON_STARTING.has(s));
  }

  /* Active roster cap = starters + BN (18 here). Taxi/IR are extra stash slots. */
  function regularCap(rosterPositions){
    return (rosterPositions || [])
      .map(s => String(s || '').toUpperCase())
      .filter(s => s && !NON_REGULAR.has(s)).length;
  }

  /* Sleeper taxi_years is max years_exp allowed on taxi (2 → played < 3 seasons). */
  function taxiEligible(playerOrYears, taxiYears){
    const limit = Number(taxiYears);
    const maxY = Number.isFinite(limit) ? limit : DEFAULT_TAXI_YEARS;
    const raw = (playerOrYears && typeof playerOrYears === 'object')
      ? (playerOrYears.yearsExp != null ? playerOrYears.yearsExp : playerOrYears.years_exp)
      : playerOrYears;
    const y = Number(raw);
    if (!Number.isFinite(y) || y < 0) return false;
    return y <= maxY;
  }

  /* Partition a Sleeper roster. Note: taxi/IR ids are also listed in `players`. */
  function splitRoster(roster, opts){
    const options = opts || {};
    const settings = options.settings || {};
    const positions = options.rosterPositions || [];
    const taxiSlots = Math.max(0, Number(settings.taxi_slots) || 0);
    const reserveSlots = Math.max(0, Number(settings.reserve_slots) || 0);
    const taxiYears = settings.taxi_years != null && Number.isFinite(Number(settings.taxi_years))
      ? Number(settings.taxi_years)
      : DEFAULT_TAXI_YEARS;
    const cap = regularCap(positions);

    const taxiSet = new Set((roster && roster.taxi || []).map(String));
    const reserveSet = new Set((roster && roster.reserve || []).map(String));
    const all = [];
    const seen = new Set();
    [].concat(
      (roster && roster.players) || [],
      (roster && roster.taxi) || [],
      (roster && roster.reserve) || []
    ).forEach(pid => {
      const id = String(pid);
      if (!id || seen.has(id)) return;
      seen.add(id);
      all.push(id);
    });
    const regularIds = all.filter(id => !taxiSet.has(id) && !reserveSet.has(id));
    const taxiIds = all.filter(id => taxiSet.has(id));
    const reserveIds = all.filter(id => reserveSet.has(id));

    return {
      allIds: all,
      regularIds,
      taxiIds,
      reserveIds,
      regularCap: cap,
      regularUsed: regularIds.length,
      regularOpen: Math.max(0, cap - regularIds.length),
      taxiSlots,
      taxiUsed: taxiIds.length,
      taxiOpen: Math.max(0, taxiSlots - taxiIds.length),
      reserveSlots,
      reserveUsed: reserveIds.length,
      reserveOpen: Math.max(0, reserveSlots - reserveIds.length),
      taxiYears,
      taxiEligible: function(p){ return taxiEligible(p, taxiYears); }
    };
  }

  function positions(value){
    const raw = Array.isArray(value) ? value : String(value || '').split('/');
    const out = [];
    raw.forEach(p => {
      const pos = String(p || '').trim().toUpperCase();
      if (CORE.includes(pos) && !out.includes(pos)) out.push(pos);
      if (pos === 'G') ['PG','SG'].forEach(x => { if (!out.includes(x)) out.push(x); });
      if (pos === 'F') ['SF','PF'].forEach(x => { if (!out.includes(x)) out.push(x); });
    });
    return out;
  }

  function eligibleForSlot(slot, poss){
    slot = String(slot || '').toUpperCase();
    if (!poss.length) return false;
    if (slot === 'UTIL' || slot === 'UT') return true;
    if (slot === 'G') return poss.includes('PG') || poss.includes('SG');
    if (slot === 'F') return poss.includes('SF') || poss.includes('PF');
    if (CORE.includes(slot)) return poss.includes(slot);
    return true; // unknown slot names behave as flex
  }

  function metricValue(p){
    const v = Number(p.metric);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  /* Soft FP/G-scale bonus for upgrading an aging/empty lock with younger production.
     Decline candidates get a penalty into age-pressured slots. */
  function youthUpgradeBonus(candidate, displacedPlayer){
    const pressure = agePressure(displacedPlayer);
    if (pressure <= 0) return 0;
    const candBand = ageBand(candidate);
    const factor = candBand === 'young' ? 1
      : candBand === 'prime' ? 0.42
      : candBand === 'decline' ? -0.45
      : 0.22;
    const base = Math.max(metricValue(candidate), 1);
    return pressure * factor * base * 0.2;
  }

  function slotTier(slot){
    slot = String(slot || '').toUpperCase();
    if (CORE.includes(slot)) return 2;
    if (slot === 'G' || slot === 'F') return 1;
    return 0;
  }

  /* Projected points are always primary. Filling legal slots and keeping
     stronger players out of broad utility slots are tie-breakers only. */
  function better(score, filled, preference, oldScore, oldFilled, oldPreference){
    if (score > oldScore + EPS) return true;
    if (oldScore > score + EPS) return false;
    if (filled !== oldFilled) return filled > oldFilled;
    return preference > oldPreference + EPS;
  }

  function sameState(score, filled, preference, oldScore, oldFilled, oldPreference){
    return Math.abs(score - oldScore) <= EPS
      && filled === oldFilled
      && Math.abs(preference - oldPreference) <= EPS;
  }

  /* Max-value assignment of players to slots (each player fills <=1 slot,
     each slot holds <=1 player) via DP over the slot bitmask. */
  function assignmentValue(recs, slotCount, forbidBit){
    const size = 1 << slotCount;
    let scores = new Float64Array(size).fill(-1);
    let filled = new Int16Array(size).fill(-1);
    let preference = new Float64Array(size).fill(-Infinity);
    scores[0] = 0;
    filled[0] = 0;
    preference[0] = 0;
    for (const r of recs){
      const elig = forbidBit == null ? r.mask : (r.mask & ~forbidBit);
      if (!elig) continue;
      const nextScores = Float64Array.from(scores);
      const nextFilled = Int16Array.from(filled);
      const nextPreference = Float64Array.from(preference);
      for (let mask = 0; mask < size; mask++){
        if (scores[mask] < 0) continue;
        let avail = elig & ~mask;
        while (avail){
          const bit = avail & -avail;
          const nm = mask | bit;
          const slotIndex = Math.round(Math.log2(bit));
          const score = scores[mask] + r.v;
          const fill = filled[mask] + 1;
          const pref = preference[mask] + r.v * r.tiers[slotIndex];
          if (better(score, fill, pref, nextScores[nm], nextFilled[nm], nextPreference[nm])){
            nextScores[nm] = score;
            nextFilled[nm] = fill;
            nextPreference[nm] = pref;
          }
          avail ^= bit;
        }
      }
      scores = nextScores;
      filled = nextFilled;
      preference = nextPreference;
    }
    let best = {score:0, filled:0, preference:0};
    for (let mask = 0; mask < size; mask++){
      if (better(scores[mask], filled[mask], preference[mask],
        best.score, best.filled, best.preference)){
        best = {score:scores[mask], filled:filled[mask], preference:preference[mask]};
      }
    }
    return best;
  }

  function optimize(players, slots){
    const slotCount = slots.length;
    const tiers = slots.map(slotTier);
    const recs = (players || []).filter(Boolean).map((p, inputIndex) => {
      const poss = positions(p.positions || p.pos);
      let mask = 0;
      slots.forEach((s, i) => { if (eligibleForSlot(s, poss)) mask |= 1 << i; });
      return {
        p, poss, mask, tiers, inputIndex,
        stableKey:String(p.id || p.name || inputIndex),
        v:metricValue(p),
        hasMetric:Number.isFinite(Number(p.metric))
      };
    }).filter(r => r.mask);
    recs.sort((a, b) => b.v - a.v
      || a.stableKey.localeCompare(b.stableKey)
      || a.inputIndex - b.inputIndex);
    // Only the strongest candidates can appear in an optimal lineup.
    const use = recs.slice(0, Math.max(slotCount * 4, 24));

    const size = 1 << slotCount;
    const scoreLevels = [new Float64Array(size).fill(-1)];
    const fillLevels = [new Int16Array(size).fill(-1)];
    const preferenceLevels = [new Float64Array(size).fill(-Infinity)];
    scoreLevels[0][0] = 0;
    fillLevels[0][0] = 0;
    preferenceLevels[0][0] = 0;
    use.forEach(r => {
      const scores = scoreLevels[scoreLevels.length - 1];
      const filled = fillLevels[fillLevels.length - 1];
      const preference = preferenceLevels[preferenceLevels.length - 1];
      const nextScores = Float64Array.from(scores);
      const nextFilled = Int16Array.from(filled);
      const nextPreference = Float64Array.from(preference);
      for (let mask = 0; mask < size; mask++){
        if (scores[mask] < 0) continue;
        let avail = r.mask & ~mask;
        while (avail){
          const bit = avail & -avail;
          const nm = mask | bit;
          const slotIndex = Math.round(Math.log2(bit));
          const score = scores[mask] + r.v;
          const fill = filled[mask] + 1;
          const pref = preference[mask] + r.v * tiers[slotIndex];
          if (better(score, fill, pref, nextScores[nm], nextFilled[nm], nextPreference[nm])){
            nextScores[nm] = score;
            nextFilled[nm] = fill;
            nextPreference[nm] = pref;
          }
          avail ^= bit;
        }
      }
      scoreLevels.push(nextScores);
      fillLevels.push(nextFilled);
      preferenceLevels.push(nextPreference);
    });

    const finalScores = scoreLevels[scoreLevels.length - 1];
    const finalFilled = fillLevels[fillLevels.length - 1];
    const finalPreference = preferenceLevels[preferenceLevels.length - 1];
    let total = 0, filledCount = 0, preferenceScore = 0, bestMask = 0;
    for (let mask = 0; mask < size; mask++){
      if (better(finalScores[mask], finalFilled[mask], finalPreference[mask],
        total, filledCount, preferenceScore)){
        total = finalScores[mask];
        filledCount = finalFilled[mask];
        preferenceScore = finalPreference[mask];
        bestMask = mask;
      }
    }

    // Backtrack the winning assignment.
    const fills = new Array(slotCount).fill(null);
    let mask = bestMask;
    for (let i = use.length; i >= 1 && mask; i--){
      const curScore = scoreLevels[i][mask];
      const curFilled = fillLevels[i][mask];
      const curPreference = preferenceLevels[i][mask];
      if (sameState(scoreLevels[i - 1][mask], fillLevels[i - 1][mask],
        preferenceLevels[i - 1][mask], curScore, curFilled, curPreference)){
        continue;
      }
      const r = use[i - 1];
      let avail = r.mask & mask;
      while (avail){
        const bit = avail & -avail;
        const prevMask = mask ^ bit;
        const slotIndex = Math.round(Math.log2(bit));
        if (scoreLevels[i - 1][prevMask] >= 0
          && sameState(
            scoreLevels[i - 1][prevMask] + r.v,
            fillLevels[i - 1][prevMask] + 1,
            preferenceLevels[i - 1][prevMask] + r.v * tiers[slotIndex],
            curScore, curFilled, curPreference
          )){
          fills[slotIndex] = {slot:slots[slotIndex], slotIndex, player:r.p, value:r.v, hasMetric:r.hasMetric};
          mask = prevMask;
          break;
        }
        avail ^= bit;
      }
    }

    // Optimal roster-only value with each slot individually removed.
    const withoutSlot = slots.map((_, i) => assignmentValue(use, slotCount, 1 << i));

    return {
      slots, total, fills, withoutSlot, playerCount:recs.length,
      filledCount, preferenceScore
    };
  }

  /* Marginal lineup gain if `candidate` were added to the roster:
     candidate either stays out (gain 0) or takes exactly one slot while the
     roster re-optimizes around it. Position age soft-prefers younger adds
     into aging or empty locks. */
  function candidateGain(candidate, opt){
    const poss = positions(candidate.positions || candidate.pos);
    const v = metricValue(candidate);
    let best = {
      score:opt.total,
      filled:opt.filledCount,
      preference:opt.preferenceScore,
      ageBonus:0,
      slotIndex:-1
    };
    opt.slots.forEach((slot, i) => {
      if (!eligibleForSlot(slot, poss)) return;
      const without = opt.withoutSlot[i];
      const score = v + without.score;
      const filled = 1 + without.filled;
      const displaced = opt.fills[i] ? opt.fills[i].player : null;
      const ageBonus = youthUpgradeBonus(candidate, displaced);
      const preference = v * slotTier(slot) + without.preference + ageBonus;
      if (better(score, filled, preference, best.score, best.filled, best.preference)){
        best = {score, filled, preference, ageBonus, slotIndex:i};
      }
    });
    const gain = Math.max(0, best.score - opt.total);
    const slotIndex = best.slotIndex;
    return {
      gain,
      ageBonus: slotIndex >= 0 ? best.ageBonus : 0,
      slotIndex,
      slot: slotIndex >= 0 ? opt.slots[slotIndex] : null,
      displaced: slotIndex >= 0 ? opt.fills[slotIndex] : null
    };
  }

  global.TeamNeedsModel = {
    CORE, NON_STARTING, NON_REGULAR, DEFAULT_TAXI_YEARS,
    parseSlots, regularCap, taxiEligible, splitRoster,
    positions, eligibleForSlot, slotTier, optimize, candidateGain,
    ageBand, agePressure, youthUpgradeBonus, AGE_BAND_ORDER
  };
})(window);
