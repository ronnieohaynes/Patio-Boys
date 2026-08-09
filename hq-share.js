/* Shared Sleeper data cache across Patio Boys HQ iframes (window.top).
   Avoids re-downloading / re-parsing players, projections, and weekly stats.
   Large JSON responses yield to the event loop before parse so HQ tabs stay clickable. */
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

  function yieldToMain() {
    if (global.scheduler && typeof global.scheduler.yield === 'function') {
      return global.scheduler.yield();
    }
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function parseJsonText(text) {
    return yieldToMain().then(function () {
      return JSON.parse(text);
    });
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.text();
    }).then(parseJsonText);
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

  function fetchWeekJson(season, week) {
    return fetch('https://api.sleeper.app/v1/stats/nba/regular/' + season + '/' + week)
      .then(function (r) {
        if (!r.ok) return null;
        return r.text().then(function (text) {
          if (!text) return null;
          return parseJsonText(text).catch(function () { return null; });
        });
      })
      .catch(function () { return null; });
  }

  /* 25 weeks of regular-season player stats for one NBA season (raw Sleeper JSON).
     Fetched in small batches with yields so HQ nav stays responsive. */
  function fetchWeeklyNbaStats(season) {
    const key = String(season || '');
    const b = bag();
    if (b.weekly[key]) return Promise.resolve(b.weekly[key]);
    if (b.weeklyP[key]) return b.weeklyP[key];
    const weeks = Array.from({ length: 25 }, function (_, i) { return i + 1; });
    b.weeklyP[key] = (async function () {
      const arr = new Array(25);
      for (let i = 0; i < weeks.length; i += 5) {
        const slice = weeks.slice(i, i + 5);
        const part = await Promise.all(slice.map(function (w) {
          return fetchWeekJson(key, w);
        }));
        for (let j = 0; j < part.length; j++) arr[i + j] = part[j];
        await yieldToMain();
      }
      b.weekly[key] = arr;
      b.weeklyP[key] = null;
      return arr;
    })().catch(function (err) {
      b.weeklyP[key] = null;
      throw err;
    });
    return b.weeklyP[key];
  }

  function runWhenIdle(fn, timeoutMs) {
    const timeout = timeoutMs == null ? 1800 : timeoutMs;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function () { fn(); }, { timeout: timeout });
      return;
    }
    setTimeout(fn, Math.min(120, timeout));
  }

  global.PatioBoysShare = {
    hostWindow: hostWindow,
    yieldToMain: yieldToMain,
    runWhenIdle: runWhenIdle,
    fetchJson: fetchJson,
    fetchJsonCached: fetchJsonCached,
    fetchPlayersNba: fetchPlayersNba,
    fetchNbaProjections: fetchNbaProjections,
    projectionsUrl: projectionsUrl,
    fetchWeeklyNbaStats: fetchWeeklyNbaStats
  };
})(typeof window !== 'undefined' ? window : globalThis);
