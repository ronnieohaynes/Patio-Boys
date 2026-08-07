/* Patio Boys automatic accolades.
   Lock-in points = Max Points (top-10 weekly mean + 1σ under league scoring).
   No voting — computed from Sleeper + TeamNeedsModel lineup efficiency. */
(function(global){
  'use strict';

  const LEAGUE_ID = '1350649177381552128';

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
    /* manager display names → franchise */
    'aliofdan':'Belt',
    'radeka':'Papa Book',
    'oreokidronaldo':'Freakonomics',
    'fadie':'Hamas',
    'addiejarrar':'2011-12 Champs',
    'jsimbulan3':'Bam Add the Mayo',
    'baderalhindi':'Funeral Home'
  };

  const AWARD_DEFS = [
    { id:'champion', name:'Champion', short:'Champ' },
    { id:'mvp', name:'MVP', short:'MVP' },
    { id:'mip', name:'Most Improved', short:'MIP' },
    { id:'coach', name:'Coach of the Year', short:'Coach' },
    { id:'gm', name:'GM of the Year', short:'GM' },
    { id:'goat', name:'GOAT', short:'GOAT' }
  ];

  /* Career GOAT tracker — awards + win bundles + playoff wins. GOAT itself awards 0.
     Good Season = NBA-style ~50-win bar: regular-season win% >= 61% (locks when season completes).
     Win Streak = any regular-season streak of WIN_STREAK_THRESHOLD+ (rare; pays once per streak).
     Wins score in integer bundles only (no per-win decimals): every 10 RS wins = 5 pts,
     every 2 playoff wins = 3 pts. */
  const GOOD_SEASON_WIN_PCT = 0.610;
  const WIN_STREAK_THRESHOLD = 10;
  const RS_WIN_BUNDLE_SIZE = 10;
  const PLAYOFF_WIN_BUNDLE_SIZE = 2;
  const GOAT_POINTS = {
    champion: 10,
    mvp: 7,
    coach: 5,
    gm: 5,
    mip: 3,
    win: 5,           /* points per RS_WIN_BUNDLE_SIZE career regular-season wins */
    playoff_win: 3,   /* points per PLAYOFF_WIN_BUNDLE_SIZE career playoff wins */
    runner_up: 5,
    third_place: 3,
    good_season: 3,
    win_streak: 3
  };

  function normalizeTeamName(name){
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function franchiseKey(teamName, managerName){
    /* Prefer manager identity — Sleeper team names get reused across franchises. */
    const byMgr = normalizeTeamName(managerName || '');
    if (byMgr && TEAM_ALIASES[byMgr]) return TEAM_ALIASES[byMgr];
    const mgrMatch = byMgr
      ? Object.keys(TEAM_COLORS).find(k => normalizeTeamName(k) === byMgr)
      : null;
    if (mgrMatch) return mgrMatch;
    const norm = normalizeTeamName(teamName);
    if (TEAM_ALIASES[norm]) return TEAM_ALIASES[norm];
    const match = Object.keys(TEAM_COLORS).find(k => normalizeTeamName(k) === norm);
    if (match) return match;
    return teamName || managerName || 'Unknown';
  }

  function yearLabel(season){
    const y = Number(season);
    if (!Number.isFinite(y)) return String(season || '');
    /* Season year on Sleeper is the start year; awards tagged by end year. */
    return "'" + String(y + 1).slice(-2);
  }

  function seasonTag(season){
    const y = Number(season);
    if (!Number.isFinite(y)) return String(season || '');
    return 'S' + String(y).slice(-2) + '\u2013' + String(y + 1).slice(-2);
  }

  async function fetchJson(url){
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  function rawPf(settings){
    const s = settings || {};
    return (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
  }

  function buildTeams(users, rosters){
    const userById = {};
    (users || []).forEach(u => { userById[u.user_id] = u; });
    return (rosters || []).map(r => {
      const u = userById[r.owner_id] || {};
      const raw = (u.metadata && u.metadata.team_name) || u.display_name || ('Roster ' + r.roster_id);
      const key = franchiseKey(raw, u.display_name);
      const players = [].concat(r.players || [], r.reserve || [], r.taxi || []).map(String);
      return {
        key,
        displayName: TEAM_COLORS[key] ? key : raw,
        manager: u.display_name || '',
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        players: Array.from(new Set(players)),
        pf: rawPf(r.settings),
        wins: (r.settings && r.settings.wins) || 0,
        losses: (r.settings && r.settings.losses) || 0,
        ties: (r.settings && r.settings.ties) || 0
      };
    });
  }

  function gamesPlayed(t){
    return (Number(t.wins) || 0) + (Number(t.losses) || 0) + (Number(t.ties) || 0);
  }
  function pfPerGame(t){
    const gp = gamesPlayed(t);
    if (!(gp > 0) || t.pf == null) return null;
    return t.pf / gp;
  }

  function scoreWeekly(obj, scoring){
    if (!obj || !scoring) return null;
    const keys = Object.keys(scoring);
    let total = 0, matched = 0;
    keys.forEach(k => {
      if (obj[k] != null && Number.isFinite(Number(obj[k]))){
        total += Number(obj[k]) * scoring[k];
        matched++;
      }
    });
    if (!matched) return null;
    const gp = obj.gp || obj.games_played || null;
    return gp && gp > 0 ? total / gp : total;
  }

  async function loadWeeklyCeilings(statsSeason, scoring){
    const weeks = Array.from({ length: 25 }, (_, i) => i + 1);
    const weeklyResults = await Promise.all(weeks.map(w =>
      fetch('https://api.sleeper.app/v1/stats/nba/regular/' + statsSeason + '/' + w)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    ));
    const weeklyByPlayer = {};
    let weeksFound = 0;
    weeklyResults.forEach(wk => {
      if (!wk || !Object.keys(wk).length) return;
      weeksFound++;
      Object.keys(wk).forEach(pid => {
        const v = scoreWeekly(wk[pid], scoring);
        if (v == null) return;
        if (!weeklyByPlayer[pid]) weeklyByPlayer[pid] = [];
        weeklyByPlayer[pid].push(v);
      });
    });
    const ceiling = {};
    Object.keys(weeklyByPlayer).forEach(pid => {
      const arr = weeklyByPlayer[pid];
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      const stdev = Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length);
      ceiling[pid] = mean + stdev;
    });
    return { ceiling, weeksFound };
  }

  function maxPointsForTeam(players, ceiling){
    const vals = (players || []).map(pid => ceiling[String(pid)])
      .filter(v => v != null).sort((a, b) => b - a).slice(0, 10);
    return {
      maxPts: vals.reduce((s, v) => s + v, 0),
      counted: vals.length
    };
  }

  function pickWinner(rows, valueKey){
    const top = topCandidates(rows, valueKey, 2);
    if (!top.length) return null;
    return {
      key: top[0].key,
      displayName: top[0].displayName,
      manager: top[0].manager || '',
      ownerId: top[0].ownerId || null,
      value: top[0].value,
      runnerUp: top[1] ? {
        key: top[1].key,
        displayName: top[1].displayName,
        manager: top[1].manager || '',
        ownerId: top[1].ownerId || null,
        value: top[1].value
      } : null
    };
  }

  function topCandidates(rows, valueKey, n){
    const limit = n == null ? 3 : n;
    const eligible = (rows || []).filter(r => r && r[valueKey] != null && Number.isFinite(r[valueKey]));
    eligible.sort((a, b) =>
      b[valueKey] - a[valueKey]
      || (b.maxPts || 0) - (a.maxPts || 0)
      || (b.pf || 0) - (a.pf || 0)
      || String(a.key).localeCompare(String(b.key))
    );
    return eligible.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      key: r.key,
      displayName: r.displayName,
      manager: r.manager || '',
      ownerId: r.ownerId || null,
      value: r[valueKey],
      maxPts: r.maxPts,
      pf: r.pf
    }));
  }

  function buildTrackers(pack){
    if (!pack) return [];
    const maxGp = Math.max.apply(null, (pack.rows || []).map(r => r.gp || 0).concat([0]));
    const scoringStarted = !(pack.pending && maxGp < 1);
    const mvp = scoringStarted ? topCandidates(pack.rows, 'pf', 3) : [];
    const coach = topCandidates(pack.coachRows, 'coachEff', 3);
    const mip = scoringStarted ? topCandidates(pack.mipRows, 'mipDelta', 3) : [];
    const gmWeeks = pack.gmMeta && pack.gmMeta.weeksUsed;
    const gmReady = !!(pack.gmRows && pack.gmRows.length);
    const gm = gmReady ? topCandidates(pack.gmRows, 'gmDelta', 3) : [];
    return [
      { id: 'mvp', name: 'MVP', metric: 'Regular-season Points For', candidates: mvp, ready: mvp.length > 0 },
      { id: 'mip', name: 'Most Improved', metric: 'YoY Points For / game', candidates: mip, ready: mip.length > 0 },
      { id: 'coach', name: 'Coach of the Year', metric: 'Lineup efficiency', candidates: coach, ready: coach.length > 0 },
      { id: 'gm', name: 'GM of the Year', metric: 'YoY dynasty value', candidates: gm, ready: gm.length > 0 }
    ];
  }

  /* Regular-season Points For + win streaks from matchups before playoff_week_start. */
  async function regularSeasonPfByRoster(league){
    const settings = (league && league.settings) || {};
    const start = Number(settings.start_week) || 1;
    const playoffStart = Number(settings.playoff_week_start);
    let end;
    if (Number.isFinite(playoffStart) && playoffStart > start) end = playoffStart - 1;
    else end = Number(settings.last_scored_leg) || Number(settings.leg) || 18;

    const byRoster = {};
    const streakCur = {};
    const streakMax = {};
    const streak10 = {};
    let weeksScored = 0;
    const weeks = [];
    for (let w = start; w <= end; w++) weeks.push(w);
    const results = await Promise.all(weeks.map(w =>
      fetch('https://api.sleeper.app/v1/league/' + league.league_id + '/matchups/' + w)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    ));
    results.forEach(matchups => {
      if (!Array.isArray(matchups) || !matchups.length) return;
      if (!matchups.some(m => Number(m.points) > 0)) return;
      weeksScored++;
      matchups.forEach(m => {
        const rid = String(m.roster_id);
        const pts = Number(m.points);
        if (!Number.isFinite(pts)) return;
        byRoster[rid] = (byRoster[rid] || 0) + pts;
      });
      const byMatchup = {};
      matchups.forEach(m => {
        const mid = m.matchup_id;
        if (mid == null) return;
        if (!byMatchup[mid]) byMatchup[mid] = [];
        byMatchup[mid].push(m);
      });
      const winners = {};
      const played = {};
      Object.keys(byMatchup).forEach(mid => {
        const rows = byMatchup[mid];
        if (rows.length < 2) return;
        rows.forEach(m => { played[String(m.roster_id)] = 1; });
        const sorted = rows.slice().sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0));
        const top = Number(sorted[0].points) || 0;
        const second = Number(sorted[1].points) || 0;
        if (top === second) return; /* ties snap the streak */
        winners[String(sorted[0].roster_id)] = 1;
      });
      Object.keys(played).forEach(rid => {
        if (winners[rid]){
          streakCur[rid] = (streakCur[rid] || 0) + 1;
          streakMax[rid] = Math.max(streakMax[rid] || 0, streakCur[rid]);
          if (streakCur[rid] === WIN_STREAK_THRESHOLD){
            streak10[rid] = (streak10[rid] || 0) + 1;
          }
        } else {
          streakCur[rid] = 0;
        }
      });
    });
    return {
      byRoster,
      weeksScored,
      throughWeek: end,
      playoffWeekStart: playoffStart || null,
      maxWinStreak: streakMax,
      winStreaks10: streak10
    };
  }

  /* Winners-bracket stats: playoff wins, runner-up, 3rd place. */
  async function winnersBracketStats(leagueId){
    const playoffWins = {};
    const runnerUps = {};
    const thirdPlaces = {};
    try {
      const bracket = await fetchJson('https://api.sleeper.app/v1/league/' + leagueId + '/winners_bracket');
      const games = Array.isArray(bracket) ? bracket : [];
      games.forEach(g => {
        if (g == null || g.w == null) return;
        const id = String(g.w);
        playoffWins[id] = (playoffWins[id] || 0) + 1;
      });
      let finals = games.filter(g => Number(g.p) === 1);
      if (!finals.length){
        const maxR = Math.max.apply(null, games.map(g => Number(g.r) || 0).concat([0]));
        if (maxR > 0){
          finals = games.filter(g => Number(g.r) === maxR && (g.p == null || Number(g.p) === 1));
        }
      }
      finals.forEach(g => {
        if (g == null || g.l == null) return;
        runnerUps[String(g.l)] = 1;
      });
      games.filter(g => Number(g.p) === 3).forEach(g => {
        if (g == null || g.w == null) return;
        thirdPlaces[String(g.w)] = 1;
      });
    } catch (e){ /* no bracket yet */ }
    return { playoffWins, runnerUps, thirdPlaces };
  }

  async function playoffWinsByRoster(leagueId){
    const stats = await winnersBracketStats(leagueId);
    return stats.playoffWins;
  }

  async function championForLeague(league, teams){
    const byRoster = {};
    teams.forEach(t => { byRoster[String(t.rosterId)] = t; });
    const metaWinner = league.metadata && league.metadata.latest_league_winner_roster_id;
    if (metaWinner != null && byRoster[String(metaWinner)]){
      const t = byRoster[String(metaWinner)];
      return {
        key: t.key, displayName: t.displayName, manager: t.manager || '', ownerId: t.ownerId || null,
        value: 1, runnerUp: null, source: 'metadata'
      };
    }
    try {
      const bracket = await fetchJson('https://api.sleeper.app/v1/league/' + league.league_id + '/winners_bracket');
      if (!Array.isArray(bracket) || !bracket.length) return null;
      const maxR = Math.max.apply(null, bracket.map(b => Number(b.r) || 0));
      const finals = bracket.filter(b => Number(b.r) === maxR && b.p === 1);
      const game = finals[0] || bracket.filter(b => Number(b.r) === maxR)[0];
      if (!game || game.w == null) return null;
      const t = byRoster[String(game.w)];
      if (!t) return null;
      return {
        key: t.key, displayName: t.displayName, manager: t.manager || '', ownerId: t.ownerId || null,
        value: 1, runnerUp: null, source: 'bracket'
      };
    } catch (e){
      return null;
    }
  }

  async function coachEfficiency(league, teams, playerDb){
    const Needs = global.TeamNeedsModel;
    if (!Needs || !Needs.optimize || !Needs.parseSlots){
      return { byKey: {}, weeksUsed: 0, error: 'TeamNeedsModel unavailable' };
    }
    const slots = Needs.parseSlots(league.roster_positions || []);
    if (!slots.length) return { byKey: {}, weeksUsed: 0, error: 'no starter slots' };

    const sums = {};
    const counts = {};
    teams.forEach(t => { sums[t.key] = 0; counts[t.key] = 0; });
    const byRoster = {};
    teams.forEach(t => { byRoster[String(t.rosterId)] = t; });

    const weekFetches = Array.from({ length: 25 }, (_, i) => i + 1).map(w =>
      fetch('https://api.sleeper.app/v1/league/' + league.league_id + '/matchups/' + w)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    );
    const allWeeks = await Promise.all(weekFetches);

    let weeksUsed = 0;
    allWeeks.forEach(matchups => {
      if (!Array.isArray(matchups) || !matchups.length) return;
      const scored = matchups.filter(m => Number(m.points) > 0);
      if (scored.length < Math.min(4, teams.length)) return;
      weeksUsed++;

      scored.forEach(m => {
        const t = byRoster[String(m.roster_id)];
        if (!t) return;
        const ptsMap = m.players_points || {};
        const rosterPlayers = (m.players || t.players || []).map(String);
        const recs = rosterPlayers.map(pid => {
          const pl = (playerDb && playerDb[pid]) || {};
          const metric = Number(ptsMap[pid]);
          if (!Number.isFinite(metric) || metric <= 0) return null;
          return {
            id: pid,
            positions: pl.fantasy_positions || [pl.position].filter(Boolean),
            metric
          };
        }).filter(Boolean);
        const opt = Needs.optimize(recs, slots);
        const optimal = opt && Number(opt.total) > 0 ? opt.total : null;
        const actual = Number(m.points);
        if (optimal == null || !(actual >= 0)) return;
        const eff = Math.min(1, actual / optimal);
        sums[t.key] += eff;
        counts[t.key] += 1;
      });
    });

    const byKey = {};
    const weeksByKey = {};
    Object.keys(sums).forEach(key => {
      if (counts[key] > 0){
        byKey[key] = sums[key] / counts[key];
        weeksByKey[key] = counts[key];
      }
    });
    return { byKey, weeksByKey, weeksUsed };
  }

  async function loadLeagueBundle(leagueId){
    const [league, users, rosters] = await Promise.all([
      fetchJson('https://api.sleeper.app/v1/league/' + leagueId),
      fetchJson('https://api.sleeper.app/v1/league/' + leagueId + '/users'),
      fetchJson('https://api.sleeper.app/v1/league/' + leagueId + '/rosters')
    ]);
    const teams = buildTeams(users, rosters);
    return { league, users, rosters, teams };
  }

  function awardRecord(id, season, winner, pending){
    const def = AWARD_DEFS.find(a => a.id === id) || { id, name: id, short: id };
    return {
      id,
      name: def.name,
      short: def.short,
      season: String(season),
      yearLabel: yearLabel(season),
      seasonTag: seasonTag(season),
      pending: !!pending,
      winner: winner ? {
        key: winner.key,
        displayName: winner.displayName,
        manager: winner.manager || '',
        ownerId: winner.ownerId || null,
        value: winner.value,
        runnerUp: winner.runnerUp || null
      } : null
    };
  }

  async function computeSeasonAwards(bundle, opts){
    const { league, teams } = bundle;
    const scoring = league.scoring_settings || {};
    const season = league.season;
    const complete = league.status === 'complete';
    const pending = !complete;

    let statsSeason = season;
    if (league.previous_league_id){
      try {
        const prev = await fetchJson('https://api.sleeper.app/v1/league/' + league.previous_league_id);
        statsSeason = prev.season;
      } catch (e){ /* keep */ }
    }

    const { ceiling } = await loadWeeklyCeilings(statsSeason, scoring);
    const bracketStats = await winnersBracketStats(league.league_id);
    const playoffWins = bracketStats.playoffWins || {};
    const runnerUps = bracketStats.runnerUps || {};
    const thirdPlaces = bracketStats.thirdPlaces || {};
    const rsPf = await regularSeasonPfByRoster(league);
    const maxWinStreak = rsPf.maxWinStreak || {};
    const winStreaks10 = rsPf.winStreaks10 || {};
    const rows = teams.map(t => {
      const mp = maxPointsForTeam(t.players, ceiling);
      const gp = gamesPlayed(t);
      const rid = String(t.rosterId);
      const pf = rsPf.byRoster[rid] != null ? rsPf.byRoster[rid] : t.pf;
      const ppg = gp > 0 && pf != null ? pf / gp : null;
      return {
        key: t.key,
        displayName: t.displayName,
        manager: t.manager || '',
        ownerId: t.ownerId || null,
        pf,
        wins: Number(t.wins) || 0,
        losses: Number(t.losses) || 0,
        ties: Number(t.ties) || 0,
        playoffWins: playoffWins[rid] || 0,
        runnerUp: runnerUps[rid] ? 1 : 0,
        thirdPlace: thirdPlaces[rid] ? 1 : 0,
        maxWinStreak: maxWinStreak[rid] || 0,
        winStreaks10: winStreaks10[rid] || 0,
        gp,
        pfPerGame: ppg,
        maxPts: mp.maxPts,
        counted: mp.counted,
        rosterId: t.rosterId,
        players: (t.players || []).map(String)
      };
    });

    const awards = [];

    /* Champion */
    let champ = null;
    if (complete) champ = await championForLeague(league, teams);
    awards.push(awardRecord('champion', season, champ, !champ));

    /* MVP = most regular-season Points For (weeks before playoffs). */
    const maxGpLive = Math.max.apply(null, rows.map(r => r.gp || 0).concat([0]));
    const mvpReady = !pending || maxGpLive >= 1 || (rsPf.weeksScored || 0) >= 1;
    const mvp = mvpReady ? pickWinner(rows, 'pf') : null;
    awards.push(awardRecord('mvp', season, mvp, pending || !mvp));

    /* Coach */
    let coachWinner = null;
    let coachMeta = { weeksUsed: 0 };
    let coachRows = [];
    if (opts && opts.playerDb && opts.computeCoach !== false){
      const coach = await coachEfficiency(league, teams, opts.playerDb);
      coachMeta = coach;
      coachRows = teams.map(t => ({
        key: t.key,
        displayName: t.displayName,
        manager: t.manager || '',
        ownerId: t.ownerId || null,
        coachEff: coach.byKey[t.key],
        coachWeeks: coach.weeksByKey[t.key] || 0,
        maxPts: (rows.find(r => r.key === t.key) || {}).maxPts,
        pf: t.pf
      }));
      rows.forEach(r => {
        if (coach.byKey[r.key] != null) r.coachEff = coach.byKey[r.key];
        if (coach.weeksByKey[r.key]) r.coachWeeks = coach.weeksByKey[r.key];
      });
      coachWinner = pickWinner(coachRows, 'coachEff');
    }
    awards.push(awardRecord('coach', season, coachWinner, pending || !coachWinner));

    /* MIP / GM need prior season — filled by computeAll */
    awards.push(awardRecord('mip', season, null, true));
    awards.push(awardRecord('gm', season, null, true));

    return {
      season: String(season),
      seasonTag: seasonTag(season),
      complete,
      pending,
      rows,
      coachRows,
      ceiling,
      awards,
      coachMeta
    };
  }

  /* —— Dynasty value (same formula as Trade Analyzer) —— */
  const AGE_MULT = { young: 1.10, prime: 1.0, decline: 0.9, unknown: 1.0 };
  const ESPN_ROOKIE_OUTLOOK = {
    ajdybantsa:{floor:45}, darrynpeterson:{floor:44}, cameronboozer:{floor:24},
    calebwilson:{floor:18}, braydenburries:{floor:16}, mikelbrownjr:{floor:15},
    mikelbrown:{floor:15}, yaxellendeborg:{floor:14}, morezjohnsonjr:{floor:13},
    morezjohnson:{floor:13}, kingstonflemings:{floor:13}, keatonwagler:{floor:12},
    dariusacuffjr:{floor:12}, dariusacuff:{floor:12}
  };
  const INJURY_PRONE = {
    zionwilliamson:0.86, kawhileonard:0.88, anthonydavis:0.90, joelembiid:0.87,
    kristapsporzingis:0.88, jamorant:0.91, kyrieirving:0.92, brandoningram:0.92,
    jonathanisaac:0.84, lonzoball:0.83, bensimmons:0.82, paulgeorge:0.90,
    jamalmurray:0.93, tylerherro:0.94, scoothenderson:0.93, darrynpeterson:0.93,
    keeganmurray:0.95, jalenwilliams:0.95, chetholmgren:0.94
  };
  const DYN_HIST_W = 0.5;
  const DYN_PROJ_W = 0.5;

  function normalizePlayerName(name){
    return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[.\u2019']/g, '').replace(/[^a-z0-9]/g, '');
  }
  function sleeperPlayerName(p){
    if (!p) return '';
    if (p.full_name) return p.full_name;
    return ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
  }
  function scoreStatLine(stats, scoring){
    if (!stats || !scoring) return null;
    let total = 0, matched = 0;
    Object.keys(scoring).forEach(k => {
      if (stats[k] != null && Number.isFinite(Number(stats[k]))){
        total += Number(stats[k]) * scoring[k];
        matched++;
      }
    });
    return matched ? total : null;
  }
  function perGameStats(seasonTotals){
    if (!seasonTotals) return null;
    const gp = Number(seasonTotals.gp || seasonTotals.gms_active || 0);
    if (!(gp > 0)) return null;
    const out = {};
    Object.keys(seasonTotals).forEach(k => {
      const v = Number(seasonTotals[k]);
      if (!Number.isFinite(v)) return;
      if (k === 'gp' || k === 'gs' || k === 'gms_active') return;
      if (/^rank|pos_rank|pts_std|sp$|plus_minus|fg_pct|ft_pct|tp_pct/i.test(k)) return;
      out[k] = v / gp;
    });
    return out;
  }

  async function loadDynastyMaps(scoring, season){
    const TWO_K = global.TWO_K_SNAPSHOT || { rookies: [], ratings: [] };
    const ROOKIE_NAMES = new Set((TWO_K.rookies || []).map(p => normalizePlayerName(p.name)));
    const RATINGS_BY_NAME = new Map((TWO_K.ratings || []).map(p => [normalizePlayerName(p.name), p]));

    const consById = new Map();
    const consByName = new Map();
    const pack = global.NBA_PROJ_CONSENSUS || {};
    /* Consensus snapshot is current-season only — skip it for historical at-time grades. */
    const useConsensus = !pack.season || String(pack.season) === String(season);
    if (useConsensus){
      Object.keys(pack.players || {}).forEach(key => {
        const row = pack.players[key];
        const fp = scoreStatLine(row.stats, scoring);
        if (fp == null) return;
        if (row.sleeperId) consById.set(String(row.sleeperId), fp);
        consByName.set(normalizePlayerName(row.name), fp);
        consByName.set(key, fp);
      });
    }

    const sleeperById = new Map();
    const sleeperByName = new Map();
    try {
      const res = await fetch('https://api.sleeper.com/projections/nba/' + season + '?season_type=regular');
      if (res.ok){
        const rows = await res.json();
        (Array.isArray(rows) ? rows : []).forEach(row => {
          const pl = row.player || {};
          const pid = row.player_id || pl.player_id;
          const name = sleeperPlayerName(pl);
          const fp = scoreStatLine(row.stats || {}, scoring);
          if (fp == null || !(fp > 0)) return;
          if (pid != null) sleeperById.set(String(pid), fp);
          if (name) sleeperByName.set(normalizePlayerName(name), fp);
        });
      }
    } catch (e){ /* optional */ }

    const histById = new Map();
    const y = Number(season) || new Date().getFullYear();
    await Promise.all([y - 1, y - 2, y - 3].map(async sy => {
      try {
        const res = await fetch('https://api.sleeper.app/v1/stats/nba/regular/' + sy);
        if (!res.ok) return;
        const rows = await res.json();
        Object.keys(rows || {}).forEach(pid => {
          const per = perGameStats(rows[pid]);
          const fp = scoreStatLine(per, scoring);
          if (fp == null) return;
          const id = String(pid);
          const slot = histById.get(id) || { sum: 0, n: 0 };
          slot.sum += fp;
          slot.n += 1;
          histById.set(id, slot);
        });
      } catch (e){ /* skip */ }
    }));
    const histAvgById = new Map();
    histById.forEach((slot, id) => { if (slot.n) histAvgById.set(id, slot.sum / slot.n); });

    function ageBand(rec){
      const a = Number(rec.age);
      const isRookie = rec.source === 'rookie' || ROOKIE_NAMES.has(normalizePlayerName(rec.name)) || Number(rec.yearsExp) === 0;
      if (!Number.isFinite(a) || a <= 0) return isRookie ? 'young' : 'unknown';
      if (a < 24) return 'young';
      if (a <= 32) return 'prime';
      return 'decline';
    }
    function dynastyValueFor(rec){
      const key = normalizePlayerName(rec.name);
      const isRookie = rec.source === 'rookie' || ROOKIE_NAMES.has(key) || Number(rec.yearsExp) === 0;
      const proj = Number(rec.metric);
      const sleeper = Number(rec.sleeperMetric);
      const hist = Number(rec.histMetric);
      const floor = ESPN_ROOKIE_OUTLOOK[key] && Number(ESPN_ROOKIE_OUTLOOK[key].floor);
      let base = null;
      if (isRookie){
        const s = Number.isFinite(sleeper) && sleeper > 0 ? sleeper : null;
        const c = Number.isFinite(floor) && floor > 0 ? floor : null;
        if (s != null && c != null) base = DYN_PROJ_W * s + DYN_HIST_W * c;
        else if (s != null) base = s;
        else if (c != null) base = c;
        else if (Number.isFinite(proj) && proj > 0) base = proj;
      } else {
        const p = Number.isFinite(proj) && proj > 0 ? proj : null;
        const h = Number.isFinite(hist) && hist > 0 ? hist : null;
        if (p != null && h != null) base = DYN_PROJ_W * p + DYN_HIST_W * h;
        else if (p != null) base = p;
        else if (h != null) base = h;
      }
      let inj = INJURY_PRONE[key];
      if (inj == null) inj = 1;
      /* Live tags ignored May–Sep; chronic INJURY_PRONE list still applies. */
      const inOffseason = (function(){ const mo = new Date().getUTCMonth(); return mo >= 4 && mo <= 8; })();
      if (!inOffseason){
        const status = String(rec.injuryStatus || '').toLowerCase();
        if (status === 'out' || status === 'ir' || status === 'injured reserve') inj *= 0.94;
        else if (status === 'doubtful') inj *= 0.96;
        else if (status === 'questionable') inj *= 0.98;
      }
      const age = AGE_MULT[ageBand(rec)] || 1.0;
      if (base == null) return 0;
      let v = base * age;
      if (ageBand(rec) === 'young') v += 1;
      return Math.max(0, v * inj);
    }

    function valueForPid(pid, playerDb){
      const p = (playerDb && playerDb[pid]) || {};
      const name = sleeperPlayerName(p);
      const key = normalizePlayerName(name);
      const hit = RATINGS_BY_NAME.get(key);
      const rec = {
        name,
        age: p.age ?? null,
        yearsExp: p.years_exp ?? null,
        injuryStatus: p.injury_status || null,
        source: ROOKIE_NAMES.has(key) || Number(p.years_exp) === 0 ? 'rookie' : null,
        ovr: hit && hit.ovr != null ? hit.ovr : null,
        metric: consById.get(String(pid)) ?? consByName.get(key) ?? null,
        sleeperMetric: sleeperById.get(String(pid)) ?? sleeperByName.get(key) ?? null,
        histMetric: histAvgById.get(String(pid)) ?? null
      };
      return dynastyValueFor(rec);
    }

    function rosterDynastyTotal(players, playerDb){
      let total = 0;
      (players || []).forEach(pid => { total += valueForPid(String(pid), playerDb); });
      return total;
    }

    return { valueForPid, rosterDynastyTotal, ROOKIE_NAMES };
  }

  /* Players on the current roster who were not on the prior season-end roster. */
  function addedPlayerIds(currentPlayers, priorPlayers){
    const prior = new Set((priorPlayers || []).map(String));
    return (currentPlayers || []).map(String).filter(id => id && !prior.has(id));
  }

  /* GM = greatest YoY gain in total roster dynasty value (same formula as Trade Analyzer). */
  function scoreGmDynastyDelta(pack, priorPack, dynastyMaps, playerDb){
    if (!pack || !pack.gmRows || !pack.gmRows.length || !priorPack || !dynastyMaps) return pack;
    const priorByKey = {};
    (priorPack.rows || []).forEach(r => { priorByKey[r.key] = r; });

    pack.gmRows.forEach(r => {
      const prev = priorByKey[r.key];
      const curTotal = dynastyMaps.rosterDynastyTotal(r.players || (pack.rows.find(x => x.key === r.key) || {}).players, playerDb);
      const prevTotal = prev
        ? dynastyMaps.rosterDynastyTotal(prev.players, playerDb)
        : 0;
      r.dynastyNow = curTotal;
      r.dynastyPrior = prevTotal;
      r.gmDelta = curTotal - prevTotal;
    });

    const gm = pickWinner(pack.gmRows, 'gmDelta');
    pack.awards = (pack.awards || []).map(a => {
      if (a.id === 'gm') return awardRecord('gm', pack.season, gm, pack.pending || !gm);
      return a;
    });
    pack.gmMeta = { method: 'dynasty-delta' };
    return pack;
  }

  /* Founding season (no prior league): GM = highest end-of-season roster dynasty total. */
  function scoreGmAbsolute(pack, dynastyMaps, playerDb){
    if (!pack || !dynastyMaps) return pack;
    const gmRows = (pack.rows || []).map(r => {
      const total = dynastyMaps.rosterDynastyTotal(r.players, playerDb);
      return {
        key: r.key,
        displayName: r.displayName,
        manager: r.manager || '',
        ownerId: r.ownerId || null,
        rosterId: r.rosterId,
        players: r.players,
        dynastyNow: total,
        dynastyPrior: 0,
        gmDelta: total,
        maxPts: r.maxPts,
        pf: r.pf
      };
    });
    pack.gmRows = gmRows;
    const gm = pickWinner(gmRows, 'gmDelta');
    pack.awards = (pack.awards || []).map(a => {
      if (a.id === 'gm') return awardRecord('gm', pack.season, gm, pack.pending || !gm);
      return a;
    });
    pack.gmMeta = { method: 'dynasty-total' };
    return pack;
  }

  function attachYoY(currentPack, priorPack){
    if (!currentPack || !priorPack) return currentPack;
    const priorByKey = {};
    (priorPack.rows || []).forEach(r => { priorByKey[r.key] = r; });

    const mipRows = [];
    const gmRows = [];
    (currentPack.rows || []).forEach(r => {
      const prev = priorByKey[r.key];
      if (!prev) return;
      const curPpg = r.pfPerGame != null ? r.pfPerGame
        : (r.gp > 0 ? r.pf / r.gp : null);
      const prevPpg = prev.pfPerGame != null ? prev.pfPerGame
        : (prev.gp > 0 ? prev.pf / prev.gp : null);
      if (curPpg != null && prevPpg != null){
        mipRows.push({
          key: r.key,
          displayName: r.displayName,
          manager: r.manager || '',
          ownerId: r.ownerId || null,
          mipDelta: curPpg - prevPpg,
          maxPts: r.maxPts,
          pf: r.pf,
          pfPerGame: curPpg
        });
      }
      const added = addedPlayerIds(r.players, prev.players);
      gmRows.push({
        key: r.key,
        displayName: r.displayName,
        manager: r.manager || '',
        ownerId: r.ownerId || null,
        rosterId: r.rosterId,
        players: r.players,
        addedPlayers: added,
        addedCount: added.length,
        gmDelta: 0,
        maxPts: r.maxPts,
        pf: r.pf
      });
    });

    const maxGp = Math.max.apply(null, (currentPack.rows || []).map(r => r.gp || 0).concat([0]));
    const mipReady = !currentPack.pending || maxGp >= 1;
    const mip = mipReady ? pickWinner(mipRows, 'mipDelta') : null;
    currentPack.awards = (currentPack.awards || []).map(a => {
      if (a.id === 'mip') return awardRecord('mip', currentPack.season, mip, currentPack.pending || !mip);
      return a;
    });
    currentPack.mipRows = mipRows;
    currentPack.gmRows = gmRows;
    return currentPack;
  }

  function managerIdentity(row){
    if (!row) return null;
    if (row.ownerId != null && String(row.ownerId)) return 'oid:' + String(row.ownerId);
    const mgr = String(row.manager || '').trim();
    if (mgr) return 'mgr:' + normalizeTeamName(mgr);
    return null;
  }

  function seasonWinPct(r){
    const w = Number(r && r.wins) || 0;
    const l = Number(r && r.losses) || 0;
    const t = Number(r && r.ties) || 0;
    const g = w + l + t;
    if (g <= 0) return null;
    return (w + 0.5 * t) / g;
  }

  function isGoodSeasonRow(r){
    const pct = seasonWinPct(r);
    return pct != null && pct + 1e-9 >= GOOD_SEASON_WIN_PCT;
  }

  function emptyGoatRow(key, displayName){
    return {
      key,
      displayName: displayName || key,
      ownerId: null,
      franchise: '',
      points: 0,
      awardPoints: 0,
      winPoints: 0,
      playoffWinPoints: 0,
      runnerUpPoints: 0,
      thirdPlacePoints: 0,
      goodSeasonPoints: 0,
      winStreakPoints: 0,
      seasonWins: 0,
      playoffWins: 0,
      runnerUps: 0,
      thirdPlaces: 0,
      goodSeasons: 0,
      winStreaks: 0,
      lineupEffSum: 0,
      lineupEffWeeks: 0,
      lineupEfficiency: null,
      counts: {},
      hardware: [],
      rank: null
    };
  }

  function ensureGoatRow(byKey, identity, displayName, ownerId, franchise){
    if (!identity) return null;
    if (!byKey[identity]) byKey[identity] = emptyGoatRow(identity, displayName);
    const row = byKey[identity];
    if (displayName) row.displayName = displayName;
    if (ownerId != null) row.ownerId = ownerId;
    if (franchise) row.franchise = franchise;
    return row;
  }

  function buildGoatStandings(seasonPacks){
    const byKey = {};
    const winBundlePts = Number(GOAT_POINTS.win) || 0;
    const playoffBundlePts = Number(GOAT_POINTS.playoff_win) || 0;
    const runnerPts = Number(GOAT_POINTS.runner_up) || 0;
    const thirdPts = Number(GOAT_POINTS.third_place) || 0;
    const goodPts = Number(GOAT_POINTS.good_season) || 0;
    const streakPts = Number(GOAT_POINTS.win_streak) || 0;

    (seasonPacks || []).forEach(pack => {
      (pack.rows || []).forEach(r => {
        const id = managerIdentity(r);
        const row = ensureGoatRow(byKey, id, r.manager || r.displayName, r.ownerId, r.displayName);
        if (!row) return;
        const w = Number(r.wins) || 0;
        if (w > 0) row.seasonWins += w;
        /* Career lineup efficiency (display only — no GOAT points). */
        const eff = Number(r.coachEff);
        const effWeeks = Number(r.coachWeeks) || 0;
        if (Number.isFinite(eff) && effWeeks > 0){
          row.lineupEffSum += eff * effWeeks;
          row.lineupEffWeeks += effWeeks;
        } else if (Number.isFinite(eff)){
          row.lineupEffSum += eff;
          row.lineupEffWeeks += 1;
        }
        /* Good Season locks with the year — same cadence as hardware accolades. */
        if (pack.complete && goodPts && isGoodSeasonRow(r)){
          const pct = seasonWinPct(r);
          row.goodSeasons += 1;
          row.goodSeasonPoints += goodPts;
          row.points += goodPts;
          row.counts.good_season = (row.counts.good_season || 0) + 1;
          row.hardware.push({
            id: 'good_season',
            name: 'Good Season',
            short: 'GS',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            seasonTag: pack.seasonTag,
            points: goodPts,
            value: pct
          });
        }
        /* 10+ win streaks pay when achieved (including live seasons). */
        const streaks = Number(r.winStreaks10) || 0;
        if (streaks > 0 && streakPts){
          row.winStreaks += streaks;
          row.winStreakPoints += streaks * streakPts;
          row.points += streaks * streakPts;
          row.counts.win_streak = (row.counts.win_streak || 0) + streaks;
          row.hardware.push({
            id: 'win_streak',
            name: WIN_STREAK_THRESHOLD + '+ win streak',
            short: 'WS',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            seasonTag: pack.seasonTag,
            points: streaks * streakPts,
            value: Number(r.maxWinStreak) || (WIN_STREAK_THRESHOLD * streaks)
          });
        }
        const pw = Number(r.playoffWins) || 0;
        if (pw > 0) row.playoffWins += pw;
        const ru = Number(r.runnerUp) || 0;
        if (ru > 0 && runnerPts){
          row.runnerUps += ru;
          row.runnerUpPoints += ru * runnerPts;
          row.points += ru * runnerPts;
          row.counts.runner_up = (row.counts.runner_up || 0) + ru;
          row.hardware.push({
            id: 'runner_up',
            name: 'Runner-up',
            short: '2nd',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            seasonTag: pack.seasonTag,
            points: ru * runnerPts,
            value: ru
          });
        }
        const tp = Number(r.thirdPlace) || 0;
        if (tp > 0 && thirdPts){
          row.thirdPlaces += tp;
          row.thirdPlacePoints += tp * thirdPts;
          row.points += tp * thirdPts;
          row.counts.third_place = (row.counts.third_place || 0) + tp;
          row.hardware.push({
            id: 'third_place',
            name: '3rd place',
            short: '3rd',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            seasonTag: pack.seasonTag,
            points: tp * thirdPts,
            value: tp
          });
        }
      });
      (pack.awards || []).forEach(a => {
        if (!a.winner || a.pending || a.id === 'goat') return;
        const pts = Number(GOAT_POINTS[a.id]) || 0;
        if (!pts) return;
        /* Fallback: match winner franchise key to a row that season. */
        let winnerMeta = a.winner;
        if (!managerIdentity(a.winner)){
          const match = (pack.rows || []).find(r => r.key === a.winner.key);
          if (match) winnerMeta = match;
        }
        const mid = managerIdentity(winnerMeta);
        const row = ensureGoatRow(
          byKey,
          mid,
          winnerMeta.manager || a.winner.manager || a.winner.displayName,
          winnerMeta.ownerId || a.winner.ownerId,
          winnerMeta.displayName || a.winner.displayName
        );
        if (!row) return;
        row.points += pts;
        row.awardPoints += pts;
        row.counts[a.id] = (row.counts[a.id] || 0) + 1;
        row.hardware.push({
          id: a.id,
          name: a.name,
          short: a.short,
          season: a.season,
          yearLabel: a.yearLabel,
          seasonTag: a.seasonTag,
          points: pts,
          value: a.winner.value
        });
      });
    });

    /* Career win bundles — integer only, no leftover fractional points.
       Lineup efficiency is tracked for the board only (no GOAT points). */
    Object.values(byKey).forEach(row => {
      if (row.lineupEffWeeks > 0){
        row.lineupEfficiency = row.lineupEffSum / row.lineupEffWeeks;
      }
      const rsBundles = Math.floor((Number(row.seasonWins) || 0) / RS_WIN_BUNDLE_SIZE);
      if (rsBundles > 0 && winBundlePts){
        const pts = rsBundles * winBundlePts;
        row.winPoints = pts;
        row.points += pts;
        row.counts.win = rsBundles;
        row.hardware.push({
          id: 'win',
          name: 'Regular-season win bundles',
          short: 'W',
          season: 'career',
          yearLabel: 'Career',
          seasonTag: 'career',
          points: pts,
          value: rsBundles * RS_WIN_BUNDLE_SIZE
        });
      }
      const poBundles = Math.floor((Number(row.playoffWins) || 0) / PLAYOFF_WIN_BUNDLE_SIZE);
      if (poBundles > 0 && playoffBundlePts){
        const pts = poBundles * playoffBundlePts;
        row.playoffWinPoints = pts;
        row.points += pts;
        row.counts.playoff_win = poBundles;
        row.hardware.push({
          id: 'playoff_win',
          name: 'Playoff win bundles',
          short: 'PW',
          season: 'career',
          yearLabel: 'Career',
          seasonTag: 'career',
          points: pts,
          value: poBundles * PLAYOFF_WIN_BUNDLE_SIZE
        });
      }
    });

    const rows = Object.values(byKey).sort((a, b) =>
      b.points - a.points
      || (b.counts.champion || 0) - (a.counts.champion || 0)
      || (b.counts.runner_up || 0) - (a.counts.runner_up || 0)
      || (b.counts.third_place || 0) - (a.counts.third_place || 0)
      || (b.counts.mvp || 0) - (a.counts.mvp || 0)
      || (b.counts.coach || 0) - (a.counts.coach || 0)
      || (b.counts.gm || 0) - (a.counts.gm || 0)
      || (b.counts.mip || 0) - (a.counts.mip || 0)
      || (b.counts.good_season || 0) - (a.counts.good_season || 0)
      || (b.counts.win_streak || 0) - (a.counts.win_streak || 0)
      || b.playoffWins - a.playoffWins
      || b.seasonWins - a.seasonWins
      || String(a.displayName).localeCompare(String(b.displayName))
    );
    rows.forEach((r, i) => { r.rank = i + 1; });
    const goat = rows[0] && rows[0].points > 0 ? rows[0] : null;
    return {
      points: Object.assign({}, GOAT_POINTS),
      goodSeasonWinPct: GOOD_SEASON_WIN_PCT,
      winStreakThreshold: WIN_STREAK_THRESHOLD,
      rsWinBundleSize: RS_WIN_BUNDLE_SIZE,
      playoffWinBundleSize: PLAYOFF_WIN_BUNDLE_SIZE,
      rows,
      goat: goat ? {
        key: goat.key,
        displayName: goat.displayName,
        manager: goat.displayName,
        ownerId: goat.ownerId,
        franchise: goat.franchise,
        value: goat.points,
        points: goat.points,
        counts: goat.counts,
        seasonWins: goat.seasonWins,
        playoffWins: goat.playoffWins,
        runnerUps: goat.runnerUps,
        thirdPlaces: goat.thirdPlaces,
        goodSeasons: goat.goodSeasons,
        winStreaks: goat.winStreaks,
        lineupEfficiency: goat.lineupEfficiency,
        awardPoints: goat.awardPoints,
        winPoints: goat.winPoints,
        playoffWinPoints: goat.playoffWinPoints,
        runnerUpPoints: goat.runnerUpPoints,
        thirdPlacePoints: goat.thirdPlacePoints,
        goodSeasonPoints: goat.goodSeasonPoints,
        winStreakPoints: goat.winStreakPoints
      } : null
    };
  }

  function medalClass(id){
    if (id === 'champion') return 'medal-gold';
    if (id === 'runner_up') return 'medal-silver';
    if (id === 'third_place') return 'medal-bronze';
    return '';
  }

  function badgesByFranchise(seasonPacks, goatPack){
    const byKey = {};
    (seasonPacks || []).forEach(pack => {
      (pack.awards || []).forEach(a => {
        if (!a.winner || a.pending || a.id === 'goat') return;
        const key = a.winner.key;
        if (!byKey[key]) byKey[key] = [];
        byKey[key].push({
          id: a.id,
          name: a.name,
          short: a.short,
          season: a.season,
          yearLabel: a.yearLabel,
          value: a.winner.value,
          goatPoints: GOAT_POINTS[a.id] || 0,
          medal: medalClass(a.id)
        });
      });
      (pack.rows || []).forEach(r => {
        if (!byKey[r.key]) byKey[r.key] = [];
        if (r.runnerUp){
          byKey[r.key].push({
            id: 'runner_up',
            name: 'Runner-up',
            short: '2nd',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            value: 1,
            goatPoints: GOAT_POINTS.runner_up || 0,
            medal: 'medal-silver'
          });
        }
        if (r.thirdPlace){
          byKey[r.key].push({
            id: 'third_place',
            name: '3rd place',
            short: '3rd',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            value: 1,
            goatPoints: GOAT_POINTS.third_place || 0,
            medal: 'medal-bronze'
          });
        }
        if (pack.complete && isGoodSeasonRow(r) && (GOAT_POINTS.good_season || 0)){
          byKey[r.key].push({
            id: 'good_season',
            name: 'Good Season',
            short: 'GS',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            value: seasonWinPct(r),
            goatPoints: GOAT_POINTS.good_season || 0,
            medal: ''
          });
        }
        const streaks = Number(r.winStreaks10) || 0;
        if (streaks > 0 && (GOAT_POINTS.win_streak || 0)){
          byKey[r.key].push({
            id: 'win_streak',
            name: WIN_STREAK_THRESHOLD + '+ win streak',
            short: 'WS',
            season: pack.season,
            yearLabel: yearLabel(pack.season),
            value: Number(r.maxWinStreak) || WIN_STREAK_THRESHOLD,
            goatPoints: streaks * (GOAT_POINTS.win_streak || 0),
            medal: ''
          });
        }
      });
    });
    const goat = goatPack && goatPack.goat;
    if (goat){
      const currentRows = (seasonPacks && seasonPacks[0] && seasonPacks[0].rows) || [];
      const match = currentRows.find(r =>
        (goat.ownerId != null && String(r.ownerId) === String(goat.ownerId))
        || (goat.displayName && r.manager === goat.displayName)
      );
      const franchiseKey = match ? match.key : (goat.franchise || null);
      if (franchiseKey){
        if (!byKey[franchiseKey]) byKey[franchiseKey] = [];
        byKey[franchiseKey].unshift({
          id: 'goat',
          name: 'GOAT',
          short: 'GOAT',
          season: 'career',
          yearLabel: 'Career',
          value: goat.points,
          goatPoints: 0,
          medal: ''
        });
      }
    }
    const podiumOrder = { champion: 0, runner_up: 1, third_place: 2 };
    Object.keys(byKey).forEach(key => {
      byKey[key].sort((a, b) => {
        if (a.id === 'goat') return -1;
        if (b.id === 'goat') return 1;
        return Number(b.season) - Number(a.season)
          || (podiumOrder[a.id] != null ? podiumOrder[a.id] : 9) - (podiumOrder[b.id] != null ? podiumOrder[b.id] : 9)
          || AWARD_DEFS.findIndex(d => d.id === a.id) - AWARD_DEFS.findIndex(d => d.id === b.id);
      });
    });
    return byKey;
  }

  async function compute(leagueId, options){
    const opts = options || {};
    const rootId = leagueId || LEAGUE_ID;
    let playerDb = opts.playerDb || null;
    if (!playerDb){
      try { playerDb = await fetchJson('https://api.sleeper.app/v1/players/nba'); }
      catch (e){ playerDb = null; }
    }

    /* Walk the full previous_league_id chain (current + completed seasons). */
    const bundles = [];
    let cursor = rootId;
    const seen = new Set();
    while (cursor && !seen.has(String(cursor))){
      seen.add(String(cursor));
      try {
        const bundle = await loadLeagueBundle(cursor);
        bundles.push(bundle);
        cursor = bundle.league.previous_league_id || null;
      } catch (e){
        break;
      }
    }

    if (!bundles.length) throw new Error('Could not load league ' + rootId);

    const scoring = bundles[0].league.scoring_settings || {};
    const dynastyMaps = await loadDynastyMaps(scoring, bundles[0].league.season || '2026');

    const packs = [];
    for (let i = 0; i < bundles.length; i++){
      const bundle = bundles[i];
      const wantCoach = opts.computeCoach !== false;
      const pack = await computeSeasonAwards(bundle, { playerDb, computeCoach: wantCoach });
      pack.leagueId = bundle.league.league_id;
      packs.push(pack);
    }

    /* Attach YoY (MIP + GM roster lists): each pack uses the next (older) season as prior. */
    for (let i = 0; i < packs.length - 1; i++){
      attachYoY(packs[i], packs[i + 1]);
      scoreGmDynastyDelta(packs[i], packs[i + 1], dynastyMaps, playerDb);
    }
    /* Founding season has no prior league — GM = highest end-of-season dynasty total. */
    const founding = packs[packs.length - 1];
    if (founding && !(founding.gmRows && founding.gmRows.length)){
      scoreGmAbsolute(founding, dynastyMaps, playerDb);
    }

    const currentPack = packs[0];
    currentPack.trackers = buildTrackers(currentPack);

    const goat = buildGoatStandings(packs);
    currentPack.awards = (currentPack.awards || []).filter(a => a.id !== 'goat');
    currentPack.awards.push(awardRecord('goat', currentPack.season, goat.goat, !goat.goat));

    return {
      leagueId: rootId,
      defs: AWARD_DEFS,
      goatPoints: Object.assign({}, GOAT_POINTS),
      goat,
      current: currentPack,
      seasons: packs,
      badgesByKey: badgesByFranchise(packs, goat),
      franchiseKey, yearLabel, seasonTag
    };
  }

  function formatValue(award){
    if (!award || !award.winner) return '\u2014';
    const v = award.winner.value;
    if (award.id === 'champion') return 'Winner';
    if (award.id === 'goat') return formatGoatPoints(v) + ' GOAT pts';
    if (award.id === 'coach') return (v * 100).toFixed(1) + '%';
    if (award.id === 'mip') return (v >= 0 ? '+' : '') + v.toFixed(1) + ' PF/G';
    if (award.id === 'gm') return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dyn';
    if (award.id === 'mvp') return Number(v).toFixed(1) + ' RS PF';
    return Number(v).toFixed(1);
  }

  function formatGoatPoints(n){
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  function formatCandidateValue(awardId, value){
    if (value == null || !Number.isFinite(Number(value))) return '\u2014';
    const v = Number(value);
    if (awardId === 'goat') return formatGoatPoints(v) + ' GOAT pts';
    if (awardId === 'coach') return (v * 100).toFixed(1) + '%';
    if (awardId === 'mip') return (v >= 0 ? '+' : '') + v.toFixed(1) + ' PF/G';
    if (awardId === 'gm') return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dyn';
    if (awardId === 'mvp') return v.toFixed(1) + ' RS PF';
    return v.toFixed(1);
  }

  function badgeHtml(list, escapeHtml){
    const esc = escapeHtml || (s => String(s));
    if (!list || !list.length) return '';
    return list.map(b => {
      const medal = b.medal || medalClass(b.id);
      return '<span class="award-badge' + (medal ? ' ' + medal : '') + '" title="'
        + esc(b.name) + ' ' + esc(b.yearLabel) + '">'
        + esc(b.short) + ' ' + esc(b.yearLabel)
      + '</span>';
    }).join('');
  }

  global.PatioBoysAwards = {
    LEAGUE_ID,
    AWARD_DEFS,
    GOAT_POINTS,
    GOOD_SEASON_WIN_PCT,
    WIN_STREAK_THRESHOLD,
    RS_WIN_BUNDLE_SIZE,
    PLAYOFF_WIN_BUNDLE_SIZE,
    franchiseKey,
    yearLabel,
    seasonTag,
    compute,
    buildGoatStandings,
    loadDynastyMaps,
    formatValue,
    formatCandidateValue,
    formatGoatPoints,
    badgeHtml,
    medalClass,
    pickWinner,
    topCandidates,
    buildTrackers,
    maxPointsForTeam,
    seasonWinPct,
    isGoodSeasonRow
  };
})(typeof window !== 'undefined' ? window : globalThis);
