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
  /* Taxi is for near-term upside: path to rosterable Lock OVR within ~2 years. */
  const TAXI_ROSTER_OVR = 75;
  const TAXI_DEV_SOFT_CAP = 4; /* more than ~3–4 dilutes roster potential */
  const TAXI_DEV_IDEAL = 3;
  const TAXI_DEV_HORIZON = 2;

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

  function yearsExpOf(player){
    if (player == null || typeof player !== 'object') return null;
    const y = player.yearsExp != null ? player.yearsExp : player.years_exp;
    const n = Number(y);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /* Prefer real Lock OVR; tradeScore is on a similar smash scale when Lock is missing. */
  function inferLockOvr(player){
    if (!player || typeof player !== 'object') return null;
    if (player.lockOvr != null && Number.isFinite(Number(player.lockOvr))) return Number(player.lockOvr);
    if (player.tradeScore != null && Number.isFinite(Number(player.tradeScore))) return Number(player.tradeScore);
    return null;
  }

  /* Expected Lock climb over the next season — higher early, flattens by year 3. */
  function taxiGrowthPerSeason(player){
    const y = yearsExpOf(player);
    const isRookie = !!(player && (player.isRookie || player.source === 'rookie' || y === 0));
    if (isRookie || y == null || y <= 0) return 10;
    if (y === 1) return 7;
    if (y === 2) return 4;
    return 2;
  }

  /*
   * Taxi stash quality: not rosterable yet (< 75 Lock), but projected to clear
   * 75 within the next ~2 years. Already-ready players belong on the active roster.
   * Blocked NBA situations (crowded wings / FA) are not stashes — no path to value.
   */
  function taxiDevEval(player, opts){
    const options = opts || {};
    const taxiYears = options.taxiYears != null ? Number(options.taxiYears) : DEFAULT_TAXI_YEARS;
    const target = options.targetOvr != null ? Number(options.targetOvr) : TAXI_ROSTER_OVR;
    const horizon = options.horizon != null ? Number(options.horizon) : TAXI_DEV_HORIZON;
    const eligible = taxiEligible(player, taxiYears);
    const ovr = inferLockOvr(player);
    const y = yearsExpOf(player);
    const age = player && player.age != null ? Number(player.age) : null;
    const tradeStars = player && player.tradeStars != null ? Number(player.tradeStars) : null;
    const metric = player && player.metric != null ? Number(player.metric) : null;
    const isRookie = !!(player && (player.isRookie || player.source === 'rookie' || y === 0));
    const sitMult = player && player.situationMult != null ? Number(player.situationMult) : null;
    const sitKind = player && player.situationKind ? String(player.situationKind) : '';
    /* FA or hard situation cut (<0.90). Mild "crowded" labels alone are not blocked. */
    const pathBlocked = sitKind === 'fa'
      || (Number.isFinite(sitMult) && sitMult < 0.90);

    if (!eligible){
      return {
        eligible: false,
        readyNow: ovr != null && ovr >= target,
        stashWorthy: false,
        pathBlocked: false,
        currentOvr: ovr,
        projectedOvr: ovr,
        targetOvr: target,
        score: 0,
        why: 'Not taxi-eligible'
      };
    }

    const readyNow = ovr != null && ovr >= target;
    let projected = ovr;
    if (ovr != null){
      projected = ovr + taxiGrowthPerSeason(player) * Math.max(0, horizon);
      if (Number.isFinite(age)){
        if (age >= 26) projected -= 8;
        else if (age >= 24) projected -= 3;
        else if (age > 0 && age <= 21) projected += 3;
      }
      if (Number.isFinite(tradeStars)){
        if (tradeStars >= 3.5) projected += 8;
        else if (tradeStars >= 2.5) projected += 6;
        else if (tradeStars <= 1) projected -= 4;
      }
      /* Crowded / FA situations don't grow into rosterable Lock. */
      if (pathBlocked && Number.isFinite(sitMult)){
        projected -= Math.max(6, (0.95 - sitMult) * 55);
      } else if (pathBlocked){
        projected -= 12;
      }
    }

    /* No Lock yet — only stash if early-career signals point at a rosterable path. */
    const speculative = ovr == null && (isRookie || (y != null && y <= 1)) && (
      (Number.isFinite(tradeStars) && tradeStars >= 2.5)
      || (Number.isFinite(metric) && metric >= 12)
      || (Number.isFinite(age) && age > 0 && age <= 22 && Number.isFinite(metric) && metric >= 8)
    );
    if (ovr == null && speculative){
      projected = target + (Number.isFinite(tradeStars) ? tradeStars * 2 : 2);
      if (pathBlocked) projected -= 14;
    }

    let pathToRoster = !readyNow && projected != null && projected >= target;
    let stashWorthy = !readyNow && (pathToRoster || speculative);
    if (pathBlocked){
      pathToRoster = false;
      stashWorthy = false;
    }

    let score = 0;
    let why = 'No clear path to ' + target + ' Lock in ' + horizon + 'y';
    if (readyNow){
      why = 'Already rosterable (Lock ' + Math.round(ovr) + ') — keep active';
      score = -50;
    } else if (pathBlocked){
      why = sitKind === 'fa'
        ? 'No NBA roster — not a stash'
        : ('Blocked NBA path'
          + (Number.isFinite(sitMult) ? (' · situation ×' + sitMult.toFixed(2)) : '')
          + ' — no route to minutes/value');
      score = Math.max(0, (projected != null ? projected : 40) - 55);
    } else if (stashWorthy){
      const cur = ovr != null ? Math.round(ovr) : null;
      const proj = projected != null ? Math.round(projected) : null;
      why = cur != null
        ? ('Path to rosterable · Lock ' + cur + ' → ~' + proj + ' in ' + horizon + 'y')
        : ('Early upside stash · projects past ' + target + ' Lock');
      score = (projected || target) + (ovr != null ? ovr * 0.35 : 10);
      if (y != null && y <= 0) score += 10;
      else if (y === 1) score += 5;
      if (Number.isFinite(age) && age > 0 && age <= 21) score += 4;
      /* Prefer closer developmental bets (60–74) over raw lottery tickets. */
      if (ovr != null && ovr >= 60 && ovr < target) score += 12;
      else if (ovr != null && ovr >= 50 && ovr < 60) score += 4;
      else if (ovr != null && ovr < 45) score -= 8;
    } else if (ovr != null){
      why = 'Projects ~' + Math.round(projected) + ' Lock — below ' + target + ' roster bar';
      score = Math.max(0, projected - 40);
    }

    return {
      eligible: true,
      readyNow,
      stashWorthy,
      pathBlocked,
      currentOvr: ovr,
      projectedOvr: projected,
      targetOvr: target,
      score,
      why
    };
  }

  /* Count developmental stashes already on the roster (taxi + active). */
  function countTaxiDevStashes(players, opts){
    const list = Array.isArray(players) ? players : [];
    let n = 0;
    list.forEach(p => {
      if (!p) return;
      const ev = taxiDevEval(p, opts);
      if (ev.stashWorthy) n++;
    });
    return n;
  }

  function taxiDevCapacity(devCount, opts){
    const soft = (opts && opts.softCap != null) ? Number(opts.softCap) : TAXI_DEV_SOFT_CAP;
    const ideal = (opts && opts.ideal != null) ? Number(opts.ideal) : TAXI_DEV_IDEAL;
    const n = Math.max(0, Number(devCount) || 0);
    return {
      count: n,
      ideal,
      softCap: soft,
      atIdeal: n >= ideal,
      overCap: n >= soft,
      openIdeal: Math.max(0, ideal - n),
      note: n >= soft
        ? (n + ' developmental stashes — over soft cap (' + soft + '); roster potential thins')
        : (n >= ideal
          ? (n + ' developmental stashes — at capacity (~' + ideal + '–' + soft + ' ideal)')
          : (n + '/' + soft + ' developmental taxi stashes'))
    };
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

  /* ---- Recent good NBA contracts (Spotrac FA snapshot) ---- */
  function normContractName(name){
    return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.\u2019']/g, '')
      /* Sleeper often drops Jr/Sr/II/III (Wendell Carter vs Wendell Carter Jr.). */
      .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function contractsSnapshot(){
    return global.NBA_CONTRACTS_SNAPSHOT || null;
  }

  function contractsIndex(){
    const snap = contractsSnapshot();
    if (!snap) return null;
    if (snap._index) return snap._index;
    const deals = Object.create(null);
    const salaries = Object.create(null);
    const buyouts = Object.create(null);
    function indexRow(map, row, preferNewer){
      if (!row) return;
      const primary = normContractName(row.name) || row.key;
      if (!primary) return;
      const prev = map[primary];
      if (!prev || (preferNewer && preferNewer(prev, row))) map[primary] = row;
      /* Keep raw snapshot key as an alias when it differs (legacy jr keys). */
      if (row.key && row.key !== primary && !map[row.key]) map[row.key] = map[primary];
    }
    (snap.deals || []).forEach(d => {
      indexRow(deals, d, (prev, next) =>
        Number(next.faYear) > Number(prev.faYear)
        || (Number(next.faYear) === Number(prev.faYear) && Number(next.aav) > Number(prev.aav)));
    });
    (snap.salaries || []).forEach(s => {
      indexRow(salaries, s, null);
    });
    (snap.buyouts || []).forEach(b => {
      indexRow(buyouts, b, (prev, next) => Number(next.season) >= Number(prev.season || 0));
    });
    snap._index = {deals, salaries, buyouts, snap};
    return snap._index;
  }

  function contractsByKey(){
    const idx = contractsIndex();
    return idx ? idx.deals : null;
  }

  function fmtMoneyShort(n){
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 10e6 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  /*
   * Protect players an NBA team just paid — usually a bad fantasy cut/drop
   * even when Lock/Trade looks soft. Window defaults to 2 FA-class years.
   */
  function recentGoodContract(playerOrName, opts){
    const options = opts || {};
    const map = contractsByKey();
    if (!map) return null;
    const name = (playerOrName && typeof playerOrName === 'object')
      ? (playerOrName.name || playerOrName.full_name || '')
      : playerOrName;
    const key = normContractName(name);
    if (!key) return null;
    const deal = map[key];
    if (!deal) return null;
    const snap = contractsSnapshot() || {};
    const asOf = options.asOfYear != null ? Number(options.asOfYear)
      : (snap.asOfYear != null ? Number(snap.asOfYear) : new Date().getUTCFullYear());
    const protectYears = options.protectYears != null ? Number(options.protectYears)
      : (snap.protectYears != null ? Number(snap.protectYears) : 2);
    const faYear = Number(deal.faYear);
    if (!Number.isFinite(faYear) || !Number.isFinite(asOf)) return null;
    const age = asOf - faYear;
    if (age < 0 || age > protectYears) return null;
    const aavTxt = fmtMoneyShort(deal.aav);
    const why = (aavTxt ? aavTxt + '/yr' : 'Paid deal')
      + (deal.years ? ' · ' + deal.years + 'y' : '')
      + ' (' + faYear + ' FA)';
    return {
      deal,
      faYear,
      yearsAgo: age,
      aav: deal.aav,
      years: deal.years,
      why,
      note: 'Recent good NBA deal — usually keep'
    };
  }

  /*
   * Continuous Trade ★ contract slider from annual salary.
   * Near-min → short leash (sub-1.0). MLE-ish → neutral. Max-ish → paid bump.
   * Soften the low-end haircut when Lock shows they're actually producing.
   */
  const CONTRACT_SLIDER = {
    loSal: 2.5e6,
    midSal: 10e6,
    hiSal: 45e6,
    loMult: 0.92,
    midMult: 1.0,
    hiMult: 1.065
  };

  function clamp01(x){
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function lerp(a, b, t){
    return a + (b - a) * t;
  }

  function contractSalaryMult(salary, opts){
    const options = opts || {};
    const y1 = Number(salary);
    if (!Number.isFinite(y1) || y1 <= 0) return 1;
    const cfg = CONTRACT_SLIDER;
    const s = Math.max(1e5, y1);
    let mult;
    if (s <= cfg.midSal){
      const t = clamp01(
        (Math.log(s) - Math.log(cfg.loSal)) / (Math.log(cfg.midSal) - Math.log(cfg.loSal))
      );
      mult = lerp(cfg.loMult, cfg.midMult, t);
    } else {
      const t = clamp01(
        (Math.log(s) - Math.log(cfg.midSal)) / (Math.log(cfg.hiSal) - Math.log(cfg.midSal))
      );
      mult = lerp(cfg.midMult, cfg.hiMult, t);
    }
    /* Producing on a short leash → don't punish as hard. */
    const ovr = options.lockOvr != null ? Number(options.lockOvr) : null;
    if (mult < 1 && Number.isFinite(ovr)){
      const prod = clamp01((ovr - 60) / 25);
      mult = lerp(mult, 1, prod * 0.7);
    }
    return Math.round(mult * 1000) / 1000;
  }

  function contractAnnualSalary(salaryRow, recentDeal){
    if (salaryRow && salaryRow.y1 != null && Number.isFinite(Number(salaryRow.y1))){
      return Number(salaryRow.y1);
    }
    if (recentDeal && recentDeal.aav != null && Number.isFinite(Number(recentDeal.aav))){
      return Number(recentDeal.aav);
    }
    return null;
  }

  /*
   * Contract profile for Trade ★ — continuous salary slider, plus buyout ding.
   */
  function contractProfile(playerOrName, opts){
    const options = opts || {};
    const idx = contractsIndex();
    if (!idx) return null;
    const name = (playerOrName && typeof playerOrName === 'object')
      ? (playerOrName.name || playerOrName.full_name || playerOrName.fullName || '')
      : playerOrName;
    const key = normContractName(name);
    if (!key) return null;

    const snap = idx.snap || {};
    const asOf = options.asOfYear != null ? Number(options.asOfYear)
      : (snap.asOfYear != null ? Number(snap.asOfYear) : new Date().getUTCFullYear());
    const buyoutYears = options.buyoutYears != null ? Number(options.buyoutYears) : 2;
    const ovr = options.lockOvr != null ? Number(options.lockOvr) : null;

    const salary = idx.salaries[key] || null;
    const buyout = idx.buyouts[key] || null;
    const recent = recentGoodContract(name, options);
    const buyoutFresh = !!(buyout && Number.isFinite(Number(buyout.season))
      && (asOf - Number(buyout.season)) <= buyoutYears);

    const annual = contractAnnualSalary(salary, recent);
    const tier = salary && salary.tier ? salary.tier : null;
    let tradeMult = annual != null ? contractSalaryMult(annual, {lockOvr: ovr}) : 1;
    const bits = [];

    if (annual != null){
      const dir = tradeMult >= 1.01 ? 'paid confidence'
        : (tradeMult <= 0.98 ? 'short leash' : 'neutral');
      bits.push(fmtMoneyShort(annual) + '/yr slider ×' + tradeMult.toFixed(3)
        + (dir !== 'neutral' ? ' · ' + dir : ''));
    }

    if (buyoutFresh){
      /* Buyout is its own signal — team walked away from the money. */
      tradeMult = Math.round(tradeMult * 0.90 * 1000) / 1000;
      bits.push('Buyout/waive ' + buyout.season
        + (buyout.status === 'unsigned' ? ' (still unsigned)' : ''));
    }

    if (tradeMult === 1 && annual == null && !buyoutFresh) return null;
    return {
      key,
      tier,
      y1: annual,
      yearsLeft: salary ? salary.yearsLeft : null,
      buyout: buyoutFresh ? buyout : null,
      recentDeal: recent,
      tradeMult,
      slider: annual != null,
      why: bits.join(' · ') || (tier ? ('Contract tier: ' + tier) : '')
    };
  }

  function contractTradeMult(playerOrName, opts){
    const profile = contractProfile(playerOrName, opts);
    return profile && profile.tradeMult != null ? profile.tradeMult : 1;
  }

  /* Years remaining + total $ for Basic Dynasty “4yr / 188.4M” cells. */
  function contractTerms(playerOrName, opts){
    const options = opts || {};
    const idx = contractsIndex();
    if (!idx) return null;
    const name = (playerOrName && typeof playerOrName === 'object')
      ? (playerOrName.name || playerOrName.full_name || playerOrName.fullName || '')
      : playerOrName;
    const key = normContractName(name);
    if (!key) return null;
    const salary = idx.salaries[key] || null;
    const recent = recentGoodContract(name, options);
    const deal = (idx.deals && idx.deals[key]) || (recent && recent.deal) || null;
    const years = salary && salary.yearsLeft != null && Number.isFinite(Number(salary.yearsLeft))
      ? Number(salary.yearsLeft)
      : (deal && deal.years != null && Number.isFinite(Number(deal.years)) ? Number(deal.years) : null);
    let total = null;
    if (salary && salary.guaranteed != null && Number.isFinite(Number(salary.guaranteed))
      && Number(salary.guaranteed) > 0){
      total = Number(salary.guaranteed);
    } else if (years != null && salary && salary.y1 != null && Number.isFinite(Number(salary.y1))){
      total = years * Number(salary.y1);
    } else if (deal && deal.total != null && Number.isFinite(Number(deal.total))){
      total = Number(deal.total);
    }
    const y1 = contractAnnualSalary(salary, recent || (deal ? {aav: deal.aav} : null));
    if (years == null && total == null && y1 == null) return null;
    return {
      key,
      years,
      total,
      y1,
      team: salary && salary.team ? salary.team : null,
      source: (salary && salary.source) || (deal && deal.source) || null
    };
  }

  /* Round dollars to the hundred-thousand → "188.4M". */
  function formatContractMillions(dollars){
    const n = Number(dollars);
    if (!Number.isFinite(n) || n < 0) return null;
    const m = Math.round(n / 1e5) / 10;
    return m.toFixed(1) + 'M';
  }

  function formatContractTerms(playerOrName, opts){
    const terms = contractTerms(playerOrName, opts);
    if (!terms) return null;
    const mil = terms.total != null ? formatContractMillions(terms.total) : null;
    if (terms.years != null && mil){
      return {
        terms,
        label: terms.years + 'yr / ' + mil,
        sortValue: terms.total
      };
    }
    if (mil) return {terms, label: mil, sortValue: terms.total};
    if (terms.years != null){
      return {terms, label: terms.years + 'yr', sortValue: terms.years};
    }
    return null;
  }

  global.TeamNeedsModel = {
    CORE, NON_STARTING, NON_REGULAR, DEFAULT_TAXI_YEARS,
    TAXI_ROSTER_OVR, TAXI_DEV_SOFT_CAP, TAXI_DEV_IDEAL, TAXI_DEV_HORIZON,
    CONTRACT_SLIDER,
    parseSlots, regularCap, taxiEligible, splitRoster,
    inferLockOvr, taxiGrowthPerSeason, taxiDevEval,
    countTaxiDevStashes, taxiDevCapacity,
    recentGoodContract, contractSalaryMult, contractProfile, contractTradeMult,
    contractTerms, formatContractMillions, formatContractTerms,
    contractsSnapshot,
    positions, eligibleForSlot, slotTier, optimize, candidateGain,
    ageBand, agePressure, youthUpgradeBonus, AGE_BAND_ORDER
  };
})(window);
