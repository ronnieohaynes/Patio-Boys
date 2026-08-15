/* Patio Boys transaction ledger.
   Fetches completed trades (+ optional waivers/FA) across the league chain,
   resolves drafted picks to players, and grades with Lock OVR / Trade ★
   as of that season (tradeScore-at-time). Fairness uses quality-weighted
   package value (co-cores near full; step-down chips capped) — same model
   as Trade Analyzer. Primary assets more than 10 Trade ★ apart Block unless
   a co-core closes the gap. Package ages 3+ years apart tilt fairness toward
   youth. Future unresolved picks use DraftPickValue (16-keeper fringe).
   Roster-fit uses lockBase (smash FP).
   Pass { tradesOnly: true } to skip adds/drops / waiver grading. */
(function(global){
  'use strict';

  const LEAGUE_ID = '1350649177381552128';
  /* Graded ledger types. Commissioner moves are applied only for roster reconstruction. */
  const GRADE_TYPES = { trade: 1, waiver: 1, free_agent: 1 };
  const STATE_TYPES = { trade: 1, waiver: 1, free_agent: 1, commissioner: 1 };
  const TEAM_COLORS = {
    'Funeral Home':1, 'BoobieDominguez':1, '2011-12 Champs':1,
    'Freakonomics':1, 'Papa Book':1, 'Bam Add the Mayo':1,
    'Hamas':1, 'Belt':1
  };
  const TEAM_ALIASES = {
    '20112012champs':'2011-12 Champs',
    'thehitmanharts':'BoobieDominguez',
    'boobiedominguez':'BoobieDominguez',
    'badgersretirementhome':'Funeral Home',
    'belt':'Belt',
    /* Boobie currently uses this Sleeper team name; was previously aliased to Belt. */
    '5iveonit':'BoobieDominguez',
    'lovecadecountry':'Belt',
    'aliofdan':'Belt',
    'radeka':'Papa Book',
    'oreokidronaldo':'Freakonomics',
    'fadie':'Hamas',
    'addiejarrar':'2011-12 Champs',
    'jsimbulan3':'Bam Add the Mayo',
    'baderalhindi':'Funeral Home'
  };

  function normalizeName(name){
    return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.\u2019']/g, '').replace(/[^a-z0-9]/g, '');
  }
  /* Prefer manager identity — Sleeper team names get reused across franchises. */
  function franchiseKey(teamName, managerName){
    const byMgr = normalizeName(managerName || '');
    if (byMgr && TEAM_ALIASES[byMgr]) return TEAM_ALIASES[byMgr];
    const mgrMatch = byMgr
      ? Object.keys(TEAM_COLORS).find(k => normalizeName(k) === byMgr)
      : null;
    if (mgrMatch) return mgrMatch;
    const norm = normalizeName(teamName);
    if (TEAM_ALIASES[norm]) return TEAM_ALIASES[norm];
    const match = Object.keys(TEAM_COLORS).find(k => normalizeName(k) === norm);
    if (match) return match;
    return teamName || managerName || 'Unknown';
  }
  function playerName(p, pid){
    if (!p) return 'Player ' + pid;
    if (p.full_name) return p.full_name;
    const n = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
    return n || ('Player ' + pid);
  }
  async function fetchJson(url){
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  /* Ratio is smaller haul ÷ larger haul (1.0 = perfectly even). */
  function fairnessGrade(ratio){
    if (ratio >= 0.97) return 'A+';
    if (ratio >= 0.94) return 'A';
    if (ratio >= 0.90) return 'A-';
    if (ratio >= 0.87) return 'B+';
    if (ratio >= 0.84) return 'B';
    if (ratio >= 0.80) return 'B-';
    if (ratio >= 0.77) return 'C+';
    if (ratio >= 0.74) return 'C';
    if (ratio >= 0.70) return 'C-';
    if (ratio >= 0.67) return 'D+';
    if (ratio >= 0.64) return 'D';
    if (ratio >= 0.60) return 'D-';
    return 'F';
  }

  /* Package grading (same model as Trade Analyzer): assets within
     PKG_CORE_RATIO of the primary and ≥ PKG_CORE_FLOOR are co-cores
     (near-full value). Clear step-downs are chips — diminishing weights
     + hard cap so fringe piles cannot manufacture a star. */
  const PKG_CORE_RATIO = 0.82; /* ≥82% of primary → co-core candidate */
  const PKG_CORE_FLOOR = 70; /* co-cores must also clear this Trade ★ */
  const PKG_CORE_WEIGHTS = [1.00, 0.85, 0.70]; /* 1st / 2nd / 3rd+ core */
  const PKG_CHIP_WEIGHTS = [0.40, 0.20, 0.10, 0.08]; /* chips only */
  const PKG_CHIPS_CAP = 0.25; /* chips ≤ 25% of primary */
  const PKG_EXTRAS_CAP = PKG_CHIPS_CAP; /* alias */
  const PKG_PRIMARY_SOFT = 0.78; /* best-vs-best below this → caution */
  const PKG_PRIMARY_GAP = 10; /* |#1 − #1| → caution; block unless co-cores close */
  const PKG_AGE_SOFT = 3; /* value-weighted mean age gap → fairness nudge + caution */
  const PKG_AGE_ADJ_PER_YR = 0.03;
  const PKG_AGE_ADJ_CAP = 0.12;

  function assetPackageScore(a){
    if (!a || a.graded === false) return 0;
    const v = Number(a.dynasty != null ? a.dynasty : a.tradeScore);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function pickAgeProxy(pick){
    /* Undrafted picks have unknown ages — never used for package-age fairness. */
    return null;
  }

  function assetAgeYears(a){
    if (!a || a.graded === false) return null;
    if (a.kind === 'pick' && !a.resolvedPid) return null;
    const age = Number(a.age);
    return Number.isFinite(age) && age > 0 ? age : null;
  }

  function packageValueParts(assets){
    const scored = (assets || []).map(p => ({
      asset: p,
      value: assetPackageScore(p)
    })).filter(x => x.value > 0).sort((a, b) => b.value - a.value);
    const raw = scored.reduce((s, x) => s + x.value, 0);
    if (!scored.length){
      return {
        raw: 0, effective: 0, primary: 0, coresEff: 0, chipsEff: 0,
        extrasRaw: 0, extrasEff: 0, extrasCapped: false,
        coreCount: 0, chipCount: 0, n: 0
      };
    }
    const primary = scored[0].value;
    const cores = [];
    const chips = [];
    scored.forEach((x, i) => {
      const isCore = i === 0
        || (x.value + 1e-9 >= primary * PKG_CORE_RATIO && x.value + 1e-9 >= PKG_CORE_FLOOR);
      if (isCore) cores.push(x);
      else chips.push(x);
    });
    let coresEff = 0;
    cores.forEach((x, i) => {
      const w = PKG_CORE_WEIGHTS[i] != null ? PKG_CORE_WEIGHTS[i] : 0.70;
      coresEff += x.value * w;
    });
    let chipsWeighted = 0;
    chips.forEach((x, i) => {
      const w = PKG_CHIP_WEIGHTS[i] != null ? PKG_CHIP_WEIGHTS[i] : 0.08;
      chipsWeighted += x.value * w;
    });
    const cap = primary * PKG_CHIPS_CAP;
    const chipsCapped = chipsWeighted > cap + 1e-9;
    const chipsEff = Math.min(chipsWeighted, cap);
    const extrasEff = (coresEff - primary) + chipsEff;
    return {
      raw: Math.round(raw * 100) / 100,
      effective: Math.round((coresEff + chipsEff) * 100) / 100,
      primary: Math.round(primary * 100) / 100,
      coresEff: Math.round(coresEff * 100) / 100,
      chipsEff: Math.round(chipsEff * 100) / 100,
      extrasRaw: Math.round((raw - primary) * 100) / 100,
      extrasEff: Math.round(extrasEff * 100) / 100,
      extrasCapped: chipsCapped,
      coreCount: cores.length,
      chipCount: chips.length,
      n: scored.length
    };
  }

  function effectivePackageValue(assets){
    return packageValueParts(assets).effective;
  }

  function packageAgeParts(assets){
    let wSum = 0;
    let aSum = 0;
    let n = 0;
    let primaryAge = null;
    const scored = (assets || []).map(p => ({
      asset: p,
      value: assetPackageScore(p),
      age: assetAgeYears(p)
    })).filter(x => x.value > 0 && x.age != null)
      .sort((a, b) => b.value - a.value);
    scored.forEach((x, i) => {
      wSum += x.value;
      aSum += x.age * x.value;
      n += 1;
      if (i === 0) primaryAge = x.age;
    });
    if (!(wSum > 0) || !n){
      return { mean: null, primaryAge: null, n: 0, weight: 0 };
    }
    return {
      mean: Math.round((aSum / wSum) * 10) / 10,
      primaryAge: primaryAge != null ? Math.round(primaryAge * 10) / 10 : null,
      n,
      weight: Math.round(wSum * 100) / 100
    };
  }

  function ageStructureMult(myMean, otherMean){
    if (!Number.isFinite(myMean) || !Number.isFinite(otherMean)) return 1;
    const gap = otherMean - myMean;
    if (Math.abs(gap) + 1e-9 < PKG_AGE_SOFT) return 1;
    const excess = Math.abs(gap) - (PKG_AGE_SOFT - 1);
    const adj = Math.min(PKG_AGE_ADJ_CAP, excess * PKG_AGE_ADJ_PER_YR);
    return gap > 0 ? (1 + adj) : (1 - adj);
  }

  function ageGapVerdict(ageA, ageB){
    const mA = ageA && ageA.mean != null ? Number(ageA.mean) : null;
    const mB = ageB && ageB.mean != null ? Number(ageB.mean) : null;
    if (!Number.isFinite(mA) || !Number.isFinite(mB)){
      return {
        gap: 0, soft: false, hard: false, meanA: mA, meanB: mB,
        youngSide: null, multA: 1, multB: 1
      };
    }
    const gap = Math.abs(mA - mB);
    const soft = gap + 1e-9 >= PKG_AGE_SOFT;
    const hard = gap + 1e-9 >= PKG_AGE_SOFT + 2;
    return {
      gap: Math.round(gap * 10) / 10,
      soft,
      hard,
      meanA: mA,
      meanB: mB,
      primaryA: ageA.primaryAge,
      primaryB: ageB.primaryAge,
      youngSide: mA === mB ? null : (mA < mB ? 'A' : 'B'),
      multA: ageStructureMult(mA, mB),
      multB: ageStructureMult(mB, mA)
    };
  }

  /* Same primary-gap veto as Trade Analyzer. */
  function primaryGapVerdict(packA, packB){
    const pA = Number(packA && packA.primary) || 0;
    const pB = Number(packB && packB.primary) || 0;
    const gap = Math.abs(pA - pB);
    if (!(gap > PKG_PRIMARY_GAP)){
      return {
        gap: Math.round(gap * 100) / 100,
        soft: false,
        hard: false,
        closedByCore: false,
        leadPrimary: Math.max(pA, pB),
        trailPrimary: Math.min(pA, pB)
      };
    }
    const trail = pA <= pB ? packA : packB;
    const lead = pA <= pB ? packB : packA;
    const trailCores = Number(trail && trail.coresEff != null ? trail.coresEff : trail && trail.primary) || 0;
    const leadPrimary = Number(lead && lead.primary) || 0;
    const hasCoCore = (Number(trail && trail.coreCount) || 0) >= 2;
    const closedByCore = hasCoCore && (leadPrimary - trailCores) <= PKG_PRIMARY_GAP + 1e-9;
    return {
      gap: Math.round(gap * 100) / 100,
      soft: true,
      hard: !closedByCore,
      closedByCore: !!closedByCore,
      leadPrimary: Math.round(leadPrimary * 100) / 100,
      trailPrimary: Math.round(Math.min(pA, pB) * 100) / 100,
      trailCores: Math.round(trailCores * 100) / 100
    };
  }

  /* Roster-fit quality delta → letter (lineup lift + cut/clog adjustments). */
  function netToGrade(net){
    if (net > 10) return 'A+';
    if (net > 6.5) return 'A';
    if (net > 4) return 'B+';
    if (net > 2) return 'B';
    if (net > 0.6) return 'C+';
    if (net > -0.6) return 'C';
    if (net > -2.5) return 'D';
    return 'F';
  }

  function ageAtSeason(p, asOfSeason, currentSeason){
    if (!p) return null;
    const birth = p.birth_date || p.birthdate;
    if (birth){
      const d = new Date(birth);
      if (!isNaN(d.getTime())){
        const asOf = new Date(Number(asOfSeason), 9, 1); /* ~season tip-off */
        let age = asOf.getFullYear() - d.getFullYear();
        const m = asOf.getMonth() - d.getMonth();
        if (m < 0 || (m === 0 && asOf.getDate() < d.getDate())) age--;
        return age;
      }
    }
    const age = Number(p.age);
    if (!Number.isFinite(age)) return null;
    const delta = (Number(currentSeason) || 0) - (Number(asOfSeason) || 0);
    if (!Number.isFinite(delta) || delta <= 0) return age;
    return Math.max(16, age - delta);
  }

  function yearsExpAtSeason(p, asOfSeason, currentSeason){
    const y = Number(p && p.years_exp);
    if (!Number.isFinite(y)) return null;
    const delta = (Number(currentSeason) || 0) - (Number(asOfSeason) || 0);
    if (!Number.isFinite(delta) || delta <= 0) return y;
    return Math.max(0, y - delta);
  }

  /* Age-adjusted player row for at-time grading. Historical seasons drop
     current injury tags (we don't have contemporaneous injury feeds). */
  function playerAtSeason(pid, playerDb, asOfSeason, currentSeason){
    const p = (playerDb && (playerDb[pid] || playerDb[String(pid)])) || {};
    const age = ageAtSeason(p, asOfSeason, currentSeason);
    const yearsExp = yearsExpAtSeason(p, asOfSeason, currentSeason);
    const adjusted = Object.assign({}, p);
    if (age != null) adjusted.age = age;
    if (yearsExp != null) adjusted.years_exp = yearsExp;
    if (String(asOfSeason) !== String(currentSeason)){
      adjusted.injury_status = '';
      adjusted.injuryStatus = '';
    }
    return adjusted;
  }

  /* Asset grade: Trade ★ score (Lock OVR × age × injury) as of that season. */
  function valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason){
    if (!maps || !maps.valueForPid) return 0;
    const id = String(pid);
    const adjusted = playerAtSeason(id, playerDb, asOfSeason, currentSeason);
    const db = Object.create(playerDb || null);
    db[id] = adjusted;
    db[pid] = adjusted;
    const v = maps.valueForPid(id, db);
    return Number.isFinite(v) ? v : 0;
  }

  /* Lineup / cut-clog metric: lockBase smash FP (same ballpark as old dynasty base).
     tradeScore (~50–110) would break netToGrade + clog thresholds. */
  function fitMetricForPidAt(maps, pid, playerDb, asOfSeason, currentSeason){
    if (!maps) return 0;
    const id = String(pid);
    if (typeof maps.fitMetricForPid === 'function'){
      const v = maps.fitMetricForPid(id, playerDb);
      return Number.isFinite(v) ? v : 0;
    }
    return valueForPidAt(maps, id, playerDb, asOfSeason, currentSeason);
  }

  async function walkLeagueChain(startId){
    const seasons = [];
    let id = startId;
    let guard = 0;
    while (id && guard < 8){
      guard++;
      const league = await fetchJson('https://api.sleeper.app/v1/league/' + id);
      const [users, rosters] = await Promise.all([
        fetchJson('https://api.sleeper.app/v1/league/' + id + '/users'),
        fetchJson('https://api.sleeper.app/v1/league/' + id + '/rosters')
      ]);
      const userById = {};
      users.forEach(u => { userById[u.user_id] = u; });
      const rosterMap = {};
      const finalRosters = {};
      rosters.forEach(r => {
        const u = userById[r.owner_id] || {};
        const raw = (u.metadata && u.metadata.team_name) || u.display_name || ('Roster ' + r.roster_id);
        const key = franchiseKey(raw, u.display_name);
        const rid = String(r.roster_id);
        rosterMap[rid] = {
          rosterId: r.roster_id,
          displayName: raw,
          franchise: key,
          manager: u.display_name || '',
          ownerId: r.owner_id || null
        };
        finalRosters[rid] = []
          .concat(r.players || [])
          .concat(r.reserve || [])
          .concat(r.taxi || [])
          .map(String);
      });
      const Needs = global.TeamNeedsModel;
      const slots = Needs && Needs.parseSlots
        ? Needs.parseSlots(league.roster_positions || [])
        : [];
      seasons.push({
        leagueId: String(league.league_id),
        season: String(league.season),
        draftId: league.draft_id || null,
        scoring: league.scoring_settings || {},
        league,
        rosterMap,
        finalRosters,
        slots
      });
      id = league.previous_league_id || null;
    }
    return seasons;
  }

  async function fetchSeasonTransactions(leagueId, typeSet){
    const weekFetches = Array.from({ length: 25 }, (_, i) => i + 1).map(w =>
      fetch('https://api.sleeper.app/v1/league/' + leagueId + '/transactions/' + w)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    );
    const weeks = await Promise.all(weekFetches);
    const out = [];
    weeks.forEach((txns, wi) => {
      if (!Array.isArray(txns)) return;
      txns.forEach(tx => {
        if (!tx || tx.status !== 'complete') return;
        if (!typeSet[tx.type]) return;
        out.push({ ...tx, _week: wi + 1 });
      });
    });
    return out;
  }

  function applyTxnToState(state, tx){
    Object.entries(tx.drops || {}).forEach(([pid, rid]) => {
      const set = state[String(rid)];
      if (set) set.delete(String(pid));
    });
    Object.entries(tx.adds || {}).forEach(([pid, rid]) => {
      const key = String(rid);
      if (!state[key]) state[key] = new Set();
      state[key].add(String(pid));
    });
  }

  function undoTxnOnState(state, tx){
    Object.entries(tx.adds || {}).forEach(([pid, rid]) => {
      const set = state[String(rid)];
      if (set) set.delete(String(pid));
    });
    Object.entries(tx.drops || {}).forEach(([pid, rid]) => {
      const key = String(rid);
      if (!state[key]) state[key] = new Set();
      state[key].add(String(pid));
    });
  }

  function cloneRosterState(state){
    const out = {};
    Object.keys(state).forEach(rid => { out[rid] = [...state[rid]]; });
    return out;
  }

  function buildPreRostersByTxn(seasons, stateTxns){
    const pre = {};
    seasons.forEach(season => {
      const list = stateTxns
        .filter(t => String(t.season) === String(season.season))
        .slice()
        .sort((a, b) => (a.status_updated || 0) - (b.status_updated || 0)
          || String(a.transaction_id).localeCompare(String(b.transaction_id)));
      const state = {};
      Object.keys(season.finalRosters || {}).forEach(rid => {
        state[rid] = new Set(season.finalRosters[rid] || []);
      });
      for (let i = list.length - 1; i >= 0; i--) undoTxnOnState(state, list[i]);
      list.forEach(tx => {
        pre[String(tx.transaction_id)] = cloneRosterState(state);
        applyTxnToState(state, tx);
      });
    });
    return pre;
  }

  function toLineupRecs(pids, maps, playerDb, asOfSeason, currentSeason){
    return (pids || []).map(pid => {
      const id = String(pid);
      const p = (playerDb && playerDb[id]) || {};
      const positions = p.fantasy_positions || [p.position].filter(Boolean);
      return {
        id,
        name: playerName(p, id),
        positions,
        metric: fitMetricForPidAt(maps, id, playerDb, asOfSeason, currentSeason),
        age: ageAtSeason(p, asOfSeason, currentSeason)
      };
    }).filter(r => r.positions && r.positions.length);
  }

  function lineupSnapshot(pids, slots, maps, playerDb, asOfSeason, currentSeason){
    const recs = toLineupRecs(pids, maps, playerDb, asOfSeason, currentSeason);
    const Needs = global.TeamNeedsModel;
    if (!Needs || !Needs.optimize || !slots || !slots.length){
      const total = recs.reduce((s, r) => s + (Number(r.metric) || 0), 0);
      return { total, starterIds: new Set(recs.map(r => r.id)) };
    }
    const opt = Needs.optimize(recs, slots);
    const starterIds = new Set();
    (opt.fills || []).forEach(f => {
      if (f && f.player && f.player.id != null) starterIds.add(String(f.player.id));
    });
    return { total: Number(opt.total) || 0, starterIds };
  }

  /* Roster-context quality: lineup lockBase delta + cut-fat bonus − bench-clog penalty.
     Dropping one of your worst players (roster-rules crunch) is a good move. */
  function rosterQualityDelta(beforePids, adds, drops, slots, maps, playerDb, asOfSeason, currentSeason){
    const before = (beforePids || []).map(String);
    const dropSet = new Set((drops || []).map(String));
    const addList = (adds || []).map(String);
    const after = before.filter(pid => !dropSet.has(pid));
    addList.forEach(pid => { if (!after.includes(pid)) after.push(pid); });

    const beforeL = lineupSnapshot(before, slots, maps, playerDb, asOfSeason, currentSeason);
    const afterL = lineupSnapshot(after, slots, maps, playerDb, asOfSeason, currentSeason);
    let delta = afterL.total - beforeL.total;
    const notes = [];

    const ranked = before.map(pid => ({
      pid: String(pid),
      v: fitMetricForPidAt(maps, pid, playerDb, asOfSeason, currentSeason)
    })).sort((a, b) => a.v - b.v || a.pid.localeCompare(b.pid)); /* worst first */
    const rankByPid = new Map();
    ranked.forEach((row, i) => { rankByPid.set(row.pid, { rank: i, v: row.v }); });
    const n = ranked.length;
    const median = n ? ranked[Math.floor((n - 1) / 2)].v : 0;
    const dropOnly = addList.length === 0 && dropSet.size > 0;

    (drops || []).forEach(pid => {
      const id = String(pid);
      const info = rankByPid.get(id) || {
        rank: n,
        v: fitMetricForPidAt(maps, id, playerDb, asOfSeason, currentSeason)
      };
      const v = info.v;
      const isStarter = beforeL.starterIds.has(id);
      const amongWorst = n > 0 && (info.rank <= 2 || info.rank / n <= 0.25);
      const name = playerName(playerDb[id], id);

      if (amongWorst && !isStarter){
        /* Cutting one of your worst — good hygiene / roster-rules compliance. */
        let bonus = 5.4 - info.rank * 0.55;
        if (dropOnly) bonus += 1.4;
        if (v < median) bonus += 0.4;
        bonus = Math.max(3.4, Math.min(7.5, bonus));
        delta += bonus;
        notes.push('cut worst: ' + name);
      } else if (!isStarter && v <= median){
        delta += dropOnly ? 3.2 : 2.4;
        notes.push('cut fat: ' + name);
      } else if (!isStarter){
        if (v < 22){
          delta += dropOnly ? 1.6 : 0.9;
          notes.push('bench cut: ' + name);
        } else {
          delta -= (v - 22) * 0.1;
          notes.push('cut stash: ' + name);
        }
      } else if (amongWorst){
        /* Weak "starter" on a thin roster — still a sensible cut. */
        delta += dropOnly ? 2.4 : 1.5;
        notes.push('cut weak starter: ' + name);
      }
    });

    (adds || []).forEach(pid => {
      const id = String(pid);
      const v = fitMetricForPidAt(maps, id, playerDb, asOfSeason, currentSeason);
      if (afterL.starterIds.has(id)){
        notes.push('lineup add: ' + playerName(playerDb[id], id));
      } else if (v < 12){
        delta -= (12 - v) * 0.22;
        notes.push('clog: ' + playerName(playerDb[id], id));
      } else {
        delta += Math.min(1.4, (v - 12) * 0.05);
        notes.push('depth: ' + playerName(playerDb[id], id));
      }
    });

    return {
      delta,
      beforeTotal: beforeL.total,
      afterTotal: afterL.total,
      notes
    };
  }

  async function buildPickResolver(seasons, rawTxns){
    const seasonDraftIds = {};
    seasons.forEach(s => {
      if (s.season && s.draftId) seasonDraftIds[String(s.season)] = s.draftId;
    });
    rawTxns.forEach(tx => {
      (tx.draft_picks || []).forEach(pk => {
        const s = String(pk.season || '');
        if (s && seasonDraftIds[s] == null) seasonDraftIds[s] = null;
      });
    });
    /* Fill missing season → draft_id via chain (already in seasons) + any future seasons on picks. */
    for (const season of Object.keys(seasonDraftIds)){
      if (seasonDraftIds[season]) continue;
      const hit = seasons.find(s => String(s.season) === season);
      if (hit && hit.draftId) seasonDraftIds[season] = hit.draftId;
    }

    const draftPickByOrig = {};
    await Promise.all(Object.keys(seasonDraftIds).map(async season => {
      const draftId = seasonDraftIds[season];
      if (!draftId) return;
      try {
        const [draft, picks] = await Promise.all([
          fetchJson('https://api.sleeper.app/v1/draft/' + draftId),
          fetchJson('https://api.sleeper.app/v1/draft/' + draftId + '/picks')
        ]);
        if (!Array.isArray(picks) || !picks.length) return;
        const slotToRoster = draft.slot_to_roster_id || {};
        picks.forEach(dp => {
          if (!dp.player_id || dp.draft_slot == null || dp.round == null) return;
          const orig = slotToRoster[String(dp.draft_slot)];
          if (orig == null) return;
          draftPickByOrig[season + '_' + dp.round + '_' + orig] = String(dp.player_id);
        });
      } catch (e){ /* draft not ready */ }
    }));

    return function resolvePickPlayer(pk){
      if (!pk) return null;
      const key = String(pk.season) + '_' + pk.round + '_' + pk.roster_id;
      return draftPickByOrig[key] || null;
    };
  }

  function roundOrdinal(n){
    if (global.DraftPickValue && typeof DraftPickValue.roundOrdinal === 'function'){
      return DraftPickValue.roundOrdinal(n);
    }
    const r = Number(n);
    if (r === 1) return '1st';
    if (r === 2) return '2nd';
    if (r === 3) return '3rd';
    if (Number.isFinite(r)) return r + 'th';
    return String(n);
  }

  function assetLabel(asset){
    if (asset.kind === 'player') return asset.name;
    if (asset.resolvedPid){
      return roundOrdinal(asset.round) + ' (' + asset.season + ') → ' + asset.name;
    }
    return (asset.season || '') + ' ' + roundOrdinal(asset.round);
  }

  /* Current-league pick Trade ★ context (16-keeper fringe medians × slot/quality). */
  function buildPickValueContext(seasonPack, maps){
    const D = global.DraftPickValue;
    if (!D || !seasonPack) return null;
    const rosterMap = seasonPack.rosterMap || {};
    const finalRosters = seasonPack.finalRosters || {};
    const teams = Object.keys(rosterMap).map(rid => {
      const meta = rosterMap[rid] || {};
      const ids = (finalRosters[rid] || []).map(String);
      return {
        rosterId: meta.rosterId != null ? meta.rosterId : rid,
        displayName: meta.displayName || ('Roster ' + rid),
        players: ids,
        playerIds: ids,
        wins: 0,
        losses: 0,
        ties: 0
      };
    });
    if (!teams.length) return null;

    const tradeScoreByPid = {};
    if (maps && typeof maps.valueForPid === 'function'){
      teams.forEach(t => {
        (t.players || []).forEach(pid => {
          const v = maps.valueForPid(pid);
          if (v != null && Number.isFinite(Number(v)) && Number(v) > 0){
            tradeScoreByPid[String(pid)] = Number(v);
          }
        });
      });
    }

    D.assignQualityRanks(teams, tradeScoreByPid);
    const league = seasonPack.league || {};
    const rounds = Number(league.settings && league.settings.draft_rounds) || 5;
    const fringe = D.fringeMediansByRound(
      teams.map(t => t.players || []),
      tradeScoreByPid,
      {rounds}
    );
    const seasonNum = Number(league.season || seasonPack.season);
    const draftDone = league.status === 'in_season' || league.status === 'complete'
      || (seasonPack.draftId && league.status !== 'pre_draft');
    const nextDraftSeason = String(
      Number.isFinite(seasonNum) && draftDone ? seasonNum + 1 : (seasonNum || seasonPack.season)
    );
    return {
      roundBases: fringe.bases,
      nextDraftSeason,
      teamsByRosterId: D.buildTeamIndex(teams),
      teamCount: teams.length,
      standingsMeaningful: D.standingsMeaningful(teams),
      useStandingsForNext: D.standingsMeaningful(teams)
    };
  }

  function valueUnresolvedPick(asset, pickValueCtx){
    const D = global.DraftPickValue;
    if (!D || !pickValueCtx || !asset) return null;
    const valued = D.valuePick({
      season: asset.season,
      round: asset.round,
      originalRosterId: asset.originalRosterId
    }, pickValueCtx);
    if (!valued || valued.tradeScore == null || !Number.isFinite(Number(valued.tradeScore))){
      return null;
    }
    return valued;
  }

  /* Trades: quality-weighted package fairness at Trade ★-at-time
     (no roster-fit). Unresolved future picks use DraftPickValue
     (fringe medians × slot/quality). Fairness uses package grade —
     co-cores near full; step-down chips capped — matching Trade Analyzer. */
  function gradeTrade(sides, maps, playerDb, asOfSeason, currentSeason, pickValueCtx){
    const sideVals = sides.map(side => {
      let graded = 0;
      let gradedCount = 0;
      let pendingPicks = 0;
      let valuedPicks = 0;
      const assets = (side.assets || []).map(a => {
        if (a.kind === 'pick' && !a.resolvedPid){
          const pickVal = valueUnresolvedPick(a, pickValueCtx);
          if (pickVal){
            valuedPicks++;
            return Object.assign({}, a, {
              dynasty: pickVal.tradeScore,
              tradeStars: pickVal.tradeStars,
              graded: true,
              pickValued: true,
              pickNote: pickVal.note || '',
              age: null,
              label: assetLabel(a)
            });
          }
          pendingPicks++;
          return Object.assign({}, a, {
            dynasty: null, tradeStars: null, graded: false,
            age: null,
            label: assetLabel(a)
          });
        }
        const pid = a.kind === 'player' ? a.pid : a.resolvedPid;
        const adjusted = playerAtSeason(pid, playerDb, asOfSeason, currentSeason);
        const v = valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason);
        return Object.assign({}, a, {
          dynasty: v,
          tradeStars: tradeStarsForValue(v),
          graded: true,
          age: adjusted && adjusted.age != null ? Number(adjusted.age) : null,
          label: assetLabel(Object.assign({}, a, { name: a.name || playerName(playerDb[pid], pid) }))
        });
      });
      assets.filter(a => a.graded).forEach(a => {
        graded += a.dynasty || 0;
        gradedCount += 1;
      });
      const pack = packageValueParts(assets);
      const agePack = packageAgeParts(assets);
      return {
        rosterId: side.rosterId,
        team: side.team,
        franchise: side.franchise,
        manager: side.manager,
        assets,
        dynastyIn: graded,
        packageEffective: pack.effective,
        packageRaw: pack.raw,
        packagePrimary: pack.primary,
        packageCoresEff: pack.coresEff,
        packageExtrasEff: pack.extrasEff,
        packageAgeMean: agePack.mean,
        packageAgePrimary: agePack.primaryAge,
        coreCount: pack.coreCount,
        chipCount: pack.chipCount,
        extrasCapped: pack.extrasCapped,
        assetCount: gradedCount,
        avgDynasty: gradedCount > 0 ? graded / gradedCount : 0,
        pendingPicks,
        valuedPicks
      };
    });

    const gradedSides = sideVals.filter(s => s.assets.some(a => a.graded));
    const pendingPicks = sideVals.reduce((n, s) => n + s.pendingPicks, 0);
    const valuedPicks = sideVals.reduce((n, s) => n + (s.valuedPicks || 0), 0);
    const emptySide = {
      dynastyIn: 0, packageEffective: 0, packageRaw: 0, packagePrimary: 0,
      packageCoresEff: 0, packageAgeMean: null, assetCount: 0, avgDynasty: 0,
      team: null, extrasCapped: false, coreCount: 0, chipCount: 0
    };
    const a = sideVals[0] || emptySide;
    const b = sideVals[1] || emptySide;
    if (gradedSides.length < 2){
      return {
        sides: sideVals,
        grade: null,
        packageGrade: null,
        ruling: null,
        pending: true,
        pendingPicks,
        valuedPicks,
        reason: pendingPicks ? 'Waiting on undrafted picks' : 'Not enough graded assets',
        valueA: a.packageEffective || 0,
        valueB: b.packageEffective || 0,
        rawA: a.packageRaw || 0,
        rawB: b.packageRaw || 0,
        avgA: a.avgDynasty || 0,
        avgB: b.avgDynasty || 0,
        uneven: false,
        extrasCapped: !!(a.extrasCapped || b.extrasCapped),
        primaryGapHard: false,
        primaryGapSoft: false,
        ageGapSoft: false,
        ageGapHard: false,
        winner: null,
        ratio: null
      };
    }

    const scoreA = a.packageEffective;
    const scoreB = b.packageEffective;
    const ageV = ageGapVerdict(
      { mean: a.packageAgeMean, primaryAge: a.packageAgePrimary },
      { mean: b.packageAgeMean, primaryAge: b.packageAgePrimary }
    );
    const fairA = scoreA * (ageV.multA || 1);
    const fairB = scoreB * (ageV.multB || 1);
    const high = Math.max(fairA, fairB, 0.01);
    const low = Math.min(fairA, fairB);
    const ratio = low / high;
    const packageGrade = fairnessGrade(ratio);
    const gapV = primaryGapVerdict(
      { primary: a.packagePrimary, coresEff: a.packageCoresEff, coreCount: a.coreCount },
      { primary: b.packagePrimary, coresEff: b.packageCoresEff, coreCount: b.coreCount }
    );
    /* Hard primary gap vetoes the deal — letter becomes F (same as Analyzer Block). */
    const grade = gapV.hard ? 'F' : packageGrade;
    let ruling = gapV.hard ? 'block' : (gapV.soft || ageV.soft ? 'caution' : 'allow');
    const winner = fairA === fairB ? null : (fairA > fairB ? a.team : b.team);
    const uneven = a.assetCount !== b.assetCount;
    const primaryHigh = Math.max(a.packagePrimary || 0, b.packagePrimary || 0, 0.01);
    const primaryLow = Math.min(a.packagePrimary || 0, b.packagePrimary || 0);
    const primaryRatio = primaryLow / primaryHigh;
    const softPrimary = !gapV.hard
      && Math.max(a.assetCount, b.assetCount) >= 2
      && primaryRatio < PKG_PRIMARY_SOFT
      && Math.abs((a.packagePrimary || 0) - (b.packagePrimary || 0)) >= 8;
    const rawClosePkgFar = Math.abs((a.packageRaw || 0) - (b.packageRaw || 0)) <= 6
      && Math.abs(scoreA - scoreB) >= 8;

    const reasonBits = [];
    if (gapV.hard){
      reasonBits.push('BLOCK — primary gap '
        + gapV.gap.toFixed(1) + ' (' + gapV.leadPrimary.toFixed(0)
        + ' vs ' + gapV.trailPrimary.toFixed(0) + ', >' + PKG_PRIMARY_GAP
        + ', no co-core close)'
        + (packageGrade && packageGrade !== 'F' ? '; package was ' + packageGrade : ''));
    } else if (gapV.soft){
      reasonBits.push('Caution — primary gap ' + gapV.gap.toFixed(1)
        + ' closed by co-cores');
    }
    if (ageV.soft){
      const youngTeam = ageV.youngSide === 'A' ? a.team
        : (ageV.youngSide === 'B' ? b.team : 'younger side');
      reasonBits.push((ageV.hard ? 'Age gap ' : 'Age structure ')
        + ageV.gap.toFixed(1) + 'y ('
        + (ageV.meanA != null ? ageV.meanA.toFixed(1) : '?') + ' vs '
        + (ageV.meanB != null ? ageV.meanB.toFixed(1) : '?')
        + ') — fairness tilts to ' + youngTeam);
    }
    if (valuedPicks){
      reasonBits.push(valuedPicks + ' future pick' + (valuedPicks === 1 ? '' : 's')
        + ' valued via 16-keeper fringe');
    }
    if (pendingPicks){
      reasonBits.push(pendingPicks + ' pick' + (pendingPicks === 1 ? '' : 's')
        + ' still unvalued');
    }
    if ((a.coreCount || 0) >= 2 || (b.coreCount || 0) >= 2){
      reasonBits.push('Co-cores (≥'
        + Math.round(PKG_CORE_RATIO * 100)
        + '% of primary and ≥' + PKG_CORE_FLOOR + ' Trade ★)');
    }
    if (a.extrasCapped || b.extrasCapped){
      reasonBits.push('Step-down chips capped at ' + Math.round(PKG_CHIPS_CAP * 100)
        + '% of primary');
    }
    if (softPrimary){
      reasonBits.push('Primary assets far apart ('
        + Math.round(primaryHigh) + ' vs ' + Math.round(primaryLow)
        + ') — chips cannot fully close');
    }
    if (rawClosePkgFar){
      reasonBits.push('Raw sums look close but package quality diverges');
    }
    if (uneven && !softPrimary && !gapV.hard){
      reasonBits.push('Uneven haul (' + a.assetCount + ' vs ' + b.assetCount
        + ') — graded on package value, not raw volume');
    }
    return {
      sides: sideVals,
      grade,
      packageGrade,
      ruling,
      ratio,
      pending: pendingPicks > 0,
      pendingPicks,
      valuedPicks,
      uneven,
      extrasCapped: !!(a.extrasCapped || b.extrasCapped),
      softPrimary: !!softPrimary,
      primaryGapHard: !!gapV.hard,
      primaryGapSoft: !!gapV.soft,
      primaryGap: gapV.gap,
      ageGapSoft: !!ageV.soft,
      ageGapHard: !!ageV.hard,
      ageGap: ageV.gap,
      ageMeanA: ageV.meanA,
      ageMeanB: ageV.meanB,
      reason: reasonBits.length ? reasonBits.join(' · ') : null,
      valueA: scoreA,
      valueB: scoreB,
      fairA: Math.round(fairA * 100) / 100,
      fairB: Math.round(fairB * 100) / 100,
      rawA: a.packageRaw,
      rawB: b.packageRaw,
      avgA: a.avgDynasty,
      avgB: b.avgDynasty,
      winner
    };
  }

  function gradeWaiver(rosterMeta, adds, drops, maps, playerDb, asOfSeason, currentSeason, beforePids, slots){
    const addAssets = adds.map(pid => {
      const v = valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason);
      return {
        kind: 'player',
        pid: String(pid),
        name: playerName(playerDb[pid], pid),
        dynasty: v,
        tradeStars: tradeStarsForValue(v),
        graded: true,
        label: playerName(playerDb[pid], pid)
      };
    });
    const dropAssets = drops.map(pid => {
      const v = valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason);
      return {
        kind: 'player',
        pid: String(pid),
        name: playerName(playerDb[pid], pid),
        dynasty: v,
        tradeStars: tradeStarsForValue(v),
        graded: true,
        label: playerName(playerDb[pid], pid)
      };
    });
    const addVal = addAssets.reduce((s, a) => s + (a.dynasty || 0), 0);
    const dropVal = dropAssets.reduce((s, a) => s + (a.dynasty || 0), 0);
    const fit = rosterQualityDelta(
      beforePids || [], adds, drops, slots, maps, playerDb, asOfSeason, currentSeason
    );
    const hasAsset = addAssets.length + dropAssets.length > 0;
    return {
      team: rosterMeta.displayName,
      franchise: rosterMeta.franchise,
      manager: rosterMeta.manager,
      rosterId: rosterMeta.rosterId,
      adds: addAssets,
      drops: dropAssets,
      addVal,
      dropVal,
      net: fit.delta,
      rawNet: addVal - dropVal,
      fitNotes: fit.notes,
      beforeTotal: fit.beforeTotal,
      afterTotal: fit.afterTotal,
      grade: hasAsset ? netToGrade(fit.delta) : null,
      pending: false
    };
  }

  function scoreStatLine(stats, scoring){
    if (!stats || !scoring) return null;
    let total = 0;
    let matched = 0;
    Object.keys(scoring).forEach(k => {
      if (stats[k] != null && Number.isFinite(Number(stats[k]))){
        total += Number(stats[k]) * Number(scoring[k]);
        matched++;
      }
    });
    return matched ? total : null;
  }

  /* Current-season consensus only — skip for historical at-time grades. */
  function consensusProjById(scoring, season){
    const pack = global.NBA_PROJ_CONSENSUS || {};
    const useConsensus = !pack.season || String(pack.season) === String(season);
    if (!useConsensus) return null;
    const byId = {};
    let n = 0;
    Object.keys(pack.players || {}).forEach(key => {
      const row = pack.players[key];
      const fp = scoreStatLine(row.stats, scoring);
      if (fp == null || !(fp > 0)) return;
      if (row.sleeperId){
        byId[String(row.sleeperId)] = fp;
        n++;
      }
    });
    return n ? byId : null;
  }

  /* Per-season Lock OVR index → tradeScore (assets) + lockBase (roster fit).
     When the fantasy season has no NBA samples yet (offseason / preseason),
     fall back to the prior completed season — same idea as Team Intel /
     Trade Analyzer. Asset grades still age-adjust to the transaction year.
     Rookies are seeded from next-year proj + ESPN comps when smash is empty. */
  async function loadLockValueMaps(scoring, season, playerDb, playerIds){
    const Lock = global.LockInDist;
    if (!Lock || typeof Lock.fetchLockValueIndex !== 'function'){
      throw new Error('LockInDist.fetchLockValueIndex unavailable');
    }
    const fantasySeason = String(season);
    const projById = consensusProjById(scoring, fantasySeason);
    const ids = (playerIds || []).map(String);

    async function fetchIndex(statsSeason){
      return Lock.fetchLockValueIndex({
        scoring: scoring || {},
        statsSeason: String(statsSeason),
        playerDb: playerDb || {},
        projById,
        playerIds: ids,
        twoKSnapshot: global.TWO_K_SNAPSHOT || null
      });
    }

    let pack = await fetchIndex(fantasySeason);
    let statsSeason = String(pack.statsSeason || fantasySeason);
    if (!(pack.scored > 0) && !(pack.weeksFound > 0)){
      const prior = String(Number(fantasySeason) - 1);
      if (Number.isFinite(Number(prior)) && prior !== fantasySeason){
        pack = await fetchIndex(prior);
        statsSeason = String(pack.statsSeason || prior);
      }
    }
    const distMap = pack.distMap || {};

    function valueForPid(pid, db){
      const id = String(pid);
      const d = distMap[id] || distMap[pid];
      if (!d || d.lockOvr == null) return 0;
      const p = (db && (db[id] || db[pid])) || {};
      const yearsExp = Number(p.years_exp);
      const isRookie = yearsExp === 0
        || (Lock.isRookiePlayer && Lock.isRookiePlayer(p, id, {
          rookieNames: Lock.rookieNamesFromSnapshot && Lock.rookieNamesFromSnapshot()
        }));
      const score = Lock.tradeScoreFromOvr(d.lockOvr, {
        age: p.age,
        isRookie,
        injuryStatus: p.injury_status || p.injuryStatus || ''
      });
      return Number.isFinite(score) ? score : 0;
    }

    function fitMetricForPid(pid){
      const id = String(pid);
      const d = distMap[id] || distMap[pid];
      if (!d) return 0;
      const base = d.lockBase != null ? Number(d.lockBase)
        : (d.mean != null ? Number(d.mean) : NaN);
      return Number.isFinite(base) ? base : 0;
    }

    return {
      distMap,
      fantasySeason,
      statsSeason,
      weeksFound: pack.weeksFound,
      scored: pack.scored,
      valueForPid,
      fitMetricForPid
    };
  }

  function tradeStarsForValue(v){
    const Lock = global.LockInDist;
    if (!Lock || typeof Lock.tradeStarsFromScore !== 'function') return null;
    if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
    return Lock.tradeStarsFromScore(Number(v));
  }

  async function compute(leagueId, opts){
    const startId = leagueId || LEAGUE_ID;
    const options = opts || {};
    const onProgress = options.onProgress || function(){};
    const tradesOnly = !!options.tradesOnly;
    const gradeTypes = tradesOnly ? { trade: 1 } : GRADE_TYPES;
    const stateTypes = tradesOnly ? { trade: 1 } : STATE_TYPES;
    onProgress('Walking league seasons…');
    const seasons = await walkLeagueChain(startId);
    if (!seasons.length) throw new Error('No league seasons found');
    const currentSeason = seasons[0].season;

    onProgress('Loading players…');
    const playerDb = (global.PatioBoysShare && typeof global.PatioBoysShare.fetchPlayersNba === 'function')
      ? await global.PatioBoysShare.fetchPlayersNba()
      : await fetchJson('https://api.sleeper.app/v1/players/nba');

    onProgress(tradesOnly ? 'Fetching trades…' : 'Fetching trades and waivers…');
    const rawState = [];
    for (const s of seasons){
      const txns = await fetchSeasonTransactions(s.leagueId, stateTypes);
      txns.forEach(tx => {
        rawState.push({
          ...tx,
          season: s.season,
          leagueId: s.leagueId,
          scoring: s.scoring,
          rosterMap: s.rosterMap,
          slots: s.slots || []
        });
      });
    }
    const seenState = new Set();
    const stateTxns = rawState.filter(t => {
      const id = String(t.transaction_id);
      if (seenState.has(id)) return false;
      seenState.add(id);
      return true;
    });
    const unique = stateTxns
      .filter(t => gradeTypes[t.type])
      .slice()
      .sort((a, b) => (b.status_updated || 0) - (a.status_updated || 0));

    let preRostersByTxn = {};
    if (!tradesOnly){
      onProgress('Replaying rosters for fit grades…');
      preRostersByTxn = buildPreRostersByTxn(seasons, stateTxns);
    }

    onProgress('Resolving drafted picks…');
    const resolvePick = await buildPickResolver(seasons, unique);

    onProgress('Building lock-value maps by season…');
    if (!global.LockInDist || typeof global.LockInDist.fetchLockValueIndex !== 'function'){
      throw new Error('LockInDist.fetchLockValueIndex unavailable');
    }
    const mapsBySeason = {};
    const scoringBySeason = {};
    const pidsBySeason = {};
    seasons.forEach(s => { scoringBySeason[s.season] = s.scoring; });
    unique.forEach(tx => {
      const season = String(tx.season);
      const bag = pidsBySeason[season] || (pidsBySeason[season] = new Set());
      Object.keys(tx.adds || {}).forEach(pid => bag.add(String(pid)));
      if (!tradesOnly) Object.keys(tx.drops || {}).forEach(pid => bag.add(String(pid)));
      (tx.draft_picks || []).forEach(pk => {
        const resolved = resolvePick(pk);
        if (resolved) bag.add(String(resolved));
      });
    });
    /* Roster-fit grades also need values for everyone on the pre-txn roster. */
    if (!tradesOnly){
      const seasonByTxnId = new Map(unique.map(t => [String(t.transaction_id), String(t.season)]));
      Object.keys(preRostersByTxn).forEach(txid => {
        const season = seasonByTxnId.get(String(txid));
        if (!season) return;
        const bag = pidsBySeason[season] || (pidsBySeason[season] = new Set());
        const byRid = preRostersByTxn[txid] || {};
        Object.keys(byRid).forEach(rid => {
          (byRid[rid] || []).forEach(pid => bag.add(String(pid)));
        });
      });
    }
    const seasonSet = new Set(unique.map(t => String(t.season)));
    await Promise.all([...seasonSet].map(async season => {
      const scoring = scoringBySeason[season] || seasons[0].scoring;
      const ids = [...(pidsBySeason[season] || [])];
      mapsBySeason[season] = await loadLockValueMaps(scoring, season, playerDb, ids);
    }));

    onProgress('Building draft-pick Trade ★ context…');
    const pickValueCtx = buildPickValueContext(
      seasons[0],
      mapsBySeason[String(currentSeason)] || mapsBySeason[seasons[0].season] || null
    );

    onProgress(tradesOnly ? 'Grading trades…' : 'Grading transactions…');
    const rows = unique.map(tx => {
      const rosterMap = tx.rosterMap || {};
      const asOf = String(tx.season);
      const maps = mapsBySeason[asOf];
      const slots = tx.slots || [];
      const preRosters = preRostersByTxn[String(tx.transaction_id)] || {};
      const ts = tx.status_updated || tx.created || 0;
      const dateLabel = ts
        ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';

      if (tx.type === 'trade'){
        const rosterIds = (tx.roster_ids || []).map(String);
        const rA = rosterIds[0];
        const rB = rosterIds[1];
        const metaA = rosterMap[rA] || { displayName: 'Roster ' + rA, franchise: 'Roster ' + rA, manager: '', rosterId: rA };
        const metaB = rosterMap[rB] || { displayName: 'Roster ' + rB, franchise: 'Roster ' + rB, manager: '', rosterId: rB };
        const adds = tx.adds || {};
        const picks = tx.draft_picks || [];

        function sideAssets(rid){
          const assets = [];
          Object.entries(adds).forEach(([pid, toRid]) => {
            if (String(toRid) !== String(rid)) return;
            assets.push({
              kind: 'player',
              pid: String(pid),
              name: playerName(playerDb[pid], pid),
              resolvedPid: null,
              round: null,
              season: null
            });
          });
          picks.forEach(pk => {
            if (String(pk.owner_id) !== String(rid)) return;
            const resolvedPid = resolvePick(pk);
            assets.push({
              kind: 'pick',
              pid: null,
              resolvedPid,
              name: resolvedPid ? playerName(playerDb[resolvedPid], resolvedPid) : null,
              round: pk.round,
              season: pk.season,
              originalRosterId: pk.roster_id
            });
          });
          return assets;
        }
        const graded = gradeTrade(
          [
            {
              rosterId: rA, team: metaA.displayName, franchise: metaA.franchise,
              manager: metaA.manager, assets: sideAssets(rA)
            },
            {
              rosterId: rB, team: metaB.displayName, franchise: metaB.franchise,
              manager: metaB.manager, assets: sideAssets(rB)
            }
          ],
          maps,
          playerDb,
          asOf,
          currentSeason,
          pickValueCtx
        );

        return {
          id: String(tx.transaction_id),
          type: 'trade',
          typeLabel: 'Trade',
          season: asOf,
          week: tx._week || tx.leg || null,
          ts,
          dateLabel,
          teams: [metaA.displayName, metaB.displayName].filter(Boolean),
          franchises: [metaA.franchise, metaB.franchise].filter(Boolean),
          grade: graded.grade,
          packageGrade: graded.packageGrade,
          ruling: graded.ruling,
          pending: graded.pending,
          pendingPicks: graded.pendingPicks,
          reason: graded.reason,
          winner: graded.winner,
          valueA: graded.valueA,
          valueB: graded.valueB,
          rawA: graded.rawA,
          rawB: graded.rawB,
          avgA: graded.avgA,
          avgB: graded.avgB,
          uneven: !!graded.uneven,
          extrasCapped: !!graded.extrasCapped,
          softPrimary: !!graded.softPrimary,
          primaryGapHard: !!graded.primaryGapHard,
          primaryGapSoft: !!graded.primaryGapSoft,
          primaryGap: graded.primaryGap,
          ageGapSoft: !!graded.ageGapSoft,
          ageGapHard: !!graded.ageGapHard,
          ageGap: graded.ageGap,
          ageMeanA: graded.ageMeanA,
          ageMeanB: graded.ageMeanB,
          fairA: graded.fairA,
          fairB: graded.fairB,
          ratio: graded.ratio,
          sides: graded.sides,
          waiverBid: null
        };
      }

      if (tradesOnly) return null;

      /* waiver + free_agent */
      const rid = String((tx.roster_ids && tx.roster_ids[0]) || Object.values(tx.adds || {})[0] || Object.values(tx.drops || {})[0] || '');
      const meta = rosterMap[rid] || { displayName: 'Roster ' + rid, franchise: 'Roster ' + rid, manager: '', rosterId: rid };
      const adds = Object.keys(tx.adds || {});
      const drops = Object.keys(tx.drops || {});
      const graded = gradeWaiver(
        meta, adds, drops, maps, playerDb, asOf, currentSeason,
        preRosters[rid] || [], slots
      );
      const bid = tx.settings && tx.settings.waiver_bid != null ? Number(tx.settings.waiver_bid) : null;
      const subtype = tx.type === 'waiver' ? 'Waiver'
        : (adds.length && drops.length ? 'FA claim'
          : (adds.length ? 'Add' : 'Drop'));
      const reason = (graded.fitNotes && graded.fitNotes.length)
        ? graded.fitNotes.slice(0, 3).join(' · ')
        : null;

      return {
        id: String(tx.transaction_id),
        type: tx.type === 'waiver' ? 'waiver' : 'free_agent',
        typeLabel: subtype,
        season: asOf,
        week: tx._week || tx.leg || null,
        ts,
        dateLabel,
        teams: [meta.displayName],
        franchises: [meta.franchise],
        grade: graded.grade,
        pending: false,
        pendingPicks: 0,
        reason,
        winner: graded.net > 0.5 ? meta.displayName : null,
        valueA: graded.addVal,
        valueB: graded.dropVal,
        net: graded.net,
        rawNet: graded.rawNet,
        ratio: null,
        sides: [{
          rosterId: meta.rosterId,
          team: meta.displayName,
          franchise: meta.franchise,
          manager: meta.manager,
          assets: graded.adds,
          dynastyIn: graded.addVal,
          pendingPicks: 0,
          drops: graded.drops,
          dynastyOut: graded.dropVal,
          fitNotes: graded.fitNotes
        }],
        waiverBid: Number.isFinite(bid) ? bid : null
      };
    }).filter(Boolean);

    const teamSet = new Map();
    seasons[0].rosterMap && Object.values(seasons[0].rosterMap).forEach(t => {
      teamSet.set(t.franchise, t.displayName);
    });

    return {
      leagueId: startId,
      currentSeason,
      seasons: seasons.map(s => s.season),
      teams: [...teamSet.entries()].map(([franchise, displayName]) => ({ franchise, displayName })),
      rows,
      counts: {
        total: rows.length,
        trades: rows.filter(r => r.type === 'trade').length,
        waivers: rows.filter(r => r.type !== 'trade').length,
        graded: rows.filter(r => r.grade).length,
        pending: rows.filter(r => r.pending).length
      }
    };
  }

  global.PatioBoysTransactions = {
    LEAGUE_ID,
    compute,
    loadLockValueMaps,
    fairnessGrade,
    netToGrade,
    franchiseKey,
    buildPickValueContext,
    gradeTrade,
    packageValueParts,
    packageAgeParts,
    effectivePackageValue,
    primaryGapVerdict,
    ageGapVerdict,
    PKG_EXTRAS_CAP,
    PKG_CHIPS_CAP,
    PKG_CORE_RATIO,
    PKG_CORE_FLOOR,
    PKG_CORE_WEIGHTS,
    PKG_CHIP_WEIGHTS,
    PKG_PRIMARY_GAP,
    PKG_AGE_SOFT
  };
})(typeof window !== 'undefined' ? window : globalThis);
