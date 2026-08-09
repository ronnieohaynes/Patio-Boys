/* Patio Boys loading emblem helpers (HQ panels + embed boot + % progress). */
(function (global) {
  'use strict';

  const STYLE_ID = 'pb-loader-style';
  const CSS_HREF = 'hq-loader.css';

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    let href = CSS_HREF;
    try {
      const v = new URLSearchParams(location.search).get('nocache');
      if (v) href += '?v=' + encodeURIComponent(v);
    } catch (e) { /* ignore */ }
    link.href = href;
    document.head.appendChild(link);
  }

  function clampPct(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(100, Math.round(x)));
  }

  function ensureProgressDom(el) {
    if (!el) return;
    if (!el.querySelector('.pb-boot-bar')) {
      const bar = document.createElement('div');
      bar.className = 'pb-boot-bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.innerHTML = '<div class="pb-boot-bar-fill"></div>';
      el.appendChild(bar);
    }
    if (!el.querySelector('.pb-boot-pct')) {
      const pct = document.createElement('p');
      pct.className = 'pb-boot-pct';
      pct.textContent = '0%';
      el.appendChild(pct);
    }
    if (!el.hasAttribute('aria-valuemin')) {
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', '100');
      el.setAttribute('aria-valuenow', '0');
    }
  }

  function makeLoader(opts) {
    const options = opts || {};
    const el = document.createElement('div');
    el.className = 'pb-boot-loader' + (options.panel ? ' pb-panel-loader' : '');
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuenow', '0');
    el.innerHTML = '<div class="pb-boot-mark" aria-hidden="true">PB</div>'
      + '<p class="pb-boot-label"></p>'
      + '<div class="pb-boot-bar" aria-hidden="true"><div class="pb-boot-bar-fill"></div></div>'
      + '<p class="pb-boot-pct">0%</p>';
    el.querySelector('.pb-boot-label').textContent = options.label || 'Loading…';
    if (options.pct != null) setProgress(el, options.pct);
    return el;
  }

  function setProgress(target, pct, label) {
    ensureStyles();
    let host = target;
    let el = null;
    if (target && target.classList && target.classList.contains('pb-boot-loader')) {
      el = target;
      host = target.parentNode;
    } else {
      host = target || document.body;
      if (!host) return null;
      el = host.querySelector(':scope > .pb-boot-loader');
    }
    if (!el) {
      el = show(host, { label: label || 'Loading…', pct: pct });
      return el;
    }
    ensureProgressDom(el);
    const n = clampPct(pct);
    const prev = Number(el.dataset.pbPct || 0);
    const next = Math.max(prev, n);
    el.dataset.pbPct = String(next);
    el.setAttribute('aria-valuenow', String(next));
    const fill = el.querySelector('.pb-boot-bar-fill');
    if (fill) fill.style.width = next + '%';
    const pctEl = el.querySelector('.pb-boot-pct');
    if (pctEl) pctEl.textContent = next + '%';
    if (label) {
      const p = el.querySelector('.pb-boot-label');
      if (p) p.textContent = label;
    }
    return el;
  }

  function show(target, opts) {
    ensureStyles();
    const options = opts || {};
    const host = target || document.body;
    if (!host) return null;
    let el = host.querySelector(':scope > .pb-boot-loader');
    if (!el) {
      el = makeLoader(options);
      const pos = global.getComputedStyle ? global.getComputedStyle(host).position : '';
      if (host !== document.body && (!pos || pos === 'static')) {
        host.style.position = 'relative';
      }
      host.appendChild(el);
    } else {
      el.hidden = false;
      el.classList.remove('is-done');
      ensureProgressDom(el);
      if (!el.dataset.pbPct) el.dataset.pbPct = '0';
      const label = options.label || null;
      if (label) {
        const p = el.querySelector('.pb-boot-label');
        if (p) p.textContent = label;
      }
    }
    if (options.pct != null) setProgress(el, options.pct, options.label);
    else if (!el.dataset.pbPct) setProgress(el, 0);
    return el;
  }

  function hide(target) {
    const host = target || document.body;
    if (!host) return;
    const el = host.querySelector(':scope > .pb-boot-loader');
    if (!el) return;
    setProgress(el, 100);
    el.classList.add('is-done');
    el.hidden = true;
  }

  function setLabel(target, text) {
    const host = target || document.body;
    const el = host && host.querySelector(':scope > .pb-boot-loader');
    const p = el && el.querySelector('.pb-boot-label');
    if (p) p.textContent = text || 'Loading…';
  }

  /* Embed → parent progress updates for HQ panel loader. */
  function reportProgress(pct, detail) {
    const n = clampPct(pct);
    try {
      setProgress(document.body, n, detail && detail.label ? detail.label : null);
    } catch (e) { /* ignore */ }
    try {
      if (global.parent && global.parent !== global) {
        global.parent.postMessage({
          type: 'pb-progress',
          pct: n,
          href: String(location.href || ''),
          detail: detail || null
        }, '*');
      }
    } catch (e) { /* ignore */ }
  }

  /* Embed pages: tell HQ the iframe content is interactive. */
  function signalReady(detail) {
    reportProgress(100, detail && detail.label ? { label: detail.label } : null);
    setTimeout(function () {
      hide(document.body);
    }, 120);
    try {
      if (global.parent && global.parent !== global) {
        global.parent.postMessage({
          type: 'pb-ready',
          href: String(location.href || ''),
          detail: detail || null
        }, '*');
      }
    } catch (e) { /* ignore */ }
  }

  /* Sequential script load with progress callbacks (10% → 48%). */
  function loadScripts(files, opts) {
    const options = opts || {};
    const list = files || [];
    const version = options.version || '';
    const startPct = options.startPct != null ? Number(options.startPct) : 10;
    const endPct = options.endPct != null ? Number(options.endPct) : 48;
    let i = 0;
    return new Promise(function (resolve) {
      function tick() {
        if (i >= list.length) {
          reportProgress(endPct, { label: options.readyLabel || 'Starting…', stage: 'deps-ready' });
          if (typeof options.onReady === 'function') options.onReady();
          resolve();
          return;
        }
        const name = list[i];
        const pct = startPct + ((endPct - startPct) * (i / Math.max(1, list.length)));
        reportProgress(pct, {
          label: options.label || ('Loading ' + name + '…'),
          stage: 'script',
          file: name,
          index: i,
          total: list.length
        });
        const s = document.createElement('script');
        s.src = name + (name.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(version || '1');
        i += 1;
        s.onload = function () { setTimeout(tick, 0); };
        s.onerror = function () { setTimeout(tick, 0); };
        document.head.appendChild(s);
      }
      reportProgress(Math.max(4, startPct - 4), { label: options.label || 'Loading…', stage: 'boot' });
      tick();
    });
  }

  /* Auto boot overlay for embed pages that include this script early. */
  function autoBoot(label) {
    if (typeof document === 'undefined') return;
    ensureStyles();
    function paint() {
      show(document.body, { label: label || 'Loading Patio Boys…', pct: 4 });
      reportProgress(4, { label: label || 'Loading Patio Boys…', stage: 'boot' });
    }
    if (document.body) paint();
    else document.addEventListener('DOMContentLoaded', paint);
  }

  global.PatioBoysLoader = {
    ensureStyles,
    show,
    hide,
    setLabel,
    setProgress,
    reportProgress,
    signalReady,
    loadScripts,
    autoBoot
  };
})(typeof window !== 'undefined' ? window : globalThis);
