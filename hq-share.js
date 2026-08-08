/* Shared Sleeper data cache across Patio Boys HQ iframes (window.top).
   Avoids re-downloading / re-parsing players, projections, and weekly stats. */
(function (global) {
  'use strict';

  function hostWindow() {
    try {
      if (typeof window !== 'undefined' && window.top && window.top !== window) {
        return window.top;
      }
    } catch (e) { /* cross-origin */ }
    return typeof window !== 'undefined' ? window : global;
  }

  function bag() {
    const host = hostWindow();
    if (!host.__PB_SHARE) {
      host.__PB_SHARE = {
        players: null,
        playersP: null,
        json: Object.create(null),
        jsonP: Object.create(null),
        weekly: Object.create(null),
        weeklyP: Object.create(null)
      };
    }
    return host.__PB_SHARE;
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  /* Cache arbitrary JSON GET by stable key (usually the URL). */
  function fetchJsonCached(key, url) {
    const b = bag();
    const k = String(key || url);
    if (b.json[k] != null) return Promise.resolve(b.json[k]);
    if (b.jsonP[k]) return b.jsonP[k];
    b.jsonP[k] = fetchJson(url).then(function (data) {
      b.json[k] = data;
      b.jsonP[k] = null;
      return data;
    }).catch(function (err) {
      b.jsonP[k] = null;
      throw err;
    });
    return b.jsonP[k];
  }

  function fetchPlayersNba() {
    const b = bag();
    if (b.players) return Promise.resolve(b.players);
    if (b.playersP) return b.playersP;
    b.playersP = fetchJson('https://api.sleeper.app/v1/players/nba').then(function (db) {
      b.players = db;
      b.playersP = null;
      return db;
    }).catch(function (err) {
      b.playersP = null;
      throw err;
    });
    return b.playersP;
  }

  function projectionsUrl(season) {
    return 'https://api.sleeper.com/projections/nba/' + season + '?season_type=regular';
  }

  function fetchNbaProjections(season) {
    const s = String(season || '');
    return fetchJsonCached('proj:' + s, projectionsUrl(s));
  }

  /* 25 weeks of regular-season player stats for one NBA season (raw Sleeper JSON). */
  function fetchWeeklyNbaStats(season) {
    const key = String(season || '');
    const b = bag();
    if (b.weekly[key]) return Promise.resolve(b.weekly[key]);
    if (b.weeklyP[key]) return b.weeklyP[key];
    const weeks = Array.from({ length: 25 }, function (_, i) { return i + 1; });
    b.weeklyP[key] = Promise.all(weeks.map(function (w) {
      return fetch('https://api.sleeper.app/v1/stats/nba/regular/' + key + '/' + w)
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    })).then(function (arr) {
      b.weekly[key] = arr;
      b.weeklyP[key] = null;
      return arr;
    }).catch(function (err) {
      b.weeklyP[key] = null;
      throw err;
    });
    return b.weeklyP[key];
  }

  global.PatioBoysShare = {
    hostWindow: hostWindow,
    fetchJson: fetchJson,
    fetchJsonCached: fetchJsonCached,
    fetchPlayersNba: fetchPlayersNba,
    fetchNbaProjections: fetchNbaProjections,
    projectionsUrl: projectionsUrl,
    fetchWeeklyNbaStats: fetchWeeklyNbaStats
  };
})(typeof window !== 'undefined' ? window : globalThis);
