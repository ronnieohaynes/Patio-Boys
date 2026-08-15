/* Draft-pick Trade ★ for Patio Boys (16-keeper fringe model).
   Round-1 fringe median (17th-best roster Trade ★) anchors the scale.
   Later rounds apply ROUND_SCALE so 2nds–5ths decay as real chips — live
   fringe ranks 17–21 are nearly flat and must not price a 3rd like a
   starter. Slot/quality mults + year discount (uncertainty) still apply.
   Pick slot follows the original franchise (Sleeper traded_picks roster_id). */
(function (global) {
  'use strict';

  const KEEPER_COUNT = 16;
  const FRINGE_START = 17; /* roster rank → round 1 */
  const DEFAULT_ROUNDS = 5;
  /* Snapshot fallbacks if live medians cannot be built yet (pre-scale). */
  const FALLBACK_ROUND_BASE = {
    1: 67.7,
    2: 66.7,
    3: 65.1,
    4: 62.0,
    5: 61.4
  };
  /* Steep round decay so late picks stay sweetener, not co-primaries. */
  const ROUND_SCALE = {
    1: 1.00,
    2: 0.70,
    3: 0.40,
    4: 0.24,
    5: 0.15
  };
  /* yearsOut from the next unsettled draft season — steeper for uncertainty. */
  const YEAR_DISCOUNT = [1.0, 0.85, 0.72];

  function median(values) {
    const arr = (values || []).filter(v => Number.isFinite(Number(v))).map(Number)
      .sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function roundOrdinal(n) {
    const r = Number(n);
    if (r === 1) return '1st';
    if (r === 2) return '2nd';
    if (r === 3) return '3rd';
    if (Number.isFinite(r)) return r + 'th';
    return String(n);
  }

  function pickAssetId(pick) {
    return 'pick:' + String(pick.season) + ':' + Number(pick.round) + ':'
      + Number(pick.originalRosterId);
  }

  function parsePickAssetId(id) {
    const m = String(id || '').match(/^pick:(\d{4}):(\d+):(\d+)$/);
    if (!m) return null;
    return {
      season: m[1],
      round: Number(m[2]),
      originalRosterId: Number(m[3])
    };
  }

  function tradeStarsFromScore(score) {
    if (global.LockInDist && typeof LockInDist.tradeStarsFromScore === 'function') {
      return LockInDist.tradeStarsFromScore(score);
    }
    const s = Number(score);
    if (!Number.isFinite(s)) return null;
    if (s >= 95) return 5;
    if (s >= 90) return 4.5;
    if (s >= 85) return 4;
    if (s >= 80) return 3.5;
    if (s >= 75) return 3;
    if (s >= 70) return 2.5;
    if (s >= 65) return 2;
    if (s >= 60) return 1.5;
    return 1;
  }

  /* Sleeper only lists traded picks. Seed each roster with its own rounds
     for the next 3 draft years, then apply /traded_picks ownership. */
  function synthesizeOwnedDraftPicks(league, rosters, tradedPicks, drafts) {
    const season = Number(league && league.season);
    const rounds = Number(league && league.settings && league.settings.draft_rounds)
      || DEFAULT_ROUNDS;
    const draftDone = (drafts || []).some(d =>
        String(d.season) === String(season) && d.status === 'complete')
      || (league && (league.status === 'in_season' || league.status === 'complete'));
    const startSeason = draftDone ? season + 1 : season;
    const seasons = [startSeason, startSeason + 1, startSeason + 2].map(String);

    const owner = new Map();
    (rosters || []).forEach(r => {
      const rid = Number(r.roster_id);
      seasons.forEach(s => {
        for (let round = 1; round <= rounds; round++) {
          owner.set(s + '|' + round + '|' + rid, rid);
        }
      });
    });

    (tradedPicks || []).forEach(pk => {
      const key = String(pk.season) + '|' + pk.round + '|' + pk.roster_id;
      if (!owner.has(key)) return;
      owner.set(key, Number(pk.owner_id));
    });

    const byOwner = {};
    owner.forEach((ownerId, key) => {
      const parts = key.split('|');
      const s = parts[0];
      const round = Number(parts[1]);
      const originalRosterId = Number(parts[2]);
      const oid = Number(ownerId);
      if (!byOwner[oid]) byOwner[oid] = [];
      byOwner[oid].push({
        id: pickAssetId({ season: s, round, originalRosterId }),
        season: s,
        round,
        originalRosterId,
        ownerRosterId: oid,
        viaTrade: originalRosterId !== oid
      });
    });
    Object.keys(byOwner).forEach(id => {
      byOwner[id].sort((a, b) =>
        Number(a.season) - Number(b.season)
        || a.round - b.round
        || a.originalRosterId - b.originalRosterId
      );
    });
    return {
      byOwner,
      seasons,
      rounds,
      draftDone,
      nextDraftSeason: String(startSeason)
    };
  }

  function tradeScoreOf(pid, tradeScoreByPid) {
    if (!tradeScoreByPid) return null;
    const id = String(pid);
    const raw = tradeScoreByPid[id] != null ? tradeScoreByPid[id]
      : (tradeScoreByPid.get ? tradeScoreByPid.get(id) : null);
    if (raw == null) return null;
    if (typeof raw === 'object') {
      const v = raw.tradeScore != null ? raw.tradeScore : raw.dynasty;
      return Number.isFinite(Number(v)) ? Number(v) : null;
    }
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  }

  /* Median Trade ★ at roster ranks 17–21 → round bases 1–5. */
  function fringeMediansByRound(teamPlayerIds, tradeScoreByPid, opts) {
    const options = opts || {};
    const rounds = Number(options.rounds) || DEFAULT_ROUNDS;
    const keeperCount = Number(options.keeperCount) || KEEPER_COUNT;
    const fringeStart = Number(options.fringeStart) || FRINGE_START;
    const byRank = {};
    for (let r = 1; r <= rounds; r++) byRank[r] = [];

    (teamPlayerIds || []).forEach(pids => {
      const scores = (pids || []).map(pid => tradeScoreOf(pid, tradeScoreByPid))
        .filter(v => v != null)
        .sort((a, b) => b - a);
      for (let r = 1; r <= rounds; r++) {
        const row = scores[fringeStart - 1 + (r - 1)];
        if (row != null) byRank[r].push(row);
      }
    });

    const bases = {};
    let usedLive = false;
    for (let r = 1; r <= rounds; r++) {
      const med = median(byRank[r]);
      if (med != null) {
        bases[r] = Math.round(med * 100) / 100;
        usedLive = true;
      } else {
        bases[r] = FALLBACK_ROUND_BASE[r] != null ? FALLBACK_ROUND_BASE[r] : 60;
      }
    }
    return {
      bases,
      usedLive,
      keeperCount,
      fringeStart,
      sampleCounts: Object.fromEntries(
        Object.keys(byRank).map(r => [r, byRank[r].length])
      )
    };
  }

  function standingsMeaningful(teams) {
    return (teams || []).some(t =>
      (Number(t.wins) || 0) + (Number(t.losses) || 0) + (Number(t.ties) || 0) > 0
    );
  }

  /* top2 / mid / bottom2 from 1-based rank among nTeams. */
  function finishBand(rank, nTeams) {
    const r = Number(rank);
    const n = Number(nTeams) || 8;
    if (!Number.isFinite(r) || r < 1) return 'mid';
    if (r <= 2) return 'top';
    if (r >= n - 1) return 'bottom';
    return 'mid';
  }

  /* Next-draft slot mult from projected finish. */
  function slotMult(band, round) {
    const rnd = Number(round) || 1;
    if (band === 'bottom') return rnd === 1 ? 1.12 : 1.05;
    if (band === 'top') return rnd === 1 ? 0.88 : 0.95;
    return 1.0;
  }

  /* Future-year quality mult (same bands, slightly muted). */
  function qualityMult(band, round) {
    const rnd = Number(round) || 1;
    if (band === 'bottom') return rnd === 1 ? 1.08 : 1.03;
    if (band === 'top') return rnd === 1 ? 0.90 : 0.96;
    return 1.0;
  }

  function yearMult(yearsOut) {
    const y = Math.max(0, Number(yearsOut) || 0);
    if (y < YEAR_DISCOUNT.length) return YEAR_DISCOUNT[y];
    return YEAR_DISCOUNT[YEAR_DISCOUNT.length - 1] * Math.pow(0.92, y - (YEAR_DISCOUNT.length - 1));
  }

  function bandLabel(band) {
    if (band === 'top') return 'contender';
    if (band === 'bottom') return 'lottery';
    return 'mid';
  }

  function assignQualityRanks(teams, tradeScoreByPid) {
    const list = (teams || []).map(t => {
      const scores = (t.playerIds || t.players || []).map(pid =>
        tradeScoreOf(pid, tradeScoreByPid)
      ).filter(v => v != null).sort((a, b) => b - a);
      const topKeepers = scores.slice(0, KEEPER_COUNT);
      const keeperSum = topKeepers.reduce((s, v) => s + v, 0);
      const maxPts = Number(t.maxPts);
      return {
        team: t,
        maxPts: Number.isFinite(maxPts) ? maxPts : null,
        keeperSum: topKeepers.length ? keeperSum : null
      };
    });
    list.sort((a, b) => {
      if (a.maxPts != null && b.maxPts != null && b.maxPts !== a.maxPts) {
        return b.maxPts - a.maxPts;
      }
      if (a.keeperSum != null && b.keeperSum != null && b.keeperSum !== a.keeperSum) {
        return b.keeperSum - a.keeperSum;
      }
      return 0;
    });
    list.forEach((row, i) => {
      row.team.qualityRank = i + 1;
    });
    return list;
  }

  function roundScale(round) {
    const r = Number(round) || 1;
    if (ROUND_SCALE[r] != null) return ROUND_SCALE[r];
    return 0.12;
  }

  function valuePick(pick, ctx) {
    const context = ctx || {};
    const round = Number(pick && pick.round) || 1;
    const bases = context.roundBases || FALLBACK_ROUND_BASE;
    const base = Number(bases[round] != null ? bases[round]
      : (FALLBACK_ROUND_BASE[round] != null ? FALLBACK_ROUND_BASE[round] : 60));
    const rs = roundScale(round);
    const nextSeason = String(context.nextDraftSeason || pick.season);
    const yearsOut = Math.max(0, Number(pick.season) - Number(nextSeason));
    const ym = yearMult(yearsOut);
    const teamsById = context.teamsByRosterId || {};
    const orig = teamsById[Number(pick.originalRosterId)]
      || teamsById[String(pick.originalRosterId)]
      || null;
    const nTeams = Number(context.teamCount)
      || Object.keys(teamsById).length
      || 8;
    const useStandings = context.useStandingsForNext !== false
      && yearsOut === 0
      && context.standingsMeaningful === true;

    let band = 'mid';
    let sm = 1;
    let qm = 1;
    let mode = 'flat';
    if (orig) {
      if (yearsOut === 0) {
        const rank = useStandings
          ? (orig.standingsRank || orig.qualityRank || Math.ceil(nTeams / 2))
          : (orig.qualityRank || orig.standingsRank || Math.ceil(nTeams / 2));
        band = finishBand(rank, nTeams);
        sm = slotMult(band, round);
        mode = useStandings ? 'slot-standings' : 'slot-quality';
      } else {
        const rank = orig.qualityRank || orig.standingsRank || Math.ceil(nTeams / 2);
        band = finishBand(rank, nTeams);
        qm = qualityMult(band, round);
        mode = 'quality';
      }
    }

    const tradeScore = Math.round(base * rs * ym * sm * qm * 100) / 100;
    const tradeStars = tradeStarsFromScore(tradeScore);
    const noteParts = [
      'base ' + base.toFixed(1) + ' (r' + round + ' fringe)',
      '× round ' + rs.toFixed(2),
      '× year ' + ym.toFixed(2)
    ];
    if (sm !== 1) noteParts.push('× slot ' + sm.toFixed(2) + ' (' + bandLabel(band) + ')');
    if (qm !== 1) noteParts.push('× quality ' + qm.toFixed(2) + ' (' + bandLabel(band) + ')');
    if (yearsOut === 0 && !useStandings) {
      noteParts.push('preseason → quality proxy');
    }

    return {
      tradeScore,
      tradeStars,
      base,
      roundScale: rs,
      yearMult: ym,
      slotMult: sm,
      qualityMult: qm,
      yearsOut,
      band,
      mode,
      note: noteParts.join(' ')
    };
  }

  function attachPickValues(byOwner, ctx) {
    const out = {};
    Object.keys(byOwner || {}).forEach(ownerId => {
      out[ownerId] = (byOwner[ownerId] || []).map(p => {
        const valued = valuePick(p, ctx);
        return Object.assign({}, p, valued, {
          id: p.id || pickAssetId(p),
          dynasty: valued.tradeScore,
          kind: 'pick',
          label: String(p.season) + ' ' + roundOrdinal(p.round)
        });
      });
    });
    return out;
  }

  function buildTeamIndex(teams) {
    const byId = {};
    (teams || []).forEach(t => {
      byId[Number(t.rosterId)] = t;
      byId[String(t.rosterId)] = t;
    });
    return byId;
  }

  /* One-shot: synthesize ownership, build bases, attach values. */
  function valueLeaguePicks(opts) {
    const options = opts || {};
    const pack = synthesizeOwnedDraftPicks(
      options.league,
      options.rosters,
      options.tradedPicks,
      options.drafts
    );
    const teams = options.teams || [];
    assignQualityRanks(teams, options.tradeScoreByPid);
    if (!standingsMeaningful(teams)) {
      teams.forEach(t => {
        if (t.qualityRank != null) t.standingsRank = t.standingsRank || t.qualityRank;
      });
    }
    const teamPlayerIds = teams.map(t => t.playerIds || t.players || []);
    const fringe = fringeMediansByRound(teamPlayerIds, options.tradeScoreByPid, {
      rounds: pack.rounds
    });
    const ctx = {
      roundBases: fringe.bases,
      nextDraftSeason: pack.nextDraftSeason,
      teamsByRosterId: buildTeamIndex(teams),
      teamCount: teams.length,
      standingsMeaningful: standingsMeaningful(teams),
      useStandingsForNext: standingsMeaningful(teams)
    };
    const valued = attachPickValues(pack.byOwner, ctx);
    return {
      byOwner: valued,
      seasons: pack.seasons,
      rounds: pack.rounds,
      draftDone: pack.draftDone,
      nextDraftSeason: pack.nextDraftSeason,
      roundBases: fringe.bases,
      fringe,
      ctx
    };
  }

  global.DraftPickValue = {
    KEEPER_COUNT,
    FRINGE_START,
    FALLBACK_ROUND_BASE,
    ROUND_SCALE,
    YEAR_DISCOUNT,
    median,
    roundOrdinal,
    pickAssetId,
    parsePickAssetId,
    synthesizeOwnedDraftPicks,
    fringeMediansByRound,
    standingsMeaningful,
    finishBand,
    slotMult,
    qualityMult,
    yearMult,
    roundScale,
    assignQualityRanks,
    valuePick,
    attachPickValues,
    buildTeamIndex,
    valueLeaguePicks,
    tradeStarsFromScore
  };
})(typeof window !== 'undefined' ? window : globalThis);
