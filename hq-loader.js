/* Patio Boys loading emblem helpers (HQ panels + embed boot). */
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

  function makeLoader(opts) {
    const options = opts || {};
    const el = document.createElement('div');
    el.className = 'pb-boot-loader' + (options.panel ? ' pb-panel-loader' : '');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="pb-boot-mark" aria-hidden="true">PB</div>'
      + '<p class="pb-boot-label"></p>';
    el.querySelector('.pb-boot-label').textContent = options.label || 'Loading…';
    return el;
  }

  function show(target, opts) {
    ensureStyles();
    const host = target || document.body;
    if (!host) return null;
    let el = host.querySelector(':scope > .pb-boot-loader');
    if (!el) {
      el = makeLoader(opts);
      const pos = global.getComputedStyle ? global.getComputedStyle(host).position : '';
      if (host !== document.body && (!pos || pos === 'static')) {
        host.style.position = 'relative';
      }
      host.appendChild(el);
    } else {
      el.hidden = false;
      el.classList.remove('is-done');
      const label = (opts && opts.label) || null;
      if (label) {
        const p = el.querySelector('.pb-boot-label');
        if (p) p.textContent = label;
      }
    }
    return el;
  }

  function hide(target) {
    const host = target || document.body;
    if (!host) return;
    const el = host.querySelector(':scope > .pb-boot-loader');
    if (!el) return;
    el.classList.add('is-done');
    el.hidden = true;
  }

  function setLabel(target, text) {
    const host = target || document.body;
    const el = host && host.querySelector(':scope > .pb-boot-loader');
    const p = el && el.querySelector('.pb-boot-label');
    if (p) p.textContent = text || 'Loading…';
  }

  /* Embed pages: tell HQ the iframe content is interactive. */
  function signalReady(detail) {
    hide(document.body);
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

  /* Auto boot overlay for embed pages that include this script early. */
  function autoBoot(label) {
    if (typeof document === 'undefined') return;
    ensureStyles();
    if (document.body) {
      show(document.body, { label: label || 'Loading Patio Boys…' });
      return;
    }
    document.addEventListener('DOMContentLoaded', function () {
      show(document.body, { label: label || 'Loading Patio Boys…' });
    });
  }

  global.PatioBoysLoader = {
    ensureStyles,
    show,
    hide,
    setLabel,
    signalReady,
    autoBoot
  };
})(typeof window !== 'undefined' ? window : globalThis);
