/* Patio Boys transaction ledger.
   Fetches completed trades + waivers/FA claims across the league chain,
   resolves drafted picks to players, and grades with dynasty-at-time values. */
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
    'badgersretirementhome':'Funeral Home',
    'belt':'Belt',
    '5iveonit':'Belt',
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
  function franchiseKey(teamName, managerName){
    const norm = normalizeName(teamName);
    if (TEAM_ALIASES[norm]) return TEAM_ALIASES[norm];
    const match = Object.keys(TEAM_COLORS).find(k => normalizeName(k) === norm);
    if (match) return match;
    const byMgr = normalizeName(managerName || '');
    if (TEAM_ALIASES[byMgr]) return TEAM_ALIASES[byMgr];
    const mgrMatch = Object.keys(TEAM_COLORS).find(k => normalizeName(k) === byMgr);
    if (mgrMatch) return mgrMatch;
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

  function valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason){
    if (!maps || !maps.valueForPid) return 0;
    const p = (playerDb && playerDb[pid]) || {};
    const age = ageAtSeason(p, asOfSeason, currentSeason);
    const yearsExp = yearsExpAtSeason(p, asOfSeason, currentSeason);
    const adjusted = Object.assign({}, p);
    if (age != null) adjusted.age = age;
    if (yearsExp != null) adjusted.years_exp = yearsExp;
    const db = Object.create(playerDb || null);
    db[pid] = adjusted;
    db[String(pid)] = adjusted;
    const v = maps.valueForPid(String(pid), db);
    return Number.isFinite(v) ? v : 0;
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
        metric: valueForPidAt(maps, id, playerDb, asOfSeason, currentSeason),
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

  /* Roster-context quality: lineup dynasty delta + cut-fat bonus − bench-clog penalty. */
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

    (drops || []).forEach(pid => {
      const id = String(pid);
      const v = valueForPidAt(maps, id, playerDb, asOfSeason, currentSeason);
      if (!beforeL.starterIds.has(id)){
        if (v < 15){
          const bonus = Math.min(3.5, 1.2 + (15 - v) * 0.12);
          delta += bonus;
          notes.push('cut fat: ' + playerName(playerDb[id], id));
        } else if (v < 22){
          delta += 0.55;
          notes.push('bench cut: ' + playerName(playerDb[id], id));
        } else {
          delta -= (v - 22) * 0.1;
          notes.push('cut stash: ' + playerName(playerDb[id], id));
        }
      }
    });

    (adds || []).forEach(pid => {
      const id = String(pid);
      const v = valueForPidAt(maps, id, playerDb, asOfSeason, currentSeason);
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

  function assetLabel(asset){
    if (asset.kind === 'player') return asset.name;
    if (asset.resolvedPid){
      return 'Rd ' + asset.round + ' (' + asset.season + ') → ' + asset.name;
    }
    return 'Rd ' + asset.round + ' pick (' + asset.season + ')';
  }

  function gradeTrade(sides, maps, playerDb, asOfSeason, currentSeason, preRosters, slots){
    const sideVals = sides.map(side => {
      let rawDynasty = 0;
      let pendingPicks = 0;
      const recvPids = [];
      const assets = (side.assets || []).map(a => {
        if (a.kind === 'pick' && !a.resolvedPid){
          pendingPicks++;
          return Object.assign({}, a, { dynasty: null, graded: false, label: assetLabel(a) });
        }
        const pid = a.kind === 'player' ? a.pid : a.resolvedPid;
        const v = valueForPidAt(maps, pid, playerDb, asOfSeason, currentSeason);
        recvPids.push(String(pid));
        rawDynasty += v;
        return Object.assign({}, a, {
          dynasty: v,
          graded: true,
          label: assetLabel(Object.assign({}, a, { name: a.name || playerName(playerDb[pid], pid) }))
        });
      });
      const sentPids = (side.sentPids || []).map(String);
      const before = (preRosters && preRosters[String(side.rosterId)]) || [];
      const fit = rosterQualityDelta(
        before, recvPids, sentPids, slots, maps, playerDb, asOfSeason, currentSeason
      );
      /* Haul value in roster context = lineup after sends&receives minus lineup after sends only. */
      const afterSends = before.filter(pid => !sentPids.includes(String(pid)));
      const sendOnly = lineupSnapshot(afterSends, slots, maps, playerDb, asOfSeason, currentSeason);
      const haulFit = fit.afterTotal - sendOnly.total;
      return {
        rosterId: side.rosterId,
        team: side.team,
        franchise: side.franchise,
        manager: side.manager,
        assets,
        dynastyIn: rawDynasty,
        fitIn: haulFit,
        rosterDelta: fit.delta,
        fitNotes: fit.notes,
        pendingPicks
      };
    });

    const gradedSides = sideVals.filter(s => s.assets.some(a => a.graded));
    const pendingPicks = sideVals.reduce((n, s) => n + s.pendingPicks, 0);
    const a = sideVals[0] || { dynastyIn: 0, fitIn: 0, team: null };
    const b = sideVals[1] || { dynastyIn: 0, fitIn: 0, team: null };
    if (gradedSides.length < 2){
      return {
        sides: sideVals,
        grade: null,
        pending: true,
        pendingPicks,
        reason: pendingPicks ? 'Waiting on undrafted picks' : 'Not enough graded assets',
        valueA: a.fitIn || 0,
        valueB: b.fitIn || 0,
        winner: null,
        ratio: null
      };
    }

    const high = Math.max(a.fitIn, b.fitIn, 0.01);
    const low = Math.min(a.fitIn, b.fitIn);
    /* If both hauls are tiny/negative, fall back to raw dynasty fairness. */
    const useFit = a.fitIn > 0.25 || b.fitIn > 0.25;
    const ah = useFit ? Math.max(a.fitIn, 0) : a.dynastyIn;
    const bh = useFit ? Math.max(b.fitIn, 0) : b.dynastyIn;
    const high2 = Math.max(ah, bh, 0.01);
    const low2 = Math.min(ah, bh);
    const ratio = low2 / high2;
    const grade = fairnessGrade(ratio);
    const winner = ah === bh ? null : (ah > bh ? a.team : b.team);
    return {
      sides: sideVals,
      grade,
      ratio,
      pending: pendingPicks > 0,
      pendingPicks,
      reason: pendingPicks
        ? 'Grade uses resolved players only; ' + pendingPicks + ' pick'
          + (pendingPicks === 1 ? '' : 's') + ' still open'
        : (useFit ? 'Roster-fit haul (lineup dynasty at the time)' : null),
      valueA: useFit ? a.fitIn : a.dynastyIn,
      valueB: useFit ? b.fitIn : b.dynastyIn,
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

  /* Bust stale GitHub Pages / Safari caches that still have pre-export awards.js. */
  function ensureAwardsDynasty(){
    if (global.PatioBoysAwards && typeof global.PatioBoysAwards.loadDynastyMaps === 'function'){
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'league-awards.js?v=tx-dynasty-' + Date.now();
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to reload league-awards.js'));
      (document.head || document.documentElement).appendChild(s);
    });
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

    onProgress('Building dynasty maps by season…');
    await ensureAwardsDynasty();
    const Awards = global.PatioBoysAwards;
    if (!Awards || !Awards.loadDynastyMaps){
      throw new Error('PatioBoysAwards.loadDynastyMaps unavailable');
    }
    const mapsBySeason = {};
    const scoringBySeason = {};
    seasons.forEach(s => { scoringBySeason[s.season] = s.scoring; });
    const seasonSet = new Set(unique.map(t => String(t.season)));
    await Promise.all([...seasonSet].map(async season => {
      const scoring = scoringBySeason[season] || seasons[0].scoring;
      mapsBySeason[season] = await Awards.loadDynastyMaps(scoring, season);
    }));

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
        const drops = tx.drops || {};
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
        function sentPids(rid){
          return Object.entries(drops)
            .filter(([, fromRid]) => String(fromRid) === String(rid))
            .map(([pid]) => String(pid));
        }

        const graded = gradeTrade(
          [
            {
              rosterId: rA, team: metaA.displayName, franchise: metaA.franchise,
              manager: metaA.manager, assets: sideAssets(rA), sentPids: sentPids(rA)
            },
            {
              rosterId: rB, team: metaB.displayName, franchise: metaB.franchise,
              manager: metaB.manager, assets: sideAssets(rB), sentPids: sentPids(rB)
            }
          ],
          maps,
          playerDb,
          asOf,
          currentSeason,
          preRosters,
          slots
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
    fairnessGrade,
    netToGrade,
    franchiseKey
  };
})(typeof window !== 'undefined' ? window : globalThis);
