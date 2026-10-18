(function () {
  'use strict';
  const { STATES, analyze } = window.Calc;
  const $ = (id) => document.getElementById(id);
  const KEY = 'apartmentCompass.v1';

  // ---------- formatting ----------
  const eur = (v) => (v == null || !isFinite(v) ? '–' : (v < 0 ? '−' : '') + '€' + Math.abs(Math.round(v)).toLocaleString('en-US'));
  const pct = (v, d = 2) => (v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + ' %');
  const n1 = (v, d = 1) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = (id) => $(id).value;
  const numOrNull = (id) => (val(id) === '' ? null : +val(id));
  const sign = (v) => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
  const r2 = (v) => Math.round(v * 100) / 100;
  const fmtSize = (v) => (v == null || !isFinite(v) ? '–' : String(+(+v).toFixed(2)));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };

  // ---------- total <-> per-m² linked fields ----------
  // Editing the total updates the €/m² value and vice versa. When the size changes, whichever
  // of the two was edited last stays fixed.
  const pairs = [];
  function linkPair(s, t, p) {
    const P = { s, t, p, last: 't' };
    const perFromTotal = () => { const size = +val(s); $(p).value = size > 0 && val(t) !== '' ? r2(+val(t) / size) : ''; };
    const totalFromPer = () => { const size = +val(s); if (size > 0 && val(p) !== '') $(t).value = r2(+val(p) * size); };
    P.reset = () => { P.last = 't'; perFromTotal(); };
    $(t).addEventListener('input', () => { P.last = 't'; perFromTotal(); });
    $(p).addEventListener('input', () => { P.last = 'p'; totalFromPer(); });
    $(s).addEventListener('input', () => { if (P.last === 'p' && val(p) !== '') totalFromPer(); else perFromTotal(); });
    pairs.push(P);
  }
  const resetPairs = (prefix) => pairs.filter((P) => P.s.startsWith(prefix)).forEach((P) => P.reset());
  ['d_', 'a_'].forEach((x) => { linkPair(x + 'size', x + 'price', x + 'pricem2'); linkPair(x + 'size', x + 'rent', x + 'rentm2'); linkPair(x + 'size', x + 'hausgeld', x + 'hausm2'); });

  // ---------- state ----------
  const DEFAULT_ASSUMPTIONS = {
    equityMode: 'percent', equityValue: 20, ratePct: 4.0, followBundesbank: true,
    repayPct: 2, fixYears: 10, notaryPct: 2, brokerPct: 3.57, vacancyPct: 3, maintPerSqm: 10, maintPerSqmHouse: 15, mgmtPerMonth: 0,
  };
  let store = { listings: [], assumptions: { ...DEFAULT_ASSUMPTIONS }, search: { state: 'NW' }, draft: { state: 'NW' }, bb: null };
  try { const raw = localStorage.getItem(KEY); if (raw) { const p = JSON.parse(raw); store = { ...store, ...p, assumptions: { ...DEFAULT_ASSUMPTIONS, ...(p.assumptions || {}) } }; } } catch (e) { /* storage unavailable */ }
  store.compare = { ids: [], sameEquity: true, diff: false, eq: {}, ...(store.compare || {}) };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } };
  let sort = { key: 'netYield', dir: -1 };
  let editingId = null;

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'shortlist') renderShortlist();
    if (name === 'analysis') renderAnalysis();
    if (name === 'compare') renderCompare();
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  // ---------- state selects ----------
  function fillStateSelect(el, withBlank) {
    el.innerHTML = (withBlank ? '<option value="">Any / nationwide</option>' : '') +
      Object.entries(STATES).map(([c, s]) => `<option value="${c}">${esc(s.name)} · transfer tax ${s.tax}%</option>`).join('');
  }
  fillStateSelect($('s_state'), true); fillStateSelect($('a_state'), false); fillStateSelect($('d_state'), false);

  // ---------- SEARCH: portal deep links ----------
  const slugCity = (c) => c.trim().toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const range = (a, b, fmt = (x) => x) => (a == null && b == null ? null : `${a == null ? '' : fmt(a)}-${b == null ? '' : fmt(b)}`);

  function readSearch() {
    return { type: val('s_type') || 'apartment', state: val('s_state'), city: val('s_city').trim(), pmin: numOrNull('s_pmin'), pmax: numOrNull('s_pmax'), smin: numOrNull('s_smin'), smax: numOrNull('s_smax'), rmin: numOrNull('s_rmin'), rmax: numOrNull('s_rmax') };
  }
  function portals(s) {
    // ImmoScout24
    let path = '/Suche/de';
    if (s.state) { path += '/' + STATES[s.state].slug; if (s.city) path += '/' + slugCity(s.city); }
    path += s.type === 'house' ? '/haus-kaufen' : '/wohnung-kaufen';
    const q1 = new URLSearchParams();
    const pr = range(s.pmin, s.pmax), sz = range(s.smin, s.smax), rm = range(s.rmin, s.rmax, (x) => x.toFixed(1));
    if (pr) q1.set('price', pr); if (sz) q1.set('livingspace', sz); if (rm) q1.set('numberofrooms', rm);
    const is24 = 'https://www.immobilienscout24.de' + path + (q1.toString() ? '?' + q1 : '');

    // Immowelt
    const q2 = new URLSearchParams({ distributionTypes: 'Buy', estateTypes: s.type === 'house' ? 'House' : 'Apartment' });
    [['priceMin', s.pmin], ['priceMax', s.pmax], ['areaMin', s.smin], ['areaMax', s.smax], ['roomsMin', s.rmin], ['roomsMax', s.rmax]].forEach(([k, v]) => { if (v != null) q2.set(k, v); });
    const iw = 'https://www.immowelt.de/classified-search?' + q2;

    // Kleinanzeigen
    const cat = s.type === 'house' ? 208 : 196;
    let ka = 'https://www.kleinanzeigen.de/' + (s.type === 'house' ? 's-haus-kaufen/' : 's-wohnung-kaufen/');
    if (s.pmin != null || s.pmax != null) ka += `preis:${s.pmin ?? ''}:${s.pmax ?? ''}/`;
    ka += s.city ? `${encodeURIComponent(slugCity(s.city))}/k0c${cat}` : 'c' + cat;

    const loc = s.state ? (s.city ? 'state + city' : 'state') : '';
    return [
      { name: 'ImmoScout24', url: is24, carries: ['price', 'size', 'rooms'].concat(loc ? [loc] : []).join(', ') },
      { name: 'Immowelt', url: iw, carries: 'price, size, rooms · set the location on the site' },
      { name: 'Kleinanzeigen', url: ka, carries: 'price' + (s.city ? ', city keyword' : '') + ' · set size/rooms on the site' },
    ];
  }
  function renderPortals() {
    const s = readSearch();
    store.search = { ...s }; save();
    $('portalLinks').innerHTML = portals(s).map((p) =>
      `<a class="portal" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(p.name)} ↗</b><span>Filters carried over: ${esc(p.carries)}</span></a>`).join('');
  }
  $('searchForm').addEventListener('input', renderPortals);
  function loadSearch() {
    const s = store.search || {};
    $('s_type').value = s.type || 'apartment'; $('s_state').value = s.state ?? ''; $('s_city').value = s.city ?? '';
    [['s_pmin', 'pmin'], ['s_pmax', 'pmax'], ['s_smin', 'smin'], ['s_smax', 'smax'], ['s_rmin', 'rmin'], ['s_rmax', 'rmax']].forEach(([id, k]) => { $(id).value = s[k] ?? ''; });
    renderPortals();
  }

  // ---------- SHORTLIST ----------
  const COLS = [
    { key: 'title', label: 'Property', get: (l) => l.title.toLowerCase() },
    { key: 'price', label: 'Purchase price', get: (l, a) => a.price, fmt: (a) => eur(a.price) },
    { key: 'size', label: 'Size (m²)', get: (l, a) => a.size, fmt: (a, l) => fmtSize(a.size) + (l.rooms ? ` · ${l.rooms} rm` : '') },
    { key: 'pricePerSqm', label: 'Price (€/m²)', get: (l, a) => a.pricePerSqm, fmt: (a) => eur(a.pricePerSqm), best: -1 },
    { key: 'totalCost', label: 'Total cost', get: (l, a) => a.totalCost, fmt: (a) => eur(a.totalCost), best: -1 },
    { key: 'payment', label: 'Loan/month', get: (l, a) => a.loan.payment, fmt: (a) => eur(a.loan.payment), best: -1 },
    { key: 'grossYield', label: 'Gross yield', get: (l, a) => a.grossYield, fmt: (a) => pct(a.grossYield), best: 1 },
    { key: 'netYield', label: 'Net yield', get: (l, a) => a.netYield, fmt: (a) => pct(a.netYield), best: 1 },
    { key: 'cf', label: 'Cash flow/mo', get: (l, a) => (a.annualRent > 0 ? a.cashflow / 12 : null), fmt: (a) => (a.annualRent > 0 ? eur(a.cashflow / 12) : '–'), best: 1, signed: true },
  ];
  // Sort choices use the same names as the fields in the Add/Edit window.
  const SORTS = [
    ['netYield:-1', 'Net yield: high to low'],
    ['price:-1', 'Purchase price: high to low'], ['price:1', 'Purchase price: low to high'],
    ['size:-1', 'Size (m²): high to low'], ['size:1', 'Size (m²): low to high'],
    ['yearBuilt:-1', 'Year built: newest first'], ['yearBuilt:1', 'Year built: oldest first'],
  ];
  // Filters use the same field names as the Add/Edit window.
  const RANGES = [
    { key: 'price', label: 'Purchase price (€)', step: 5000, get: (l) => (l.price > 0 ? l.price : null), fmt: eur },
    { key: 'size', label: 'Size (m²)', step: 1, get: (l) => (l.size > 0 ? l.size : null), fmt: (v) => v + ' m²' },
    { key: 'rent', label: 'Cold rent total (€/month)', step: 50, get: (l) => (l.rent > 0 ? l.rent : null), fmt: eur },
    { key: 'rentm2', label: 'Cold rent (€/m²/month)', step: 0.5, get: (l) => (l.rent > 0 && l.size > 0 ? l.rent / l.size : null), fmt: (v) => '€' + v.toFixed(2) },
    { key: 'year', label: 'Year built', step: 1, get: (l) => l.building?.yearBuilt ?? null, fmt: String },
  ];
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').trim();
  const fmtLocation = (l) => [l.district, [l.postalCode, l.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const sortValue = (key, l, a) => { if (key === 'yearBuilt') return l.building?.yearBuilt ?? null; const c = COLS.find((x) => x.key === key); return c ? c.get(l, a) : null; };

  const view = { query: '', types: new Set(), cities: new Set(), districts: new Set(), ranges: {} };
  const activeFilters = () => view.types.size + view.cities.size + view.districts.size + Object.keys(view.ranges).length;

  function matches(l) {
    const q = norm(view.query);
    if (q.length >= 2) {
      const hay = norm([l.title, l.district, l.city, l.postalCode, STATES[l.state]?.name, l.notes].join(' '));
      if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    if (view.types.size && !view.types.has(l.type || 'apartment')) return false;
    if (view.cities.size && !view.cities.has(norm(l.city))) return false;
    if (view.districts.size && !view.districts.has(norm(l.district))) return false;
    for (const r of RANGES) {
      const rg = view.ranges[r.key]; if (!rg) continue;
      const v = r.get(l);
      if (v == null || v < rg[0] - 1e-9 || v > rg[1] + 1e-9) return false;
    }
    return true;
  }

  function syncSortSelect() {
    const sel = $('sortSel'), id = sort.key + ':' + sort.dir;
    if (!sel.options.length) sel.innerHTML = SORTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    [...sel.options].filter((o) => o.dataset.custom).forEach((o) => o.remove());
    if (![...sel.options].some((o) => o.value === id)) {
      const c = COLS.find((x) => x.key === sort.key);
      const o = document.createElement('option'); o.value = id; o.dataset.custom = '1';
      o.textContent = `${c ? c.label : sort.key}: ${sort.dir > 0 ? 'low to high' : 'high to low'}`; sel.appendChild(o);
    }
    sel.value = id;
  }
  $('sortSel').addEventListener('change', (e) => { const [k, d] = e.target.value.split(':'); sort = { key: k, dir: +d }; renderShortlist(); });
  $('q').addEventListener('input', (e) => { view.query = e.target.value; renderShortlist(); });
  $('clearAll').addEventListener('click', () => { view.query = ''; $('q').value = ''; resetFilters(); renderShortlist(); });
  function resetFilters() { view.types.clear(); view.cities.clear(); view.districts.clear(); view.ranges = {}; }

  function renderShortlist() {
    const total = store.listings.length;
    $('count').textContent = total; updateCmpCounts();
    $('emptyMsg').hidden = total > 0;
    $('listTools').hidden = total === 0;
    const t = $('cmp');
    if (!total) { t.innerHTML = ''; $('resultInfo').textContent = ''; $('noMatch').hidden = true; return; }
    // drop filter choices that no longer exist after edits/deletes
    const have = new Set(store.listings.map((l) => norm(l.city))), haveD = new Set(store.listings.map((l) => norm(l.district)));
    [...view.cities].forEach((k) => { if (!have.has(k)) view.cities.delete(k); });
    [...view.districts].forEach((k) => { if (!haveD.has(k)) view.districts.delete(k); });
    syncSortSelect();
    const n = activeFilters();
    $('filterCount').hidden = !n; $('filterCount').textContent = n;

    const all = store.listings.map((l) => ({ l, a: analyze(l, store.assumptions) }));
    const rows = all.filter((r) => matches(r.l));
    const searching = norm(view.query).length >= 2;
    $('resultInfo').textContent = (searching || n) ? `Showing ${rows.length} of ${total} apartments` : (view.query.trim().length === 1 ? 'Type at least 2 characters to search.' : '');
    $('noMatch').hidden = rows.length > 0;
    if (!rows.length) { t.innerHTML = ''; return; }

    rows.sort((x, y) => {
      const a = sortValue(sort.key, x.l, x.a), b = sortValue(sort.key, y.l, y.a);
      if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
      return a < b ? -sort.dir : a > b ? sort.dir : 0;
    });
    const bestVal = {};
    COLS.forEach((c) => {
      if (!c.best || rows.length < 2) return;
      const vs = rows.map((r) => c.get(r.l, r.a)).filter((v) => v != null && isFinite(v));
      if (vs.length > 1) bestVal[c.key] = c.best > 0 ? Math.max(...vs) : Math.min(...vs);
    });
    t.innerHTML = '<thead><tr>' + COLS.map((c) => `<th data-k="${c.key}">${c.label}${sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(({ l, a }) => {
        const url = safeUrl(l.url);
        const cells = COLS.slice(1).map((c) => {
          const v = c.get(l, a);
          const cls = [bestVal[c.key] === v && v != null ? 'best' : '', c.signed ? sign(v) : ''].join(' ');
          return `<td class="${cls}">${c.fmt(a, l)}</td>`;
        }).join('');
        const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>` : `<b>${esc(l.title)}</b>`;
        const loc = fmtLocation(l);
        const tag = l.type === 'house' ? '<span class="tag">House</span> ' : '';
        const place = tag + (loc ? `📍 ${esc(loc)}` : esc(STATES[l.state]?.name || ''));
        const missing = !l.rent ? '<div class="small muted">no rent entered</div>' : '';
        const notes = l.notes ? `<div class="small muted">${esc(l.notes)}</div>` : '';
        return `<tr data-id="${l.id}"><td class="title">${title}<div class="loc-line">${place}</div>${missing}${notes}<div class="acts"><label class="cmpchk"><input type="checkbox" data-cmp="${esc(l.id)}" ${store.compare.ids.includes(l.id) ? 'checked' : ''}> Compare</label><button class="link" data-act="analyze">Analyze</button><button class="link" data-act="edit">Edit</button><button class="link danger" data-act="del">Delete</button></div></td>${cells}</tr>`;
      }).join('') + '</tbody>';
  }
  $('cmp').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (th) { sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : (th.dataset.k === 'title' ? 1 : -1) }; renderShortlist(); return; }
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'edit') openDialog(id);
    if (btn.dataset.act === 'del') {
      const l = store.listings.find((x) => x.id === id);
      if (l && confirm(`Delete "${l.title}" from the shortlist?`)) { store.listings = store.listings.filter((x) => x.id !== id); save(); renderShortlist(); }
    }
    if (btn.dataset.act === 'analyze') { store.pick = id; save(); showTab('analysis'); }
  });

  $('cmp').addEventListener('change', (e) => {
    const t = e.target; if (!t.matches || !t.matches('input[data-cmp]')) return;
    if (!toggleCompare(t.dataset.cmp, t.checked)) t.checked = false;
  });
  $('cmpBtn').addEventListener('click', () => showTab('compare'));

  // ---------- filter window ----------
  const fdlg = $('filterDlg');
  function rangeBounds(r) {
    const vs = store.listings.map((l) => r.get(l)).filter((v) => v != null);
    if (!vs.length) return null;
    let lo = Math.floor(Math.min(...vs) / r.step) * r.step, hi = Math.ceil(Math.max(...vs) / r.step) * r.step;
    const cur = view.ranges[r.key]; if (cur) { lo = Math.min(lo, cur[0]); hi = Math.max(hi, cur[1]); }
    if (hi === lo) hi = lo + r.step;
    return { lo, hi };
  }
  function uniqueValues(field, only) {
    const m = new Map();
    store.listings.forEach((l) => { const v = (l[field] || '').trim(); if (v && (!only || only(l))) { const k = norm(v); if (!m.has(k)) m.set(k, v); } });
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1], 'de'));
  }
  function chipGroup(name, entries, selected, emptyText) {
    if (!entries.length) return `<p class="small muted">${emptyText}</p>`;
    return '<div class="chips">' + entries.map(([k, v]) => `<label><input type="checkbox" data-grp="${name}" value="${esc(k)}" ${selected.has(k) ? 'checked' : ''}>${esc(v)}</label>`).join('') + '</div>';
  }
  function buildRange(r) {
    const b = rangeBounds(r);
    if (!b) return `<div class="rng off"><div class="rng-head"><span>${esc(r.label)}</span><b>No data yet</b></div></div>`;
    const cur = view.ranges[r.key] || [b.lo, b.hi];
    return `<div class="rng" data-key="${r.key}" data-lo="${b.lo}" data-hi="${b.hi}">
      <div class="rng-head"><span>${esc(r.label)}</span><b class="rng-val"></b></div>
      <div class="rng-track"><div class="rng-bar"><div class="rng-fill"></div></div>
        <input type="range" class="lo" aria-label="${esc(r.label)} minimum" min="${b.lo}" max="${b.hi}" step="${r.step}" value="${cur[0]}">
        <input type="range" class="hi" aria-label="${esc(r.label)} maximum" min="${b.lo}" max="${b.hi}" step="${r.step}" value="${cur[1]}"></div></div>`;
  }
  function syncRange(el, changed) {
    const r = RANGES.find((x) => x.key === el.dataset.key), lo = el.querySelector('.lo'), hi = el.querySelector('.hi');
    let a = +lo.value, b = +hi.value;
    if (a > b) { if (changed === 'lo') { a = b; lo.value = a; } else { b = a; hi.value = b; } }
    const min = +el.dataset.lo, max = +el.dataset.hi;
    el.querySelector('.rng-val').textContent = `${r.fmt(a)} – ${r.fmt(b)}`;
    const f = el.querySelector('.rng-fill'); f.style.left = ((a - min) / (max - min)) * 100 + '%'; f.style.right = 100 - ((b - min) / (max - min)) * 100 + '%';
    if (changed) { if (a <= min && b >= max) delete view.ranges[r.key]; else view.ranges[r.key] = [a, b]; }
  }
  function buildFilter() {
    const cities = uniqueValues('city');
    const dists = uniqueValues('district', (l) => !view.cities.size || view.cities.has(norm(l.city)));
    const present = new Set(store.listings.map((l) => l.type || 'apartment'));
    const typeEntries = [['apartment', 'Apartment'], ['house', 'House']].filter(([k]) => present.has(k));
    $('filterBody').innerHTML = (typeEntries.length > 1 ? '<h3>Property type</h3>' + chipGroup('type', typeEntries, view.types, '') : '') + '<h3>City</h3>' + chipGroup('city', cities, view.cities, 'No city entered yet. Add it when you edit an apartment.') +
      '<h3>District (Stadtteil)</h3>' + chipGroup('district', dists, view.districts, 'No district entered yet.') +
      '<div style="margin-top:14px">' + RANGES.map(buildRange).join('') + '</div>' +
      '<p class="small muted">Apartments without a value for a narrowed range (for example no rent entered) are hidden.</p>';
    $('filterBody').querySelectorAll('.rng[data-key]').forEach((el) => syncRange(el, null));
    updateFilterDone();
  }
  function updateFilterDone() { const n = store.listings.filter(matches).length; $('filterDone').textContent = `Show ${n} apartment${n === 1 ? '' : 's'}`; }
  $('filterBtn').addEventListener('click', () => { buildFilter(); fdlg.showModal(); });
  $('filterClose').addEventListener('click', () => fdlg.close());
  $('filterDone').addEventListener('click', () => fdlg.close());
  $('filterReset').addEventListener('click', () => { resetFilters(); buildFilter(); renderShortlist(); });
  $('filterBody').addEventListener('input', (e) => {
    const t = e.target; if (t.type !== 'range') return;
    syncRange(t.closest('.rng'), t.classList.contains('lo') ? 'lo' : 'hi'); renderShortlist(); updateFilterDone();
  });
  $('filterBody').addEventListener('change', (e) => {
    const t = e.target; if (t.type !== 'checkbox') return;
    const set = t.dataset.grp === 'type' ? view.types : t.dataset.grp === 'city' ? view.cities : view.districts;
    if (t.checked) set.add(t.value); else set.delete(t.value);
    if (t.dataset.grp === 'city') { // keep only districts that belong to the chosen cities
      const ok = new Set(store.listings.filter((l) => !view.cities.size || view.cities.has(norm(l.city))).map((l) => norm(l.district)));
      [...view.districts].forEach((k) => { if (!ok.has(k)) view.districts.delete(k); });
      buildFilter();
    }
    renderShortlist(); updateFilterDone();
  });

  // ---------- add/edit dialog ----------
  const dlg = $('dlg');
  function openDialog(id, prefill) {
    editingId = id || null;
    const l = id ? store.listings.find((x) => x.id === id) : (prefill || { state: store.search?.state || store.draft.state || 'NW' });
    $('dlgTitle').textContent = id ? 'Edit property' : 'Add property';
    $('d_title').value = l.title ?? ''; $('d_url').value = l.url ?? ''; $('d_price').value = l.price ?? ''; $('d_size').value = l.size ?? '';
    $('d_rooms').value = l.rooms ?? ''; $('d_state').value = l.state || 'NW'; $('d_rent').value = l.rent ?? '';
    $('d_hausgeld').value = l.hausgeld ?? ''; $('d_umlage').value = l.umlagefaehig ?? ''; $('d_notes').value = l.notes ?? '';
    $('d_district').value = l.district ?? ''; $('d_postal').value = l.postalCode ?? ''; $('d_city').value = l.city ?? '';
    $('d_type').value = l.type || 'apartment'; $('d_plot').value = l.plotSize ?? ''; applyTypeUI('d_');
    $('d_garage').value = l.garagePrice ?? ''; $('d_commission').value = l.commissionPct ?? '';
    const b = l.building || {};
    $('d_b_year').value = b.yearBuilt ?? ''; $('d_b_condition').value = b.condition ?? ''; $('d_b_features').value = b.features ?? '';
    $('d_b_heating').value = b.heating ?? ''; $('d_b_certAvail').value = b.certAvailable ?? ''; $('d_b_certType').value = b.certType ?? '';
    $('d_b_demand').value = b.energyDemand ?? ''; $('d_b_class').value = b.energyClass ?? ''; $('d_b_certYear').value = b.certYear ?? '';
    resetPairs('d_');
    document.querySelectorAll('#dlg .missing').forEach((e) => e.classList.remove('missing'));
    const banner = $('aiBanner');
    banner.hidden = !(prefill && prefill.aiNote);
    banner.textContent = prefill && prefill.aiNote ? prefill.aiNote : '';
    if (prefill && prefill.missing) prefill.missing.forEach((fid) => $(fid).classList.add('missing'));
    dlg.showModal();
  }
  function applyTypeUI(p) { // houses: plot size field and "ancillary costs" wording instead of Hausgeld
    const house = val(p + 'type') === 'house';
    $(p + 'plotLbl').hidden = !house;
    $(p + 'hgLbl').textContent = house ? 'Ancillary & upkeep costs (€/month)' : 'Hausgeld total (€/month)';
    $(p + 'hgm2Lbl').textContent = house ? 'Ancillary costs (€/m²/month)' : 'Hausgeld (€/m²/month)';
  }
  $('d_type').addEventListener('change', () => applyTypeUI('d_'));
  $('addBtn').addEventListener('click', () => openDialog());
  $('dlgCancel').addEventListener('click', () => dlg.close());
  $('d_url').addEventListener('change', () => { // suggest a title from the portal name
    const u = safeUrl(val('d_url')); if (!u || val('d_title')) return;
    const h = new URL(u).hostname.replace(/^www\./, '');
    $('d_title').value = 'Listing on ' + h;
  });
  $('dlgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = val('d_url').trim();
    if (url && !safeUrl(url)) { alert('Please enter a valid link starting with http:// or https://'); return; }
    const l = {
      id: editingId || 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: val('d_title').trim(), url, price: +val('d_price') || 0, size: r2(+val('d_size') || 0), rooms: numOrNull('d_rooms'),
      state: val('d_state'), rent: r2(+val('d_rent') || 0), hausgeld: r2(+val('d_hausgeld') || 0), umlagefaehig: r2(+val('d_umlage') || 0), notes: val('d_notes').trim(),
      district: val('d_district').trim(), postalCode: val('d_postal').trim(), city: val('d_city').trim(),
      type: val('d_type'), plotSize: numOrNull('d_plot'),
      garagePrice: numOrNull('d_garage'), commissionPct: numOrNull('d_commission'),
      building: {
        yearBuilt: numOrNull('d_b_year'), condition: val('d_b_condition').trim(), features: val('d_b_features').trim(), heating: val('d_b_heating').trim(),
        certAvailable: val('d_b_certAvail'), certType: val('d_b_certType'), energyDemand: numOrNull('d_b_demand'), energyClass: val('d_b_class'), certYear: numOrNull('d_b_certYear'),
      },
    };
    const i = store.listings.findIndex((x) => x.id === l.id);
    if (i >= 0) store.listings[i] = l; else store.listings.push(l);
    save(); dlg.close(); aiStatus('');
    if (e.submitter && e.submitter.id === 'dlgAnalyze') { store.pick = l.id; save(); showTab('analysis'); } else { renderShortlist(); if ($('tab-analysis').classList.contains('active')) renderAnalysis(); }
  });

  // ---------- AI: read exposé ----------
  const AIKEY = 'apartmentCompass.ai';
  let ai = { key: '', model: window.AI.DEFAULT_MODEL, ack: false };
  try { ai = { ...ai, ...JSON.parse(localStorage.getItem(AIKEY) || '{}') }; } catch (e) { /* ignore */ }
  const saveAi = () => { try { localStorage.setItem(AIKEY, JSON.stringify(ai)); } catch (e) { /* ignore */ } };
  const aiDlg = $('aiDlg');
  function aiMsg(text, cls) { const m = $('ai_msg'); m.textContent = text; m.className = 'small ' + (cls || ''); }
  function openAiSettings() { $('ai_key').value = ai.key; $('ai_model').value = ai.model || window.AI.DEFAULT_MODEL; aiMsg(''); aiDlg.showModal(); }
  $('aiSettingsBtn').addEventListener('click', openAiSettings);
  $('aiClose').addEventListener('click', () => aiDlg.close());
  $('aiClear').addEventListener('click', () => { ai.key = ''; saveAi(); $('ai_key').value = ''; aiMsg('Key removed from this browser.', 'ok-msg'); });
  $('aiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    ai.key = val('ai_key').trim(); ai.model = val('ai_model').trim() || window.AI.DEFAULT_MODEL; saveAi();
    aiMsg('Testing…'); $('aiSave').disabled = true;
    try { await window.AI.testKey({ apiKey: ai.key, model: ai.model }); aiMsg('✓ Key and model work. You can now read exposés.', 'ok-msg'); }
    catch (err) { aiMsg(err.message || 'Test failed.', 'err-msg'); }
    $('aiSave').disabled = false;
  });

  function aiStatus(text, cls) { const s = $('aiStatus'); s.hidden = !text; s.textContent = text || ''; s.className = cls || ''; }
  $('readBtn').addEventListener('click', () => {
    if (!ai.key) { aiStatus('Add your free Gemini API key first (AI settings, top right).', 'err'); openAiSettings(); return; }
    if (!ai.ack) {
      if (!confirm('The PDF will be sent to Google\'s Gemini API for reading. On the free tier, Google may use content to improve its products.\n\nOnly upload public apartment exposés, nothing personal or financial.\n\nContinue?')) return;
      ai.ack = true; saveAi();
    }
    $('readFile').click();
  });
  $('readFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    $('readBtn').disabled = true; aiStatus(`Reading "${file.name}"… this can take up to a minute.`);
    try {
      const { data: d, warnings } = await window.AI.readExpose(file, { apiKey: ai.key, model: ai.model });
      const missing = [];
      const need = [['d_price', d.price], ['d_size', d.size], ['d_rent', d.rent], ['d_hausgeld', d.hausgeld]];
      need.forEach(([fid, v]) => { if (v == null) missing.push(fid); });
      const notes = [d.notes, d.floor && 'Floor: ' + d.floor].filter(Boolean).join(' · ');
      const unfilled = need.filter(([, v]) => v == null).map(([fid]) => ({ d_price: 'price', d_size: 'size', d_rent: 'rent', d_hausgeld: 'Hausgeld' }[fid]));
      aiStatus('✓ Document read. Please check every value in the form.', 'ok');
      openDialog(null, {
        title: d.title || file.name.replace(/\.pdf$/i, ''), url: '', price: d.price ?? '', size: d.size ?? '', rooms: d.rooms, type: d.propertyType, plotSize: d.plot, state: d.state || store.search?.state || 'NW',
        rent: d.rent ?? '', hausgeld: d.hausgeld ?? '', umlagefaehig: d.umlage ?? '', notes, district: d.district, postalCode: d.postalCode, city: d.city, building: d.building, garagePrice: d.garage, commissionPct: d.commission, missing,
        aiNote: 'Filled in by AI from "' + file.name + '". AI can misread numbers, so check every value against the document.' +
          (unfilled.length ? ' Not found in the document (highlighted): ' + unfilled.join(', ') + '.' : '') + (warnings.length ? ' ' + warnings.join(' ') : '') +
          (d.state ? '' : ' Federal state could not be determined, so please choose it.'),
      });
    } catch (err) {
      const known = err instanceof window.AI.ReadError;
      aiStatus(known ? err.message : 'Something went wrong while reading the document. Please try again.', 'err');
      if (!known) console.error(err);
    }
    $('readBtn').disabled = false;
  });

  // ---------- export / import ----------
  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'apartment-compass', version: 1, listings: store.listings, assumptions: store.assumptions }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'apartment-shortlist.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'apartment-compass' || !Array.isArray(d.listings)) throw new Error('bad file');
      const ids = new Set(store.listings.map((l) => l.id));
      let added = 0;
      d.listings.forEach((l) => { if (l && l.title && !ids.has(l.id) && (!l.url || safeUrl(l.url))) { store.listings.push({ ...l, title: String(l.title), url: l.url || '', id: String(l.id || 'i' + Date.now() + added), price: +l.price || 0, size: +l.size || 0, rent: +l.rent || 0, hausgeld: +l.hausgeld || 0, umlagefaehig: +l.umlagefaehig || 0, state: STATES[l.state] ? l.state : 'NW', type: l.type === 'house' ? 'house' : 'apartment' }); added++; } });
      save(); renderShortlist(); alert(`Imported ${added} new propert${added === 1 ? 'y' : 'ies'}.`);
    } catch (err) { alert('This file could not be imported. Use a file exported from this app.'); }
    e.target.value = '';
  });

  // ---------- ANALYSIS ----------
  function currentListing() {
    const l = store.listings.find((x) => x.id === store.pick);
    return l ? { obj: l, saved: true } : { obj: store.draft, saved: false };
  }
  function fillPicker() {
    const sel = $('a_pick');
    sel.innerHTML = '<option value="">Quick scenario (not saved to shortlist)</option>' + store.listings.map((l) => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
    sel.value = store.listings.some((l) => l.id === store.pick) ? store.pick : '';
  }
  // Equity: the amount (€) and the percentage of this property's price are linked. Whichever was edited last is stored.
  function setEquityFields(skip) {
    const a = store.assumptions, price = +currentListing().obj.price || 0;
    const amount = a.equityMode === 'euro' ? a.equityValue : price * a.equityValue / 100;
    const pc = a.equityMode === 'percent' ? a.equityValue : (price > 0 ? a.equityValue / price * 100 : null);
    if (skip !== 'e_amount') $('e_amount').value = price > 0 || a.equityMode === 'euro' ? r2(amount) : '';
    if (skip !== 'e_pct') $('e_pct').value = pc == null ? '' : r2(pc);
  }
  function renderBrokerInfo() {
    const { obj } = currentListing();
    const own = obj.commissionPct != null && obj.commissionPct !== '';
    $('brokerInfo').textContent = own ? 'This apartment\'s own commission (from its exposé or your entry)' : `Default ${store.assumptions.brokerPct}% (none entered for this apartment)`;
  }
  function loadAnalysisFields() {
    const { obj, saved } = currentListing();
    $('a_price').value = obj.price ?? ''; $('a_size').value = obj.size ?? ''; $('a_state').value = obj.state || 'NW';
    $('a_type').value = obj.type || 'apartment'; $('a_plot').value = obj.plotSize ?? ''; applyTypeUI('a_');
    $('a_rent').value = obj.rent ?? ''; $('a_hausgeld').value = obj.hausgeld ?? ''; $('a_umlage').value = obj.umlagefaehig ?? '';
    resetPairs('a_');
    $('a_note').textContent = saved ? 'Changes here are saved to this apartment in your shortlist.' : 'Type any numbers to try a scenario. To keep it, add the apartment on the Shortlist tab.';
    const a = store.assumptions;
    setEquityFields(); $('e_rate').value = a.ratePct; $('e_repay').value = a.repayPct;
    $('e_fix').value = a.fixYears; $('e_notary').value = a.notaryPct; $('e_broker').value = obj.commissionPct ?? a.brokerPct; renderBrokerInfo(); $('e_vac').value = a.vacancyPct;
    $('e_maint').value = a.maintPerSqm; $('e_maintH').value = a.maintPerSqmHouse; $('e_mgmt').value = a.mgmtPerMonth;
  }
  const CERT = { available: 'Available', 'not available': 'Not available' };
  const CERT_TYPE = { demand: 'Demand certificate', consumption: 'Consumption certificate' };
  function renderBuilding() {
    const l = store.listings.find((x) => x.id === store.pick);
    const card = $('buildingCard');
    $('r_costs').innerHTML = '';
    const locEl = $('r_location'), locText = l ? fmtLocation(l) : '';
    locEl.hidden = !locText; locEl.textContent = locText ? '📍 ' + locText : '';
    card.hidden = !l; // only for saved apartments, not the quick scenario
    if (!l) return;
    $('editBuilding').hidden = false; $('editBuilding').dataset.id = l.id;
    const b = l.building || {};
    const crow = [
      ['Purchase price', l.price > 0 ? eur(l.price) : null],
      ['Price per m²', l.price > 0 && l.size > 0 ? eur(l.price / l.size) + ' /m²' : null],
      ['Purchase price for garage/parking space', l.garagePrice != null && l.garagePrice !== '' ? eur(l.garagePrice) : null],
      ['Commission for buyer', l.commissionPct != null && l.commissionPct !== '' ? l.commissionPct + '% incl. VAT' : null],
    ].filter((r) => r[1] != null);
    $('r_costs').innerHTML = crow.length ? '<dl class="bgrid">' + crow.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') + '</dl>' : '<p class="muted">No cost details yet.</p>';
    const rows = [
      ['Property type', l.type === 'house' ? 'House' : null], ['Plot size', l.type === 'house' && l.plotSize > 0 ? fmtSize(l.plotSize) + ' m²' : null],
      ['Year built', b.yearBuilt], ['Condition', b.condition], ['Features', b.features], ['Type of heating', b.heating],
      ['Energy certificate', CERT[b.certAvailable]], ['Type of energy certificate', CERT_TYPE[b.certType]],
      ['Final energy demand', b.energyDemand != null ? `${b.energyDemand} kWh/(m²·a)` : null],
      ['Energy efficiency class', b.energyClass ? `<span class="badge">${esc(b.energyClass)}</span>` : null, true],
      ['Year of construction per certificate', b.certYear],
    ].filter((r) => r[1] != null && r[1] !== '');
    $('r_building').innerHTML = rows.length
      ? '<dl class="bgrid">' + rows.map(([k, v, raw]) => `<div><dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd></div>`).join('') + '</dl>'
      : '<p class="muted">No building details yet. Click Edit to add them.</p>';
  }
  $('editBuilding').addEventListener('click', () => { if ($('editBuilding').dataset.id) openDialog($('editBuilding').dataset.id); });
  function renderCmpButton() {
    const btn = $('addCmp'), l = store.listings.find((x) => x.id === store.pick);
    btn.hidden = !l; if (!l) return;
    const inC = store.compare.ids.includes(l.id);
    btn.textContent = inC ? `✓ In comparison (${store.compare.ids.length}/3) · remove` : `+ Add to comparison (${store.compare.ids.length}/3)`;
    btn.className = inC ? '' : 'primary';
  }
  $('addCmp').addEventListener('click', () => {
    const l = store.listings.find((x) => x.id === store.pick); if (!l) return;
    toggleCompare(l.id, !store.compare.ids.includes(l.id));
    renderCmpButton();
  });
  function renderAnalysis() { fillPicker(); loadAnalysisFields(); renderBuilding(); renderCmpButton(); renderRateInfo(); renderResults(); }

  $('a_pick').addEventListener('change', () => { store.pick = val('a_pick') || null; save(); loadAnalysisFields(); renderBuilding(); renderCmpButton(); renderResults(); });
  $('a_listing').addEventListener('input', () => {
    const { obj } = currentListing();
    obj.price = +val('a_price') || 0; obj.size = r2(+val('a_size') || 0); obj.state = val('a_state');
    obj.type = val('a_type'); obj.plotSize = numOrNull('a_plot'); applyTypeUI('a_'); setEquityFields();
    obj.rent = r2(+val('a_rent') || 0); obj.hausgeld = r2(+val('a_hausgeld') || 0); obj.umlagefaehig = r2(+val('a_umlage') || 0);
    save(); renderResults();
  });
  const A_MAP = { e_maintH: 'maintPerSqmHouse', e_rate: 'ratePct', e_repay: 'repayPct', e_fix: 'fixYears', e_notary: 'notaryPct', e_broker: 'brokerPct', e_vac: 'vacancyPct', e_maint: 'maintPerSqm', e_mgmt: 'mgmtPerMonth' };
  document.querySelectorAll('#assumpCard input').forEach((el) => el.addEventListener('input', () => {
    const a = store.assumptions;
    if (el.id === 'e_amount' || el.id === 'e_pct') {
      a.equityMode = el.id === 'e_amount' ? 'euro' : 'percent'; a.equityValue = el.value === '' ? 0 : +el.value;
      setEquityFields(el.id);
    }
    else if (el.id === 'e_broker') { // the commission belongs to the apartment; blank falls back to the default
      currentListing().obj.commissionPct = el.value === '' ? null : +el.value;
      renderBrokerInfo(); renderBuilding();
    } else { a[A_MAP[el.id]] = el.value === '' ? 0 : +el.value; if (el.id === 'e_rate') { a.followBundesbank = false; renderRateInfo(); } }
    save(); renderResults();
  }));
  $('resetRate').addEventListener('click', () => { store.assumptions.followBundesbank = true; applyBundesbank(); save(); loadAnalysisFields(); renderRateInfo(); renderResults(); });
  $('resetAssump').addEventListener('click', () => { store.assumptions = { ...DEFAULT_ASSUMPTIONS }; applyBundesbank(); save(); loadAnalysisFields(); renderRateInfo(); renderResults(); });

  const hgName = (l) => (l.type === 'house' ? 'ancillary & upkeep costs' : 'Hausgeld');
  function kpi(k, v, h, cls = '') { return `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${h ? `<div class="h">${h}</div>` : ''}</div>`; }
  function lines(rows) { return '<table class="lines">' + rows.map(([a, b, cls]) => `<tr class="${cls || ''}"><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>'; }

  function renderResults() {
    const { obj } = currentListing();
    const a = analyze(obj, store.assumptions), as = store.assumptions;
    if (!(a.price > 0)) { ['r_loan', 'r_rent', 'r_own', 'r_chart'].forEach((id) => { $(id).innerHTML = '<p class="muted">Enter a purchase price to see results.</p>'; }); $('r_sched').innerHTML = ''; return; }
    const warns = [];
    if (a.equity < a.costs.total) warns.push('Your equity does not even cover the purchase costs. Most banks expect equity to cover the costs (about 10–15% of the price) at least.');
    if (a.principal > 0 && !isFinite(a.loan.yearsToPayoff)) warns.push('With these terms the loan never gets repaid. Increase the initial repayment.');
    const w = warns.map((x) => `<p class="warn">⚠ ${x}</p>`).join('');

    $('r_loan').innerHTML = w + '<div class="kv">' +
      kpi('Monthly loan payment', eur(a.loan.payment), `${as.ratePct}% interest + ${as.repayPct}% repayment`) +
      kpi(`Remaining debt after ${as.fixYears} yrs`, eur(a.loan.balanceAtFix), 'when the fixed rate ends') +
      kpi('Time to full repayment', isFinite(a.loan.yearsToPayoff) ? n1(a.loan.yearsToPayoff) + ' yrs' : 'never', 'if the rate stayed the same') + '</div>' +
      lines([
        ['Purchase price', eur(a.price)],
        [`Property transfer tax (${a.costs.taxPct}%)`, eur(a.costs.transferTax)],
        [`Notary + land registry (${as.notaryPct}%)`, eur(a.costs.notary)],
        [`Agent commission (${a.costs.brokerPct}%${obj.commissionPct != null && obj.commissionPct !== '' ? ', from exposé' : ', default'})`, eur(a.costs.broker)],
        ['Total purchase cost', eur(a.totalCost), 'total'],
        ['− Your equity', eur(a.equity)],
        ['Loan amount', eur(a.principal), 'total'],
        [`Total interest over the fixed period`, eur(a.loan.interestFix)],
        ['Total interest until repaid', isFinite(a.loan.yearsToPayoff) ? eur(a.loan.totalInterest) : '–'],
      ]);

    if (!(a.annualRent > 0)) { $('r_rent').innerHTML = '<p class="muted">Enter an expected cold rent to see yield and cash flow.</p>'; }
    else $('r_rent').innerHTML = '<div class="kv">' +
      kpi('Gross yield', pct(a.grossYield), 'annual cold rent ÷ price') +
      kpi('Net yield', pct(a.netYield), 'after costs, on total purchase cost') +
      kpi('Cash flow / month', eur(a.cashflow / 12), 'before tax, after loan payment', sign(a.cashflow)) +
      kpi('Return on equity', pct(a.cashOnCash), `cash flow ÷ equity · ${pct(a.cashOnCashWithRepay)} incl. debt repaid in year 1`, sign(a.cashOnCash)) + '</div>' +
      lines([
        ['Annual cold rent', eur(a.annualRent)],
        [`− Vacancy allowance (${as.vacancyPct}%)`, eur(a.annualRent - a.effectiveRent)],
        [`− Non-recoverable ${hgName(obj)}`, eur(a.nonRecoverable)],
        ['− Maintenance', eur(a.maintenance)],
        ['− Rental management', eur(a.mgmt)],
        ['Net operating income', eur(a.noi), 'total'],
        ['− Loan payments (interest + repayment)', eur(a.annualDebt)],
        ['Cash flow per year (before tax)', eur(a.cashflow), 'total'],
        ['Price-to-rent factor', n1(a.priceToRent) + '×'],
        ['Break-even rent (cash flow = 0)', eur(a.breakEvenRent) + ' / month'],
      ]) + '<p class="small muted">Tax is not included (income tax on rent, depreciation/AfA, speculation period). Ask a tax advisor. Property tax (Grundsteuer) is normally part of the Hausgeld/ancillary costs.</p>';

    $('r_own').innerHTML = '<div class="kv">' + kpi('Monthly cost of owning', eur(a.ownerMonthly), `loan + total ${hgName(obj)} + maintenance`) +
      kpi('Compare with renting', a.annualRent > 0 ? eur(obj.rent) + ' / month' : '–', 'cold rent entered above, plus utilities') + '</div>' +
      lines([['Loan payment', eur(a.loan.payment)], [`${hgName(obj)} (incl. heating, water etc.)`, eur(obj.hausgeld)], ['Maintenance', eur(a.maintenance / 12)], ['Total per month', eur(a.ownerMonthly), 'total']]) +
      `<p class="small muted">Of the loan payment about ${eur(a.loan.year1Principal / 12)} per month in year 1 builds your equity. The rest is interest.</p>`;

    renderChart(a, as);
  }

  function renderChart(a, as) {
    const rows = a.loan.rows;
    if (!rows.length) { $('r_chart').innerHTML = '<p class="muted">No loan needed with this equity.</p>'; $('r_sched').innerHTML = ''; return; }
    const yrs = Math.min(rows.length, 40), W = 640, H = 220, pl = 52, pb = 22, pt = 10, pr = 10;
    const max = a.principal, x = (y) => pl + ((W - pl - pr) * y) / yrs, y = (v) => pt + (H - pt - pb) * (1 - v / max);
    const pts = [[0, a.principal]].concat(rows.slice(0, yrs).map((r) => [r.year, r.balance]));
    const path = pts.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
    const fx = Math.min(as.fixYears, yrs);
    let grid = '';
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; grid += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v / 1000)}k</text>`; }
    let xt = ''; for (let t = 0; t <= yrs; t += yrs > 25 ? 10 : 5) xt += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}y</text>`;
    $('r_chart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Remaining loan balance by year">${grid}${xt}
      <line x1="${x(fx)}" x2="${x(fx)}" y1="${pt}" y2="${H - pb}" stroke="var(--accent)" stroke-dasharray="4 3"/><text x="${x(fx) + 4}" y="${pt + 10}" style="fill:var(--accent)">fixed rate ends</text>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5"/></svg>`;
    const show = rows;
    const sumI = rows.reduce((s, r) => s + r.interest, 0), sumP = rows.reduce((s, r) => s + r.principal, 0);
    $('r_sched').innerHTML = '<thead><tr><th class="nosort">Year</th><th class="nosort">Interest</th><th class="nosort">Repayment</th><th class="nosort">Remaining debt</th></tr></thead><tbody>' +
      show.map((r) => `<tr><td>${r.year}</td><td>${eur(r.interest)}</td><td>${eur(r.principal)}</td><td>${eur(r.balance)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td>Total</td><td>${eur(sumI)}</td><td>${eur(sumP)}</td><td></td></tr></tfoot>`;
  }


  // ---------- COMPARE ----------
  const MAXCMP = 3, LETTERS = ['A', 'B', 'C'], DASH = ['', '7 4', '2 4'];
  const ENERGY = ['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  let toastTimer = null;
  function toast(msg, action) {
    const t = $('toast'); t.textContent = '';
    const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.addEventListener('click', () => { t.hidden = true; action.run(); }); t.appendChild(b); }
    t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }
  function cmpState() {
    const c = store.compare;
    c.ids = c.ids.filter((id) => store.listings.some((l) => l.id === id)).slice(0, MAXCMP);
    Object.keys(c.eq).forEach((id) => { if (!c.ids.includes(id)) delete c.eq[id]; });
    return c;
  }
  function updateCmpCounts() {
    const n = cmpState().ids.length;
    $('cmpCount').textContent = n; $('cmpBtnCount').textContent = n;
  }
  /** Adds/removes a property. Returns false (and warns) if the comparison is already full. */
  function toggleCompare(id, on) {
    const c = cmpState();
    if (on) {
      if (c.ids.includes(id)) return true;
      if (c.ids.length >= MAXCMP) {
        toast('Your comparison already has 3 properties (A, B, C). Remove one in the Compare tab before adding another.', { label: 'Open Compare', run: () => showTab('compare') });
        return false;
      }
      c.ids.push(id);
    } else { c.ids = c.ids.filter((x) => x !== id); delete c.eq[id]; }
    save(); updateCmpCounts();
    if ($('tab-compare').classList.contains('active')) renderCompare();
    return true;
  }

  function cmpColumns() {
    const c = cmpState(), cols = [];
    c.ids.forEach((id, i) => {
      const l = store.listings.find((x) => x.id === id); let mode, value;
      if (c.eq[id]) { mode = c.eq[id].mode; value = c.eq[id].value; }
      else if (c.sameEquity && i > 0) { mode = 'euro'; value = cols[0].a.equity; } // same amount as A
      else { mode = store.assumptions.equityMode; value = store.assumptions.equityValue; }
      const asm = { ...store.assumptions, equityMode: mode, equityValue: value };
      cols.push({ id, l, asm, a: analyze(l, asm), own: !!c.eq[id] });
    });
    return cols;
  }

  // One row = label + value per column. best: 'low' | 'high' marks the best value; delta: how to show the gap to A.
  const rent = (l) => (l.rent > 0 ? l.rent : null);
  const hasRent = (a) => a.annualRent > 0;
  const SECTIONS = [
    ['Basics', [
      { label: 'Property type', text: (l) => (l.type === 'house' ? 'House' : 'Apartment') },
      { label: 'Location', text: (l) => fmtLocation(l) || STATES[l.state]?.name || null },
      { label: 'Size (m²)', val: (l, a) => a.size || null, fmt: (v) => fmtSize(v) + ' m²' },
      { label: 'Plot size (m²)', val: (l) => (l.type === 'house' && l.plotSize > 0 ? l.plotSize : null), fmt: (v) => fmtSize(v) + ' m²' },
      { label: 'Rooms', val: (l) => l.rooms ?? null, fmt: String },
      { label: 'Year built', val: (l) => l.building?.yearBuilt ?? null, fmt: String },
    ]],
    ['Costs', [
      { label: 'Purchase price', val: (l, a) => a.price || null, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Price (€/m²)', val: (l, a) => a.pricePerSqm, fmt: (v) => eur(v) + ' /m²', best: 'low', delta: 'eur' },
      { label: 'Garage/parking price', val: (l) => (l.garagePrice != null && l.garagePrice !== '' ? +l.garagePrice : null), fmt: eur },
      { label: 'Property transfer tax', val: (l, a) => a.costs.transferTax, fmt: eur, best: 'low', delta: 'eur', sub: (l, a) => a.costs.taxPct + '%' },
      { label: 'Notary + land registry', val: (l, a) => a.costs.notary, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Agent commission', val: (l, a) => a.costs.broker, fmt: eur, best: 'low', delta: 'eur', sub: (l, a) => a.costs.brokerPct + '%' + (l.commissionPct != null && l.commissionPct !== '' ? ' (exposé)' : ' (default)') },
      { label: 'Total purchase cost', val: (l, a) => a.totalCost || null, fmt: eur, best: 'low', delta: 'eur' },
    ]],
    ['Financing', [
      { equity: true },
      { label: 'Loan amount', val: (l, a) => a.principal, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Monthly loan payment', val: (l, a) => a.loan.payment, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Debt left after fixed period', val: (l, a) => a.loan.balanceAtFix, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Interest paid in fixed period', val: (l, a) => a.loan.interestFix, fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Time to full repayment', val: (l, a) => (isFinite(a.loan.yearsToPayoff) ? a.loan.yearsToPayoff : null), fmt: (v) => n1(v) + ' yrs', best: 'low', delta: 'num' },
    ]],
    ['If rented out', [
      { label: 'Cold rent (€/month)', val: (l) => rent(l), fmt: eur, delta: 'eur' },
      { label: 'Gross yield', val: (l, a) => a.grossYield, fmt: (v) => pct(v), best: 'high', delta: 'pts' },
      { label: 'Net yield', val: (l, a) => a.netYield, fmt: (v) => pct(v), best: 'high', delta: 'pts' },
      { label: 'Cash flow (€/month, before tax)', val: (l, a) => (hasRent(a) ? a.cashflow / 12 : null), fmt: eur, best: 'high', delta: 'eur' },
      { label: 'Return on equity', val: (l, a) => a.cashOnCash, fmt: (v) => pct(v), best: 'high', delta: 'pts' },
      { label: 'Break-even rent (€/month)', val: (l, a) => (a.price > 0 ? a.breakEvenRent : null), fmt: eur, best: 'low', delta: 'eur' },
      { label: 'Price-to-rent factor', val: (l, a) => a.priceToRent, fmt: (v) => n1(v) + '×', best: 'low', delta: 'num' },
    ]],
    ['If you live in it', [
      { label: 'Monthly cost of owning', val: (l, a) => (a.price > 0 ? a.ownerMonthly : null), fmt: eur, best: 'low', delta: 'eur' },
    ]],
    ['Building & energy', [
      { label: 'Condition', text: (l) => l.building?.condition || null },
      { label: 'Features', text: (l) => l.building?.features || null },
      { label: 'Type of heating', text: (l) => l.building?.heating || null },
      { label: 'Energy efficiency class', val: (l) => { const i = ENERGY.indexOf(l.building?.energyClass); return i >= 0 ? i : null; }, fmt: (v) => ENERGY[v], best: 'low' },
      { label: 'Final energy demand', val: (l) => l.building?.energyDemand ?? null, fmt: (v) => v + ' kWh/(m²·a)', best: 'low', delta: 'num' },
    ]],
  ];
  const signed = (d, f) => (d > 0 ? '+' : d < 0 ? '−' : '±') + f(Math.abs(d));
  const deltaText = (kind, d) => (kind === 'eur' ? signed(d, (x) => eur(x)) : kind === 'pts' ? signed(d, (x) => (x * 100).toFixed(2) + ' pts') : signed(d, (x) => n1(x)));

  /** Builds the comparison as data (used for both the HTML table and "Copy as table"). */
  function cmpModel(cols) {
    const wins = cols.map(() => 0); let measures = 0;
    const sections = SECTIONS.map(([title, rows]) => ({
      title,
      rows: rows.map((r) => {
        if (r.equity) return { equity: true };
        const cells = cols.map((c) => {
          if (r.text) return { text: r.text(c.l) || '–', v: null };
          const v = r.val(c.l, c.a); return { v, text: v == null || !isFinite(v) ? '–' : r.fmt(v), sub: v != null && r.sub ? r.sub(c.l, c.a) : '' };
        });
        const vs = cells.map((x) => x.v).filter((v) => v != null && isFinite(v));
        if (r.best && vs.length >= 2) {
          const target = r.best === 'low' ? Math.min(...vs) : Math.max(...vs);
          if (vs.some((v) => Math.abs(v - target) > 1e-9)) { // not all equal
            measures++;
            cells.forEach((x, i) => { if (x.v != null && Math.abs(x.v - target) < 1e-9) { x.best = true; wins[i]++; } });
          }
        }
        if (r.delta && cells[0].v != null) cells.forEach((x, i) => { if (i > 0 && x.v != null && isFinite(x.v)) x.delta = deltaText(r.delta, x.v - cells[0].v); });
        return { label: r.label, cells };
      }),
    }));
    return { sections, wins, measures };
  }

  const colorOf = (i) => `var(--c${i + 1})`;
  const shortTitle = (l) => (l.title.length > 26 ? l.title.slice(0, 25) + '…' : l.title);

  function renderCompare() {
    const c = cmpState(); updateCmpCounts(); save();
    const cols = cmpColumns();
    $('cmpSame').checked = c.sameEquity; $('cmpDiff').checked = c.diff;
    $('printHead').textContent = `Apartment Compass · comparison · ${new Date().toLocaleDateString('en-GB')} · interest ${store.assumptions.ratePct}% · repayment ${store.assumptions.repayPct}% · fixed ${store.assumptions.fixYears} yrs`;
    // slots
    const opts = (sel) => '<option value="">– empty –</option>' + store.listings.map((l) => `<option value="${esc(l.id)}" ${l.id === sel ? 'selected' : ''}>${esc(l.title)}</option>`).join('');
    $('cmpSlots').innerHTML = LETTERS.map((L, i) => `<label>${L}<select data-slot="${i}">${opts(c.ids[i])}</select></label>`).join('');
    $('cmpEmpty').hidden = cols.length >= 2; $('cmpBody').hidden = cols.length < 1;
    $('cmpSummary').textContent = '';
    if (cols.length < 1) return;
    const m = cmpModel(cols);
    $('cmpSummary').textContent = cols.length >= 2 && m.measures
      ? 'Best value in: ' + cols.map((x, i) => `${LETTERS[i]} ${m.wins[i]}`).join(' · ') + ` (of ${m.measures} measures with data). A count of measures, not a recommendation.`
      : '';
    const head = '<thead><tr><th></th>' + cols.map((x, i) => `<th class="colhead"><span class="letter" style="background:${colorOf(i)}">${LETTERS[i]}</span>${safeUrl(x.l.url) ? `<a href="${esc(safeUrl(x.l.url))}" target="_blank" rel="noopener noreferrer">${esc(x.l.title)} ↗</a>` : esc(x.l.title)}
      <div class="acts noprint"><button class="link" data-act="analyze" data-i="${i}">Analyze</button><button class="link" data-act="edit" data-i="${i}">Edit</button><button class="link danger" data-act="remove" data-i="${i}">Remove</button></div></th>`).join('') + '</tr></thead>';
    const body = '<tbody>' + m.sections.map((s) => `<tr class="sec"><th colspan="${cols.length + 1}">${esc(s.title)}</th></tr>` + s.rows.map((r) => {
      if (r.equity) {
        return '<tr><th scope="row">Equity</th>' + cols.map((x, i) => {
          const price = x.a.price, pc = price > 0 ? r2(x.a.equity / price * 100) : '';
          const note = x.own ? `adjusted for this one · <button class="link" data-act="eqreset" data-i="${i}">reset</button>` : (c.sameEquity && i > 0 ? 'same amount as A' : 'from Assumptions');
          return `<td><div class="eqin"><input type="text" inputmode="decimal" data-eq="amount" data-i="${i}" value="${r2(x.a.equity)}" aria-label="Equity amount ${LETTERS[i]}"><span>€</span></div>
            <div class="eqin"><input type="text" inputmode="decimal" data-eq="pct" data-i="${i}" value="${pc}" aria-label="Equity percent ${LETTERS[i]}"><span>%</span></div><span class="sub">${note}</span></td>`;
        }).join('') + '</tr>';
      }
      return `<tr><th scope="row">${esc(r.label)}</th>` + r.cells.map((x) => `<td class="${x.best ? 'best' : ''}">${esc(x.text)}${x.sub ? `<span class="sub">${esc(x.sub)}</span>` : ''}${c.diff && x.delta ? `<span class="delta">${esc(x.delta)} vs. A</span>` : ''}</td>`).join('') + '</tr>';
    }).join('')).join('') + '</tbody>';
    $('cmpTable').innerHTML = head + body;
    $('cmpLoanChart').innerHTML = cmpLoanChart(cols);
    $('cmpBar').innerHTML = cmpBarChart(cols);
  }

  function legend(cols) {
    return '<div class="legend">' + cols.map((x, i) => `<span><svg width="28" height="10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke="${colorOf(i)}" stroke-width="3" ${DASH[i] ? `stroke-dasharray="${DASH[i]}"` : ''}/></svg>${LETTERS[i]} · ${esc(shortTitle(x.l))}</span>`).join('') + '</div>';
  }
  function cmpLoanChart(cols) {
    const withLoan = cols.map((x, i) => ({ x, i })).filter((o) => o.x.a.loan.rows.length);
    if (!withLoan.length) return '<p class="muted">No loan needed with these equity amounts.</p>';
    const W = 640, H = 240, pl = 56, pb = 24, pt = 12, pr = 12, fix = store.assumptions.fixYears;
    const yrs = Math.min(40, Math.max(...withLoan.map((o) => o.x.a.loan.rows.length)));
    const max = Math.max(...withLoan.map((o) => o.x.a.principal));
    const X = (v) => pl + ((W - pl - pr) * v) / yrs, Y = (v) => pt + (H - pt - pb) * (1 - v / max);
    let g = ''; for (let k = 0; k <= 4; k++) { const v = (max * k) / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v / 1000)}k</text>`; }
    for (let t = 0; t <= yrs; t += yrs > 25 ? 10 : 5) g += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${t}y</text>`;
    const fx = Math.min(fix, yrs);
    const lines = withLoan.map(({ x, i }) => {
      const pts = [[0, x.a.principal]].concat(x.a.loan.rows.slice(0, yrs).map((r) => [r.year, r.balance]));
      return `<path d="${pts.map((p, k) => (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${colorOf(i)}" stroke-width="2.5" ${DASH[i] ? `stroke-dasharray="${DASH[i]}"` : ''}/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Remaining loan balance by year for each compared property">${g}<line x1="${X(fx)}" x2="${X(fx)}" y1="${pt}" y2="${H - pb}" stroke="var(--muted)" stroke-dasharray="2 3"/><text x="${X(fx) + 4}" y="${pt + 10}">fixed rate ends</text>${lines}</svg>` + legend(cols);
  }
  function cmpBarChart(cols) {
    const W = 640, H = 240, pl = 12, pr = 12, pt = 22, pb = 34, n = cols.length;
    const data = cols.map((x) => ({ own: x.a.price > 0 ? x.a.ownerMonthly : 0, rent: rent(x.l) || 0 }));
    const max = Math.max(1, ...data.flatMap((d) => [d.own, d.rent]));
    const gw = (W - pl - pr) / n, bw = Math.min(46, gw / 3), Y = (v) => pt + (H - pt - pb) * (1 - v / max), base = H - pb;
    const bars = data.map((d, i) => {
      const cx = pl + gw * i + gw / 2;
      const mk = (v, dx, solid) => v > 0 ? `<rect x="${cx + dx}" y="${Y(v)}" width="${bw}" height="${base - Y(v)}" fill="${colorOf(i)}" ${solid ? '' : `fill-opacity=".35" stroke="${colorOf(i)}" stroke-width="1.5"`}/><text x="${cx + dx + bw / 2}" y="${Y(v) - 5}" text-anchor="middle">${eur(v)}</text>` : '';
      return mk(d.own, -bw - 2, true) + mk(d.rent, 2, false) + `<text x="${cx}" y="${H - 10}" text-anchor="middle" style="font-weight:700">${LETTERS[i]}</text>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly cost of owning versus cold rent for each compared property"><line x1="${pl}" x2="${W - pr}" y1="${base}" y2="${base}" stroke="var(--line)"/>${bars}</svg>
      <div class="legend"><span><svg width="14" height="14"><rect width="14" height="14" fill="var(--muted)"/></svg>Solid: monthly cost of owning (loan + ${cols.some((x) => x.l.type === 'house') ? 'ancillary/Hausgeld' : 'Hausgeld'} + maintenance)</span><span><svg width="14" height="14"><rect width="14" height="14" fill="var(--muted)" fill-opacity=".35" stroke="var(--muted)" stroke-width="1.5"/></svg>Light: expected cold rent (if entered)</span></div>`;
  }

  // slot selects, toggles, equity edits, actions
  $('cmpSlots').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-slot]'); if (!sel) return;
    const i = +sel.dataset.slot, c = cmpState(), id = sel.value;
    if (!id) { if (c.ids[i]) toggleCompare(c.ids[i], false); return; }
    if (c.ids.includes(id) && c.ids[i] !== id) { toast('That property is already in the comparison.'); renderCompare(); return; }
    if (c.ids[i]) { delete c.eq[c.ids[i]]; c.ids[i] = id; } else c.ids.push(id);
    save(); renderCompare();
  });
  $('cmpSame').addEventListener('change', (e) => { store.compare.sameEquity = e.target.checked; save(); renderCompare(); });
  $('cmpDiff').addEventListener('change', (e) => { store.compare.diff = e.target.checked; save(); renderCompare(); });
  $('cmpClear').addEventListener('click', () => { store.compare.ids = []; store.compare.eq = {}; save(); updateCmpCounts(); renderCompare(); });
  const parseNum = (s) => { const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : null; };
  $('cmpTable').addEventListener('input', (e) => { // keep € and % of one column linked while typing
    const t = e.target; if (!t.dataset || !t.dataset.eq) return;
    const x = cmpColumns()[+t.dataset.i], price = x.a.price, v = parseNum(t.value), td = t.closest('td');
    const other = td.querySelector(`input[data-eq="${t.dataset.eq === 'amount' ? 'pct' : 'amount'}"]`);
    if (v == null || !(price > 0)) return;
    other.value = t.dataset.eq === 'amount' ? r2(v / price * 100) : r2(price * v / 100);
  });
  $('cmpTable').addEventListener('change', (e) => { // commit the edit as this column's own equity
    const t = e.target; if (!t.dataset || !t.dataset.eq) return;
    const x = cmpColumns()[+t.dataset.i], v = parseNum(t.value);
    if (v == null) { renderCompare(); return; }
    store.compare.eq[x.id] = { mode: t.dataset.eq === 'amount' ? 'euro' : 'percent', value: v };
    save(); renderCompare();
  });
  $('cmpTable').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const x = cmpColumns()[+b.dataset.i]; if (!x) return;
    if (b.dataset.act === 'remove') toggleCompare(x.id, false);
    if (b.dataset.act === 'analyze') { store.pick = x.id; save(); showTab('analysis'); }
    if (b.dataset.act === 'edit') openDialog(x.id);
    if (b.dataset.act === 'eqreset') { delete store.compare.eq[x.id]; save(); renderCompare(); }
  });
  $('cmpPrint').addEventListener('click', () => window.print());
  $('cmpCopy').addEventListener('click', async () => {
    const cols = cmpColumns(); if (cols.length < 1) { toast('Nothing to copy yet. Add properties first.'); return; }
    const m = cmpModel(cols), lines = [['', ...cols.map((x, i) => `${LETTERS[i]}: ${x.l.title}`)].join('\t')];
    m.sections.forEach((s) => { lines.push(s.title.toUpperCase()); s.rows.forEach((r) => {
      if (r.equity) lines.push(['Equity', ...cols.map((x) => `${eur(x.a.equity)} (${x.a.price > 0 ? r2(x.a.equity / x.a.price * 100) : '–'}%)`)].join('\t'));
      else lines.push([r.label, ...r.cells.map((x) => x.text + (x.sub ? ` (${x.sub})` : ''))].join('\t'));
    }); });
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into Excel, Sheets or an email.'); }
    catch (err) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied. Paste it into Excel, Sheets or an email.'); } catch (e2) { toast('Copy failed. Use Print / save as PDF instead.'); } ta.remove(); }
  });

  // ---------- Bundesbank rate ----------
  const BB_URL = 'https://api.statistiken.bundesbank.de/rest/data/BBIM1/M.DE.B.A2C.P.R.A.2250.EUR.N?lastNObservations=1&detail=dataonly';
  function applyBundesbank() { if (store.bb && store.assumptions.followBundesbank) store.assumptions.ratePct = store.bb.rate; }
  function renderRateInfo() {
    const bb = store.bb, a = store.assumptions;
    $('rateInfo').textContent = bb
      ? `Bundesbank average ${bb.rate.toFixed(2)}% (${bb.period}, new housing loans, fixation >10 yrs)${a.followBundesbank ? ' · in use' : ' · overridden by you'}`
      : 'Bundesbank rate unavailable. Using your own value.';
  }
  async function loadBundesbank() {
    try {
      const r = await fetch(BB_URL, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const s = Object.values(j.data.dataSets[0].series)[0].observations;
      const k = Object.keys(s).pop();
      const rate = parseFloat(s[k][0]);
      const period = j.data.structure.dimensions.observation[0].values[+k].id;
      if (!isFinite(rate)) throw new Error('no value');
      store.bb = { rate, period, fetched: Date.now() };
      applyBundesbank(); save();
    } catch (e) { /* keep cached value, if any */ }
    renderRateInfo();
    if ($('tab-analysis').classList.contains('active')) { loadAnalysisFields(); renderResults(); }
    if ($('tab-shortlist').classList.contains('active')) renderShortlist();
  }

  // ---------- init ----------
  loadSearch();
  $('count').textContent = store.listings.length; updateCmpCounts();
  applyBundesbank(); renderRateInfo();
  const start = (location.hash || '').slice(1);
  showTab(['search', 'shortlist', 'analysis', 'compare'].includes(start) ? start : 'search');
  loadBundesbank();
})();
