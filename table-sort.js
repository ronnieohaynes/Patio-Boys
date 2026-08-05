/* Lightweight column-sort helpers for HQ tables (Dynasty / FA). */
(function(global){
  'use strict';

  function defaultDirForKey(key){
    if (key === 'name' || key === 'pos' || key === 'age' || key === 'fitLabel' || key === 'role') return 'asc';
    if (key === 'contract') return 'desc';
    return 'desc';
  }

  function toggle(state, key){
    const next = state || {key: null, dir: 'desc'};
    if (next.key === key){
      next.dir = next.dir === 'asc' ? 'desc' : 'asc';
    } else {
      next.key = key;
      next.dir = defaultDirForKey(key);
    }
    return next;
  }

  function ariaSort(state, key){
    if (!state || state.key !== key) return 'none';
    return state.dir === 'asc' ? 'ascending' : 'descending';
  }

  function marker(state, key){
    if (!state || state.key !== key) return '';
    return state.dir === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  function thHtml(label, key, state, extraClass){
    const cls = ['sortable'].concat(extraClass ? [extraClass] : []).join(' ');
    return '<th class="' + cls + '" data-sort="' + key + '" role="columnheader" tabindex="0" aria-sort="'
      + ariaSort(state, key) + '">' + label + marker(state, key) + '</th>';
  }

  function decorateThead(thead, state){
    if (!thead) return;
    thead.querySelectorAll('th[data-sort]').forEach(th => {
      const key = th.getAttribute('data-sort');
      th.classList.add('sortable');
      th.setAttribute('role', 'columnheader');
      th.setAttribute('tabindex', '0');
      th.setAttribute('aria-sort', ariaSort(state, key));
      const base = th.getAttribute('data-label') || th.textContent.replace(/[\u25B2\u25BC]\s*$/, '').trim();
      th.setAttribute('data-label', base);
      th.textContent = base + marker(state, key);
    });
  }

  function bindThead(root, getState, setStateAndRender){
    if (!root || root._tableSortBound) return;
    root._tableSortBound = true;
    function handle(th){
      if (!th) return;
      const key = th.getAttribute('data-sort');
      if (!key) return;
      const next = toggle(Object.assign({}, getState() || {}), key);
      setStateAndRender(next);
    }
    root.addEventListener('click', e => {
      handle(e.target.closest('th[data-sort]'));
    });
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      e.preventDefault();
      handle(th);
    });
  }

  function cmp(a, b, dir){
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'string' || typeof b === 'string'){
      const av = String(a || '');
      const bv = String(b || '');
      const c = av.localeCompare(bv, undefined, {sensitivity: 'base', numeric: true});
      return dir === 'asc' ? c : -c;
    }
    const av = Number(a);
    const bv = Number(b);
    const aOk = Number.isFinite(av);
    const bOk = Number.isFinite(bv);
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;
    if (!bOk) return -1;
    return dir === 'asc' ? av - bv : bv - av;
  }

  global.TableSort = {
    defaultDirForKey,
    toggle,
    ariaSort,
    marker,
    thHtml,
    decorateThead,
    bindThead,
    cmp
  };
})(window);
