/* Patio Boys transaction ledger.
   Fetches completed trades + waivers/FA claims across the league chain,
   resolves drafted picks to players, and grades with Lock OVR / Trade ★
   as of that season (tradeScore-at-time). Future unresolved picks use
   DraftPickValue (16-keeper fringe). Roster-fit uses lockBase (smash FP). */
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

  function fairnessGrade(ratio){
    if (ratio >= 0.94) return 'A+';
    if (ratio >= 0.88) return 'A';
    if (ratio >= 0.80) return 'B+';
    if (ratio >= 0.72) return 'B';
    if (ratio >= 0.62) return 'C+';
    if (ratio >= 0.52) return 'C';
    if (ratio >= 0.40) return 'D';
    return 'F';
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

  /* Trades: tradeScore-at-time fairness (no roster-fit).
     Unresolved future picks use DraftPickValue (fringe medians × slot/quality).
     When asset counts differ, blend total haul with per-asset average so
     2-for-1 / 3-for-1 deals aren't graded on volume alone. */
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
              label: assetLabel(a)
            });
          }
          pendingPicks++;
          return Object.assign({}, a, {
            dynasty: null, tradeStars: null, graded: false, label: assetLabel(a)
          });
        }
        const pid = a.kind === 'player' ? a.pid : a.resolvedPid;
        const v = valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason);
        return Object.assign({}, a, {
          dynasty: v,
          tradeStars: tradeStarsForValue(v),
          graded: true,
          label: assetLabel(Object.assign({}, a, { name: a.name || playerName(playerDb[pid], pid) }))
        });
      });
      assets.filter(a => a.graded).forEach(a => {
        graded += a.dynasty || 0;
        gradedCount += 1;
      });
      return {
        rosterId: side.rosterId,
        team: side.team,
        franchise: side.franchise,
        manager: side.manager,
        assets,
        dynastyIn: graded,
        assetCount: gradedCount,
        avgDynasty: gradedCount > 0 ? graded / gradedCount : 0,
        pendingPicks,
        valuedPicks
      };
    });

    const gradedSides = sideVals.filter(s => s.assets.some(a => a.graded));
    const pendingPicks = sideVals.reduce((n, s) => n + s.pendingPicks, 0);
    const valuedPicks = sideVals.reduce((n, s) => n + (s.valuedPicks || 0), 0);
    const a = sideVals[0] || { dynastyIn: 0, assetCount: 0, avgDynasty: 0, team: null };
    const b = sideVals[1] || { dynastyIn: 0, assetCount: 0, avgDynasty: 0, team: null };
    if (gradedSides.length < 2){
      return {
        sides: sideVals,
        grade: null,
        pending: true,
        pendingPicks,
        valuedPicks,
        reason: pendingPicks ? 'Waiting on undrafted picks' : 'Not enough graded assets',
        valueA: a.dynastyIn || 0,
        valueB: b.dynastyIn || 0,
        avgA: a.avgDynasty || 0,
        avgB: b.avgDynasty || 0,
        uneven: false,
        winner: null,
        ratio: null
      };
    }

    const uneven = a.assetCount !== b.assetCount;
    const maxN = Math.max(a.assetCount, b.assetCount, 1);
    function sideScore(side){
      if (!uneven) return side.dynastyIn;
      /* 55% total haul + 45% average scaled to the larger side's count. */
      return 0.55 * side.dynastyIn + 0.45 * side.avgDynasty * maxN;
    }
    const scoreA = sideScore(a);
    const scoreB = sideScore(b);

    const totalHigh = Math.max(a.dynastyIn, b.dynastyIn, 0.01);
    const totalLow = Math.min(a.dynastyIn, b.dynastyIn);
    const ratioTotal = totalLow / totalHigh;
    const avgHigh = Math.max(a.avgDynasty, b.avgDynasty, 0.01);
    const avgLow = Math.min(a.avgDynasty, b.avgDynasty);
    const ratioAvg = avgLow / avgHigh;
    const ratio = uneven ? (0.5 * ratioTotal + 0.5 * ratioAvg) : ratioTotal;
    const grade = fairnessGrade(ratio);
    const winner = scoreA === scoreB ? null : (scoreA > scoreB ? a.team : b.team);
    const reasonBits = [];
    if (valuedPicks){
      reasonBits.push(valuedPicks + ' future pick' + (valuedPicks === 1 ? '' : 's')
        + ' valued via 16-keeper fringe');
    }
    if (pendingPicks){
      reasonBits.push(pendingPicks + ' pick' + (pendingPicks === 1 ? '' : 's')
        + ' still unvalued');
    }
    if (uneven){
      reasonBits.push('Uneven haul (' + a.assetCount + ' vs ' + b.assetCount
        + ') — fairness blends total + avg trade score');
    }
    return {
      sides: sideVals,
      grade,
      ratio,
      pending: pendingPicks > 0,
      pendingPicks,
      valuedPicks,
      uneven,
      reason: reasonBits.length ? reasonBits.join(' · ') : null,
      valueA: a.dynastyIn,
      valueB: b.dynastyIn,
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
    const onProgress = (opts && opts.onProgress) || function(){};
    onProgress('Walking league seasons…');
    const seasons = await walkLeagueChain(startId);
    if (!seasons.length) throw new Error('No league seasons found');
    const currentSeason = seasons[0].season;

    onProgress('Loading players…');
    const playerDb = await fetchJson('https://api.sleeper.app/v1/players/nba');

    onProgress('Fetching trades and waivers…');
    const rawState = [];
    for (const s of seasons){
      const txns = await fetchSeasonTransactions(s.leagueId, STATE_TYPES);
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
      .filter(t => GRADE_TYPES[t.type])
      .slice()
      .sort((a, b) => (b.status_updated || 0) - (a.status_updated || 0));

    onProgress('Replaying rosters for fit grades…');
    const preRostersByTxn = buildPreRostersByTxn(seasons, stateTxns);

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
      Object.keys(tx.drops || {}).forEach(pid => bag.add(String(pid)));
      (tx.draft_picks || []).forEach(pk => {
        const resolved = resolvePick(pk);
        if (resolved) bag.add(String(resolved));
      });
    });
    /* Roster-fit grades also need values for everyone on the pre-txn roster. */
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

    onProgress('Grading transactions…');
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
          pending: graded.pending,
          pendingPicks: graded.pendingPicks,
          reason: graded.reason,
          winner: graded.winner,
          valueA: graded.valueA,
          valueB: graded.valueB,
          avgA: graded.avgA,
          avgB: graded.avgB,
          uneven: !!graded.uneven,
          ratio: graded.ratio,
          sides: graded.sides,
          waiverBid: null
        };
      }

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
    });

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
    gradeTrade
  };
})(typeof window !== 'undefined' ? window : globalThis);
