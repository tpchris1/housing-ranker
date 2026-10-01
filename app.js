/* Housing Ranker — vanilla JS single-page app.
 *
 * Data model (two JSON blobs in localStorage):
 *   hr_settings: { work_addresses:[{name,lat,lng}], primary_work_address (index),
 *                  num_cars, weight_presets:[{id,name,weights}], active_preset_id, onboarded }
 *   hr_apartments: { [name]: { address, website, year_built, walk_score, latitude,
 *                  longitude, commute_minutes, commute_estimated, google_review, notes,
 *                  created_at, neighborhood_vibe, condition_score, appliances_score,
 *                  gut_feeling, parking_spots_included, parking_cost_extra, parking_type,
 *                  washer_dryer, dishwasher, stove_type, fridge, closet_style, floor_type,
 *                  ac_type, floor_plans:[{name,price,sqft,hoa,property_tax}] } }
 *
 * Scoring: each apartment x floor plan is a candidate. Per-category min-max
 * normalization across the current candidate set, then weighted sum.
 */
'use strict';

/* ============================== constants ============================== */

const SETTINGS_KEY = 'hr_settings';
const APARTMENTS_KEY = 'hr_apartments';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=';
// Assumed average driving speed for commute estimates (no paid API key needed).
const ASSUMED_KMH = 40;

const CATEGORIES = [
  { key: 'rent',         label: 'Rent' },
  { key: 'commute',      label: 'Commute' },
  { key: 'space',        label: 'Living Space' },
  { key: 'walkability',  label: 'Walkability' },
  { key: 'condition',    label: 'Building Condition' },
  { key: 'appliances',   label: 'Appliances' },
  { key: 'preference',   label: 'Personal Preference' },
];

const STARTER_PRESETS = [
  { id: 'balanced', name: 'Balanced',
    weights: { rent: 20, commute: 15, space: 15, walkability: 15, condition: 15, appliances: 10, preference: 10 } },
  { id: 'budget', name: 'Budget Saver',
    weights: { rent: 45, commute: 10, space: 10, walkability: 10, condition: 10, appliances: 5, preference: 10 } },
  { id: 'short-commute', name: 'Short Commute',
    weights: { rent: 15, commute: 45, space: 10, walkability: 10, condition: 5, appliances: 5, preference: 10 } },
  { id: 'max-space', name: 'Max Space',
    weights: { rent: 15, commute: 10, space: 45, walkability: 5, condition: 10, appliances: 5, preference: 10 } },
];

/* ============================== utilities ============================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// Blank-safe number: '' / null / undefined / NaN -> 0
const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt$ = n => '$' + Math.round(num(n)).toLocaleString('en-US');
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(msg) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}

// Minimal inline SVG icons (stroke style, no emoji).
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  share: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
};
const icon = (name, label) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
  (label ? ' role="img" aria-label="' + esc(label) + '"' : '') + '>' + ICONS[name] + '</svg>';

/* ============================== state ============================== */

let settings = null;    // hr_settings blob
let apartments = {};    // hr_apartments blob
let sortMode = 'score'; // 'score' | 'cost'
let activeTab = 'rankings';
const compareSel = new Set(); // candidate keys ticked for comparison (session only)

function freshSettings() {
  return {
    work_addresses: [],
    primary_work_address: 0,
    num_cars: 1,
    weight_presets: STARTER_PRESETS.map(p => ({ id: p.id, name: p.name, weights: { ...p.weights } })),
    active_preset_id: 'balanced',
    onboarded: false,
  };
}

function loadState() {
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || freshSettings();
  } catch (e) { settings = freshSettings(); }
  try {
    apartments = JSON.parse(localStorage.getItem(APARTMENTS_KEY)) || {};
  } catch (e) { apartments = {}; }
  if (!Array.isArray(settings.weight_presets) || !settings.weight_presets.length) {
    settings.weight_presets = freshSettings().weight_presets;
    settings.active_preset_id = 'balanced';
  }
}

function save() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(APARTMENTS_KEY, JSON.stringify(apartments));
}

const activePreset = () =>
  settings.weight_presets.find(p => p.id === settings.active_preset_id) || settings.weight_presets[0];

const primaryWork = () => settings.work_addresses[settings.primary_work_address] || null;

/* ============================== scoring engine ============================== */

// True monthly cost for one candidate: rent + HOA + property tax/12 +
// extra parking for cars beyond the included spots.
function trueMonthlyCost(apt, plan) {
  const overflow = Math.max(0, num(settings.num_cars) - num(apt.parking_spots_included));
  return num(plan.price) + num(plan.hoa) + num(plan.property_tax) / 12 +
    overflow * num(apt.parking_cost_extra);
}

// Min-max normalize an array of raw values to 0-100 sub-scores.
// lowerBetter=true inverts (e.g. cost). Uniform input -> everyone gets 100.
function normalize(values, lowerBetter) {
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  return values.map(v => {
    if (max === min) return 100;
    return lowerBetter
      ? (max - v) / (max - min) * 100
      : (v - min) / (max - min) * 100;
  });
}

const candKey = c => c.aptName + ' ||| ' + c.plan.name;

// Build every apartment x floor plan candidate, score them, return sorted.
function buildCandidates() {
  const cands = [];
  Object.keys(apartments).forEach(aptName => {
    const apt = apartments[aptName];
    (apt.floor_plans || []).forEach(plan => {
      cands.push({ aptName, apt, plan, key: aptName + ' ||| ' + plan.name });
    });
  });

  // Raw category inputs.
  cands.forEach(c => {
    const sqft = num(c.plan.sqft);
    c.cost = trueMonthlyCost(c.apt, c.plan);
    c.commute = num(c.apt.commute_minutes);
    c.sqft = sqft;
    c.ppsf = sqft > 0 ? num(c.plan.price) / sqft : null; // $/sqft; null if unknown
    c.walk = num(c.apt.walk_score);                       // blank -> 0
    c.cond = num(c.apt.condition_score);
    c.appl = num(c.apt.appliances_score);
    c.pref = (num(c.apt.neighborhood_vibe) + num(c.apt.gut_feeling)) / 2;
  });
  // Unknown $/sqft must not win by default: assign the worst observed value.
  const knownPpsf = cands.map(c => c.ppsf).filter(v => v !== null);
  const worstPpsf = knownPpsf.length ? Math.max.apply(null, knownPpsf) : 0;
  cands.forEach(c => { if (c.ppsf === null) c.ppsf = worstPpsf; });

  const nCost = normalize(cands.map(c => c.cost), true);
  const nComm = normalize(cands.map(c => c.commute), true);
  const nSqft = normalize(cands.map(c => c.sqft), false);
  const nPpsf = normalize(cands.map(c => c.ppsf), true);
  const nWalk = normalize(cands.map(c => c.walk), false);
  const nCond = normalize(cands.map(c => c.cond), false);
  const nAppl = normalize(cands.map(c => c.appl), false);
  const nPref = normalize(cands.map(c => c.pref), false);

  const w = activePreset().weights;
  cands.forEach((c, i) => {
    c.sub = {
      rent: nCost[i],
      commute: nComm[i],
      space: 0.5 * nSqft[i] + 0.5 * nPpsf[i], // 50/50 blend: sqft (higher better) + $/sqft (lower better)
      walkability: nWalk[i],
      condition: nCond[i],
      appliances: nAppl[i],
      preference: nPref[i],
    };
    c.total = (w.rent * c.sub.rent + w.commute * c.sub.commute + w.space * c.sub.space +
      w.walkability * c.sub.walkability + w.condition * c.sub.condition +
      w.appliances * c.sub.appliances + w.preference * c.sub.preference) / 100;
  });
  return cands;
}

function sortedCandidates() {
  const cands = buildCandidates();
  cands.sort((a, b) => sortMode === 'cost' ? a.cost - b.cost : b.total - a.total);
  return cands;
}

/* ============================== geocoding & commute ============================== */

// Nominatim (OpenStreetMap) — free, no API key. Usage policy asks for at most
// 1 request/second, hence the throttle below. Browser sends Referer automatically.
let lastGeoAt = 0;
async function geocode(query) {
  const wait = Math.max(0, 1000 - (Date.now() - lastGeoAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastGeoAt = Date.now();
  const res = await fetch(NOMINATIM_URL + encodeURIComponent(query), { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Geocoding request failed (HTTP ' + res.status + ')');
  const data = await res.json();
  if (!data || !data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLa = (b.lat - a.lat) * Math.PI / 180;
  const dLo = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rough drive-time estimate from straight-line distance. Clearly labeled as an
// estimate everywhere it is shown; the user can always type the real number.
function estimateCommuteMinutes(aptLat, aptLng, work) {
  const km = haversineKm({ lat: aptLat, lng: aptLng }, work);
  return Math.round(km / ASSUMED_KMH * 60);
}

/* ============================== rendering ============================== */

function setTab(name) {
  activeTab = name;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ['rankings', 'apartments', 'compare', 'settings'].forEach(t => {
    $('#tab-' + t).hidden = t !== name;
  });
  if (name === 'rankings') renderRankings();
  if (name === 'apartments') renderApartments();
  if (name === 'compare') renderCompare();
  if (name === 'settings') renderSettings();
}

function renderAll() {
  renderPresetBar();
  setTab(activeTab);
}

function renderPresetBar() {
  const sel = $('#preset-select');
  sel.innerHTML = settings.weight_presets
    .map(p => '<option value="' + esc(p.id) + '"' + (p.id === activePreset().id ? ' selected' : '') + '>' + esc(p.name) + '</option>')
    .join('');
}

/* ---------- rankings ---------- */

function subBars(c) {
  return CATEGORIES.map(cat => {
    const v = Math.round(c.sub[cat.key]);
    return '<div class="sub"><span class="n">' + esc(cat.label) + '</span>' +
      '<span class="b"><i style="width:' + v + '%"></i></span>' +
      '<span class="v">' + v + '</span></div>';
  }).join('');
}

function commuteLabel(apt) {
  const mins = apt.commute_minutes;
  if (mins === '' || mins == null) return 'commute n/a';
  const tag = apt.commute_estimated ? '<span class="est-tag">est.</span>' : '';
  return 'commute ' + esc(mins) + ' min' + tag;
}

function renderRankings() {
  const body = $('#rankings-body');
  const cands = sortedCandidates();
  $('#sort-score').classList.toggle('active', sortMode === 'score');
  $('#sort-cost').classList.toggle('active', sortMode === 'cost');

  if (!cands.length) {
    body.innerHTML = '<div class="empty"><p>No apartments yet. Add your first candidate to start ranking.</p>' +
      '<button class="btn primary" id="empty-add">Add apartment</button></div>';
    $('#empty-add').onclick = () => openApartmentForm();
    return;
  }

  body.innerHTML = '<div class="cards">' + cands.map((c, i) => {
    const ppsf = c.sqft > 0 ? fmt$(num(c.plan.price) / c.sqft) + '/sqft' : '';
    const checked = compareSel.has(c.key) ? ' checked' : '';
    return '<div class="card' + (i === 0 && sortMode === 'score' ? ' top' : '') + '">' +
      '<div class="card-head"><span class="rank">#' + (i + 1) + '</span>' +
      '<span class="card-title">' + esc(c.aptName) + ' <span class="plan">· ' + esc(c.plan.name) + '</span></span></div>' +
      '<div class="score-line"><span class="score-num">' + c.total.toFixed(1) + '</span>' +
      '<span class="score-bar"><i style="width:' + Math.round(c.total) + '%"></i></span></div>' +
      '<div class="cost-line">True cost ' + fmt$(c.cost) + '/mo</div>' +
      '<div class="facts"><span>' + fmt$(c.plan.price) + '/mo rent</span>' +
      (c.sqft ? '<span>' + esc(String(c.sqft)) + ' sqft (' + ppsf + ')</span>' : '') +
      '<span>' + commuteLabel(c.apt) + '</span>' +
      (c.apt.walk_score !== '' && c.apt.walk_score != null ? '<span>Walk ' + esc(String(c.apt.walk_score)) + '</span>' : '') +
      '</div>' +
      '<div class="subs">' + subBars(c) + '</div>' +
      '<div class="card-foot"><label class="cmp-check"><input type="checkbox" data-cmp="' + esc(c.key) + '"' + checked + '> Compare</label></div>' +
      '</div>';
  }).join('') + '</div>';

  $$('#rankings-body [data-cmp]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) compareSel.add(cb.dataset.cmp); else compareSel.delete(cb.dataset.cmp);
    };
  });
}

/* ---------- apartments list ---------- */

function renderApartments() {
  const body = $('#apartments-body');
  const names = Object.keys(apartments).sort();
  if (!names.length) {
    body.innerHTML = '<div class="empty"><p>No apartments saved yet.</p></div>';
    return;
  }
  body.innerHTML = names.map(n => {
    const a = apartments[n];
    const plans = (a.floor_plans || []).map(p => esc(p.name) + ' ' + fmt$(p.price)).join(', ') || 'no floor plans';
    return '<div class="apt-row"><span class="nm">' + esc(n) + '</span>' +
      '<span class="meta">' + esc(plans) + '</span>' +
      '<span class="ops">' +
      '<button class="icon-btn" data-edit="' + esc(n) + '" title="Edit" aria-label="Edit ' + esc(n) + '">' + icon('edit') + '</button>' +
      '<button class="icon-btn danger" data-del="' + esc(n) + '" title="Delete" aria-label="Delete ' + esc(n) + '">' + icon('trash') + '</button>' +
      '</span></div>';
  }).join('');

  $$('#apartments-body [data-edit]').forEach(b => { b.onclick = () => openApartmentForm(b.dataset.edit); });
  $$('#apartments-body [data-del]').forEach(b => {
    b.onclick = () => {
      if (confirm('Delete "' + b.dataset.del + '" and all its floor plans?')) {
        delete apartments[b.dataset.del];
        save(); renderAll();
        toast('Apartment deleted');
      }
    };
  });
}

/* ---------- compare table ---------- */

function compareRows() {
  const money = v => (v === '' || v == null) ? '—' : fmt$(v);
  const txt = v => (v === '' || v == null) ? '—' : esc(String(v));
  return [
    ['Score', c => '<b>' + c.total.toFixed(1) + '</b>'],
    ['True monthly cost', c => '<b>' + fmt$(c.cost) + '</b>'],
    ['Rent (plan price)', c => money(c.plan.price)],
    ['Floor plan', c => txt(c.plan.name)],
    ['Sqft', c => txt(c.plan.sqft)],
    ['$/sqft', c => (c.sqft > 0 ? fmt$(num(c.plan.price) / c.sqft) : '—')],
    ['HOA /mo', c => money(c.plan.hoa)],
    ['Property tax /yr', c => money(c.plan.property_tax)],
    ['Commute', c => (c.apt.commute_minutes === '' || c.apt.commute_minutes == null)
      ? '—' : esc(String(c.apt.commute_minutes)) + ' min' + (c.apt.commute_estimated ? ' (est.)' : '')],
    ['Walk Score', c => txt(c.apt.walk_score)],
    ['Year built', c => txt(c.apt.year_built)],
    ['Google review', c => txt(c.apt.google_review)],
    ['Neighborhood vibe (1-10)', c => txt(c.apt.neighborhood_vibe)],
    ['Condition (1-10)', c => txt(c.apt.condition_score)],
    ['Appliances (1-10)', c => txt(c.apt.appliances_score)],
    ['Gut feeling (1-10)', c => txt(c.apt.gut_feeling)],
    ['Parking spots incl.', c => txt(c.apt.parking_spots_included)],
    ['Extra parking $/mo', c => money(c.apt.parking_cost_extra)],
    ['Parking type', c => txt(c.apt.parking_type)],
    ['Washer / dryer', c => txt(c.apt.washer_dryer)],
    ['Dishwasher', c => txt(c.apt.dishwasher)],
    ['Stove', c => txt(c.apt.stove_type)],
    ['Fridge', c => txt(c.apt.fridge)],
    ['Closets', c => txt(c.apt.closet_style)],
    ['Flooring', c => txt(c.apt.floor_type)],
    ['AC', c => txt(c.apt.ac_type)],
    ['Address', c => txt(c.apt.address)],
    ['Website', c => c.apt.website ? '<a href="' + esc(c.apt.website) + '" target="_blank" rel="noopener">link</a>' : '—'],
    ['Notes', c => txt(c.apt.notes)],
  ];
}

function renderCompare() {
  const table = $('#compare-table');
  const byScore = buildCandidates().sort((a, b) => b.total - a.total);
  let cands = byScore.filter(c => compareSel.has(c.key));
  if (!cands.length) cands = byScore.slice(0, 4);
  if (!cands.length) {
    table.innerHTML = '<tr><td>No candidates to compare yet.</td></tr>';
    return;
  }
  const head = '<tr><th></th>' + cands.map(c =>
    '<th class="num">' + esc(c.aptName) + '<br><span style="font-weight:400">' + esc(c.plan.name) +
    ' · ' + c.total.toFixed(1) + '</span></th>').join('') + '</tr>';
  table.innerHTML = head + compareRows().map(([label, fn]) =>
    '<tr><td class="attr">' + esc(label) + '</td>' +
    cands.map(c => '<td class="num">' + fn(c) + '</td>').join('') + '</tr>').join('');
}

/* ---------- settings ---------- */

function renderSettings() {
  const body = $('#settings-body');
  const wAddrs = settings.work_addresses.map((w, i) =>
    '<div class="addr-row"><input type="radio" name="primary-work" value="' + i + '"' +
    (i === settings.primary_work_address ? ' checked' : '') + ' title="Set as primary" aria-label="Set ' + esc(w.name) + ' as primary work address">' +
    '<b>' + esc(w.name) + '</b><span class="hint">' + esc(String(w.lat)) + ', ' + esc(String(w.lng)) + '</span>' +
    '<span class="ops" style="margin-left:auto;display:flex;gap:6px">' +
    '<button class="btn small danger" data-del-addr="' + i + '">Remove</button></span></div>').join('');

  const presets = settings.weight_presets.map(p => {
    const ws = CATEGORIES.map(c => c.label.split(' ')[0] + ' ' + p.weights[c.key]).join(' · ');
    return '<div class="preset-row"><span class="nm">' + esc(p.name) + '</span>' +
      (p.id === activePreset().id ? '<span class="badge">active</span>' : '') +
      '<span class="ws">' + esc(ws) + '</span>' +
      '<span class="ops" style="margin-left:auto;display:flex;gap:6px">' +
      (p.id !== activePreset().id ? '<button class="btn small" data-use-preset="' + esc(p.id) + '">Use</button>' : '') +
      '<button class="btn small" data-edit-preset="' + esc(p.id) + '">Edit</button>' +
      '<button class="btn small danger" data-del-preset="' + esc(p.id) + '">Delete</button>' +
      '</span></div>';
  }).join('');

  body.innerHTML =
    '<div class="set-section"><h3>Work addresses</h3>' + (wAddrs || '<p class="hint">None yet.</p>') +
    '<div class="row-flex" style="margin-top:10px"><button class="btn small" id="set-add-addr">Add work address</button></div></div>' +
    '<div class="set-section"><h3>Household</h3><div class="row-flex"><label class="fld" style="margin:0"><span>Number of cars</span>' +
    '<input type="number" id="set-cars" min="0" step="1" value="' + esc(String(settings.num_cars)) + '" style="width:90px"></label></div>' +
    '<p class="hint">Drives the parking math: cars beyond the included spots add the apartment\'s extra-parking cost.</p></div>' +
    '<div class="set-section"><h3>Weight presets</h3>' + presets +
    '<div class="row-flex" style="margin-top:10px"><button class="btn small" id="set-new-preset">New preset</button></div></div>' +
    '<div class="set-section"><h3>Data</h3><div class="row-flex">' +
    '<button class="btn small" id="set-export">Export JSON</button>' +
    '<button class="btn small" id="set-import">Import JSON</button>' +
    '<button class="btn small" id="set-share">Copy share link</button></div></div>' +
    '<div class="set-section danger-zone"><h3>Reset</h3><div class="row-flex">' +
    '<button class="btn small danger" id="set-reset">Delete all data…</button></div>' +
    '<p class="hint">Clears settings and apartments from this browser and returns to onboarding.</p></div>';

  $$('#settings-body [name="primary-work"]').forEach(r => {
    r.onchange = () => { settings.primary_work_address = parseInt(r.value, 10); save(); renderAll(); };
  });
  $$('#settings-body [data-del-addr]').forEach(b => {
    b.onclick = () => {
      const i = parseInt(b.dataset.delAddr, 10);
      if (settings.work_addresses.length <= 1) { toast('Keep at least one work address'); return; }
      if (!confirm('Remove this work address?')) return;
      settings.work_addresses.splice(i, 1);
      if (settings.primary_work_address >= settings.work_addresses.length) settings.primary_work_address = 0;
      else if (settings.primary_work_address === i) settings.primary_work_address = 0;
      save(); renderAll();
    };
  });
  $('#set-add-addr').onclick = openWorkAddressForm;
  $('#set-cars').onchange = e => { settings.num_cars = Math.max(0, parseInt(e.target.value, 10) || 0); save(); renderAll(); };
  $$('#settings-body [data-use-preset]').forEach(b => {
    b.onclick = () => { settings.active_preset_id = b.dataset.usePreset; save(); renderAll(); toast('Preset activated'); };
  });
  $$('#settings-body [data-edit-preset]').forEach(b => {
    b.onclick = () => openPresetEditor(b.dataset.editPreset);
  });
  $$('#settings-body [data-del-preset]').forEach(b => {
    b.onclick = () => {
      if (settings.weight_presets.length <= 1) { toast('Cannot delete the last preset'); return; }
      if (!confirm('Delete this weight preset?')) return;
      settings.weight_presets = settings.weight_presets.filter(p => p.id !== b.dataset.delPreset);
      if (settings.active_preset_id === b.dataset.delPreset) settings.active_preset_id = settings.weight_presets[0].id;
      save(); renderAll();
    };
  });
  $('#set-new-preset').onclick = () => openPresetEditor(null);
  $('#set-export').onclick = exportJSON;
  $('#set-import').onclick = () => $('#import-file').click();
  $('#set-share').onclick = copyShareLink;
  $('#set-reset').onclick = () => {
    if (confirm('Delete ALL Housing Ranker data in this browser? This cannot be undone.')) {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(APARTMENTS_KEY);
      location.reload();
    }
  };
}

/* ============================== modals ============================== */

function openModal(title, bodyNode, wide) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  const m = document.createElement('div');
  m.className = 'modal' + (wide ? ' wide' : '');
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-label', title);
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = title;
  const x = document.createElement('button');
  x.className = 'icon-btn modal-close';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '×';
  x.onclick = closeModal;
  head.appendChild(h); head.appendChild(x);
  const mb = document.createElement('div');
  mb.className = 'modal-body';
  mb.appendChild(bodyNode);
  m.appendChild(head); m.appendChild(mb);
  ov.appendChild(m);
  root.appendChild(ov);
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeModal(); });
  return mb;
}

function closeModal() { $('#modal-root').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function modalFooter(buttons) {
  const f = document.createElement('div');
  f.className = 'modal-foot';
  buttons.forEach(([label, cls, fn]) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.onclick = fn;
    f.appendChild(b);
  });
  return f;
}

const showErr = (box, msg) => { box.textContent = msg || ''; };

/* ---------- work-address sub-form (used by onboarding + settings) ---------- */
// Builds one address row: name, address text, geocode button, lat/lng, status, remove.
function workAddressRow(w, canRemove, onRemove) {
  w = w || { name: '', lat: '', lng: '' };
  const div = document.createElement('div');
  div.className = 'ob-addr';
  div.innerHTML =
    '<div class="fld-row">' +
    '<label class="fld"><span>Name</span><input type="text" data-wa="name" value="' + esc(w.name) + '" placeholder="e.g. Office"></label>' +
    '<label class="fld"><span>Address (for geocoding)</span><input type="text" data-wa="addr" value="' + esc(w.addr || '') + '" placeholder="1 Infinite Loop, Cupertino CA"></label>' +
    '</div>' +
    '<div class="geo-row">' +
    '<label class="fld"><span>Latitude</span><input type="number" step="any" data-wa="lat" value="' + esc(String(w.lat)) + '" placeholder="37.33"></label>' +
    '<label class="fld"><span>Longitude</span><input type="number" step="any" data-wa="lng" value="' + esc(String(w.lng)) + '" placeholder="-122.01"></label>' +
    '<button type="button" class="btn small" data-wa="geo">' + icon('pin') + ' Geocode</button>' +
    (canRemove ? '<button type="button" class="btn small danger" data-wa="rm">Remove</button>' : '') +
    '</div><div class="geo-status" data-wa="status"></div>';
  const status = $('[data-wa="status"]', div);
  $('[data-wa="geo"]', div).onclick = async ev => {
    const btn = ev.currentTarget;
    const q = $('[data-wa="addr"]', div).value.trim();
    if (!q) { status.textContent = 'Type an address first.'; return; }
    btn.disabled = true;
    status.className = 'geo-status';
    status.textContent = 'Looking up…';
    try {
      const g = await geocode(q);
      if (!g) { status.textContent = 'No results found — check the address or enter coordinates manually.'; }
      else {
        $('[data-wa="lat"]', div).value = g.lat.toFixed(6);
        $('[data-wa="lng"]', div).value = g.lng.toFixed(6);
        status.className = 'geo-status ok';
        status.textContent = 'Found: ' + g.display.slice(0, 90);
      }
    } catch (err) {
      status.textContent = 'Geocoding failed (' + err.message + '). Enter coordinates manually.';
    }
    btn.disabled = false;
  };
  if (canRemove) $('[data-wa="rm"]', div).onclick = () => { div.remove(); onRemove && onRemove(); };
  return div;
}

function readWorkAddressRow(div) {
  const lat = parseFloat($('[data-wa="lat"]', div).value);
  const lng = parseFloat($('[data-wa="lng"]', div).value);
  const name = $('[data-wa="name"]', div).value.trim();
  const addr = $('[data-wa="addr"]', div).value.trim();
  if (!name) return { error: 'Each work address needs a name.' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: 'Address "' + name + '" needs valid coordinates (use Geocode or type them).' };
  return { value: { name, lat, lng, addr } };
}

/* ---------- onboarding ---------- */

function openOnboarding() {
  const body = document.createElement('div');
  body.innerHTML =
    '<div class="ob-step"><h3>1. Where do you work?</h3><p class="hint">Used for commute estimates. The first address is the primary one.</p>' +
    '<div id="ob-addrs"></div><button type="button" class="btn small" id="ob-add-addr">Add another work address</button></div>' +
    '<div class="ob-step"><h3>2. How many cars?</h3>' +
    '<label class="fld" style="max-width:160px"><span>Number of cars</span><input type="number" id="ob-cars" min="0" step="1" value="1"></label></div>' +
    '<div class="ob-step"><h3>3. What matters most?</h3><p class="hint">Pick a starting weight preset — you can tweak or add presets later.</p>' +
    '<div class="radio-cards" id="ob-presets"></div></div>' +
    '<div class="err" id="ob-err"></div>';

  const addrsBox = $('#ob-addrs', body);
  const addRow = w => addrsBox.appendChild(workAddressRow(w, addrsBox.children.length > 0));
  addRow({ name: 'Office' });
  $('#ob-add-addr', body).onclick = () => addRow({ name: 'Work ' + (addrsBox.children.length + 1) });

  $('#ob-presets', body).innerHTML = STARTER_PRESETS.map((p, i) => {
    const ws = CATEGORIES.map(c => c.label + ' ' + p.weights[c.key]).join(' · ');
    return '<label class="radio-card"><input type="radio" name="ob-preset" value="' + esc(p.id) + '"' + (i === 0 ? ' checked' : '') + '>' +
      '<span class="rn">' + esc(p.name) + '</span><span class="rw">' + esc(ws) + '</span></label>';
  }).join('');

  body.appendChild(modalFooter([['Start ranking', 'primary', () => {
    const errBox = $('#ob-err', body);
    const rows = $$('#ob-addrs .ob-addr', body);
    if (!rows.length) { showErr(errBox, 'Add at least one work address.'); return; }
    const addrs = [];
    for (const r of rows) {
      const res = readWorkAddressRow(r);
      if (res.error) { showErr(errBox, res.error); return; }
      addrs.push(res.value);
    }
    const cars = Math.max(0, parseInt($('#ob-cars', body).value, 10) || 0);
    const picked = ($('input[name="ob-preset"]:checked', body) || {}).value || 'balanced';
    settings.work_addresses = addrs.map(a => ({ name: a.name, lat: a.lat, lng: a.lng }));
    settings.primary_work_address = 0;
    settings.num_cars = cars;
    settings.active_preset_id = picked;
    settings.onboarded = true;
    save(); closeModal(); renderAll();
    toast('Welcome — add your first apartment to start ranking');
  }]]));

  openModal('Welcome to Housing Ranker', body, true);
}

/* ---------- add/edit work address (settings) ---------- */

function openWorkAddressForm() {
  const body = document.createElement('div');
  const row = workAddressRow({ name: '' }, false);
  body.appendChild(row);
  const err = document.createElement('div');
  err.className = 'err';
  body.appendChild(err);
  body.appendChild(modalFooter([['Cancel', '', closeModal], ['Add address', 'primary', () => {
    const res = readWorkAddressRow(row);
    if (res.error) { showErr(err, res.error); return; }
    settings.work_addresses.push({ name: res.value.name, lat: res.value.lat, lng: res.value.lng });
    save(); closeModal(); renderAll();
    toast('Work address added');
  }]]));
  openModal('Add work address', body);
}

/* ---------- apartment form ---------- */

const WD_OPTIONS = ['', 'In-unit', 'Shared in building', 'Hookups only', 'None'];
const DW_OPTIONS = ['', 'Yes', 'No'];

function selectHTML(id, options, val) {
  return '<select id="' + id + '">' + options.map(o =>
    '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + (o === '' ? '—' : esc(o)) + '</option>').join('') + '</select>';
}

function planRowHTML(p) {
  p = p || {};
  return '<div class="plan-row" data-plan>' +
    '<label class="fld"><span>Plan name</span><input type="text" data-p="name" value="' + esc(p.name || '') + '" placeholder="1BR/1BA"></label>' +
    '<label class="fld"><span>Rent $/mo</span><input type="number" data-p="price" min="0" step="1" value="' + esc(p.price == null ? '' : p.price) + '"></label>' +
    '<label class="fld"><span>Sqft</span><input type="number" data-p="sqft" min="0" step="1" value="' + esc(p.sqft == null ? '' : p.sqft) + '"></label>' +
    '<label class="fld"><span>HOA $/mo</span><input type="number" data-p="hoa" min="0" step="1" value="' + esc(p.hoa == null ? '' : p.hoa) + '"></label>' +
    '<label class="fld"><span>Prop. tax $/yr</span><input type="number" data-p="property_tax" min="0" step="1" value="' + esc(p.property_tax == null ? '' : p.property_tax) + '"></label>' +
    '<button type="button" class="icon-btn danger" data-plan-rm title="Remove floor plan" aria-label="Remove floor plan">' + icon('trash') + '</button>' +
    '</div>';
}

function openApartmentForm(editName) {
  const isEdit = !!editName;
  const a = isEdit ? apartments[editName] : null;
  const v = k => (a ? a[k] : '');
  const body = document.createElement('div');

  body.innerHTML =
    '<div class="fsec">Basics</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Apartment name *</span><input type="text" id="f-name" value="' + esc(isEdit ? editName : '') + '" placeholder="e.g. Parkside Towers"></label>' +
    '<label class="fld"><span>Website</span><input type="url" id="f-website" value="' + esc(v('website')) + '" placeholder="https://…"></label>' +
    '</div>' +
    '<label class="fld"><span>Address</span><input type="text" id="f-address" value="' + esc(v('address')) + '" placeholder="123 Main St, Sunnyvale CA"></label>' +
    '<div class="geo-row">' +
    '<label class="fld"><span>Latitude</span><input type="number" step="any" id="f-lat" value="' + esc(v('latitude')) + '"></label>' +
    '<label class="fld"><span>Longitude</span><input type="number" step="any" id="f-lng" value="' + esc(v('longitude')) + '"></label>' +
    '<button type="button" class="btn small" id="f-geocode">' + icon('pin') + ' Geocode address</button>' +
    '</div><div class="geo-status" id="f-geo-status"></div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Year built</span><input type="number" id="f-year" min="1800" max="2100" step="1" value="' + esc(v('year_built')) + '"></label>' +
    '<label class="fld"><span>Walk Score (0–100)</span><input type="number" id="f-walk" min="0" max="100" step="1" value="' + esc(v('walk_score')) + '"></label>' +
    '<label class="fld"><span>Google review (0–5)</span><input type="number" id="f-gr" min="0" max="5" step="0.1" value="' + esc(v('google_review')) + '"></label>' +
    '</div>' +
    '<div class="geo-row">' +
    '<label class="fld"><span>Commute (minutes)</span><input type="number" id="f-commute" min="0" step="1" value="' + esc(v('commute_minutes')) + '"></label>' +
    '<button type="button" class="btn small" id="f-est-commute">Estimate from distance</button>' +
    '<span class="est-tag" id="f-est-tag" ' + (a && a.commute_estimated ? '' : 'hidden') + '>estimated</span>' +
    '</div>' +
    '<p class="hint">Estimate uses straight-line distance to your primary work address at an assumed ' + ASSUMED_KMH + ' km/h. Typing a value manually clears the estimate flag.</p>' +
    '<label class="fld"><span>Notes</span><textarea id="f-notes" placeholder="Anything else…">' + esc(v('notes')) + '</textarea></label>' +

    '<div class="fsec">Ratings (1–10)</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Neighborhood vibe</span><input type="number" id="f-vibe" min="1" max="10" step="1" value="' + esc(v('neighborhood_vibe') === '' ? 5 : v('neighborhood_vibe')) + '"></label>' +
    '<label class="fld"><span>Building condition</span><input type="number" id="f-cond" min="1" max="10" step="1" value="' + esc(v('condition_score') === '' ? 5 : v('condition_score')) + '"></label>' +
    '<label class="fld"><span>Appliances</span><input type="number" id="f-appl" min="1" max="10" step="1" value="' + esc(v('appliances_score') === '' ? 5 : v('appliances_score')) + '"></label>' +
    '<label class="fld"><span>Gut feeling</span><input type="number" id="f-gut" min="1" max="10" step="1" value="' + esc(v('gut_feeling') === '' ? 5 : v('gut_feeling')) + '"></label>' +
    '</div>' +

    '<div class="fsec">Parking & home details</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Parking spots included</span><input type="number" id="f-pspots" min="0" step="1" value="' + esc(v('parking_spots_included') === '' ? 0 : v('parking_spots_included')) + '"></label>' +
    '<label class="fld"><span>Extra parking $/mo per car</span><input type="number" id="f-pcost" min="0" step="1" value="' + esc(v('parking_cost_extra') === '' ? 0 : v('parking_cost_extra')) + '"></label>' +
    '<label class="fld"><span>Parking type</span><input type="text" id="f-ptype" value="' + esc(v('parking_type')) + '" placeholder="Garage / assigned / street"></label>' +
    '</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Washer / dryer</span>' + selectHTML('f-wd', WD_OPTIONS, v('washer_dryer')) + '</label>' +
    '<label class="fld"><span>Dishwasher</span>' + selectHTML('f-dw', DW_OPTIONS, v('dishwasher')) + '</label>' +
    '<label class="fld"><span>Stove type</span><input type="text" id="f-stove" value="' + esc(v('stove_type')) + '" placeholder="Gas / electric / induction"></label>' +
    '</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Fridge</span><input type="text" id="f-fridge" value="' + esc(v('fridge')) + '"></label>' +
    '<label class="fld"><span>Closets</span><input type="text" id="f-closet" value="' + esc(v('closet_style')) + '"></label>' +
    '<label class="fld"><span>Flooring</span><input type="text" id="f-floor" value="' + esc(v('floor_type')) + '" placeholder="Hardwood / carpet / laminate"></label>' +
    '<label class="fld"><span>AC</span><input type="text" id="f-ac" value="' + esc(v('ac_type')) + '" placeholder="Central / window / none"></label>' +
    '</div>' +

    '<div class="fsec">Floor plans</div>' +
    '<div id="f-plans"></div>' +
    '<button type="button" class="btn small" id="f-add-plan">Add floor plan</button>' +
    '<div class="err" id="f-err"></div>';

  const plansBox = $('#f-plans', body);
  const addPlan = p => {
    const tmp = document.createElement('div');
    tmp.innerHTML = planRowHTML(p);
    const row = tmp.firstChild;
    $('[data-plan-rm]', row).onclick = () => row.remove();
    plansBox.appendChild(row);
  };
  const existing = (a && a.floor_plans && a.floor_plans.length) ? a.floor_plans : [{}];
  existing.forEach(addPlan);
  $('#f-add-plan', body).onclick = () => addPlan({});

  // Geocode the apartment address into lat/lng.
  $('#f-geocode', body).onclick = async ev => {
    const btn = ev.currentTarget, status = $('#f-geo-status', body);
    const q = $('#f-address', body).value.trim();
    if (!q) { status.textContent = 'Type an address first.'; return; }
    btn.disabled = true; status.className = 'geo-status'; status.textContent = 'Looking up…';
    try {
      const g = await geocode(q);
      if (!g) status.textContent = 'No results found — check the address or enter coordinates manually.';
      else {
        $('#f-lat', body).value = g.lat.toFixed(6);
        $('#f-lng', body).value = g.lng.toFixed(6);
        status.className = 'geo-status ok';
        status.textContent = 'Found: ' + g.display.slice(0, 90);
      }
    } catch (err) { status.textContent = 'Geocoding failed (' + err.message + '). Enter coordinates manually.'; }
    btn.disabled = false;
  };

  // Commute estimate from distance; manual edits clear the flag.
  const estTag = $('#f-est-tag', body);
  $('#f-est-commute', body).onclick = () => {
    const lat = parseFloat($('#f-lat', body).value), lng = parseFloat($('#f-lng', body).value);
    const work = primaryWork();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast('Need apartment coordinates first'); return; }
    if (!work) { toast('Set a work address in Settings first'); return; }
    const mins = estimateCommuteMinutes(lat, lng, work);
    $('#f-commute', body).value = mins;
    estTag.hidden = false;
    body.dataset.estimated = '1';
    toast('Commute estimated at ~' + mins + ' min (straight-line, ' + ASSUMED_KMH + ' km/h)');
  };
  $('#f-commute', body).addEventListener('input', () => {
    estTag.hidden = true;
    delete body.dataset.estimated;
  });
  if (a && a.commute_estimated) body.dataset.estimated = '1';

  body.appendChild(modalFooter([['Cancel', '', closeModal], [(isEdit ? 'Save changes' : 'Add apartment'), 'primary', () => {
    const errBox = $('#f-err', body);
    const name = $('#f-name', body).value.trim();
    if (!name) { showErr(errBox, 'Apartment name is required.'); return; }
    if ((!isEdit || name !== editName) && apartments[name]) { showErr(errBox, 'An apartment with this name already exists.'); return; }

    const plans = [];
    for (const row of $$('#f-plans [data-plan]', body)) {
      const p = {
        name: $('[data-p="name"]', row).value.trim(),
        price: $('[data-p="price"]', row).value,
        sqft: $('[data-p="sqft"]', row).value,
        hoa: $('[data-p="hoa"]', row).value,
        property_tax: $('[data-p="property_tax"]', row).value,
      };
      if (!p.name && !p.price && !p.sqft) continue; // skip untouched rows
      if (!p.name) { showErr(errBox, 'Each floor plan needs a name.'); return; }
      plans.push(p);
    }

    const rec = {
      address: $('#f-address', body).value.trim(),
      website: $('#f-website', body).value.trim(),
      year_built: $('#f-year', body).value,
      walk_score: $('#f-walk', body).value,
      latitude: $('#f-lat', body).value,
      longitude: $('#f-lng', body).value,
      commute_minutes: $('#f-commute', body).value,
      commute_estimated: body.dataset.estimated === '1',
      google_review: $('#f-gr', body).value,
      notes: $('#f-notes', body).value.trim(),
      neighborhood_vibe: $('#f-vibe', body).value,
      condition_score: $('#f-cond', body).value,
      appliances_score: $('#f-appl', body).value,
      gut_feeling: $('#f-gut', body).value,
      parking_spots_included: $('#f-pspots', body).value,
      parking_cost_extra: $('#f-pcost', body).value,
      parking_type: $('#f-ptype', body).value.trim(),
      washer_dryer: $('#f-wd', body).value,
      dishwasher: $('#f-dw', body).value,
      stove_type: $('#f-stove', body).value.trim(),
      fridge: $('#f-fridge', body).value.trim(),
      closet_style: $('#f-closet', body).value.trim(),
      floor_type: $('#f-floor', body).value.trim(),
      ac_type: $('#f-ac', body).value.trim(),
      floor_plans: plans,
      created_at: isEdit ? (a.created_at || new Date().toISOString()) : new Date().toISOString(),
    };
    if (isEdit && name !== editName) delete apartments[editName];
    apartments[name] = rec;
    save(); closeModal(); renderAll();
    toast(isEdit ? 'Apartment updated' : 'Apartment added');
  }]]));

  openModal(isEdit ? 'Edit apartment' : 'Add apartment', body, true);
}

/* ---------- weight preset editor ---------- */

function openPresetEditor(presetId) {
  const isNew = !presetId;
  const p = isNew
    ? { id: uid(), name: '', weights: { ...activePreset().weights } }
    : settings.weight_presets.find(x => x.id === presetId);
  if (!p) return;
  const body = document.createElement('div');
  body.innerHTML =
    '<label class="fld"><span>Preset name</span><input type="text" id="p-name" value="' + esc(p.name) + '" placeholder="e.g. Pet friendly"></label>' +
    '<div class="fld-row">' + CATEGORIES.map(c =>
      '<label class="fld"><span>' + esc(c.label) + '</span>' +
      '<input type="number" data-w="' + c.key + '" min="0" max="100" step="1" value="' + esc(String(p.weights[c.key])) + '"></label>'
    ).join('') + '</div>' +
    '<p class="hint">Weights are integers and must sum to 100. Current sum: <b id="p-sum"></b></p>' +
    '<div class="err" id="p-err"></div>';

  const sumEl = $('#p-sum', body);
  const updateSum = () => {
    sumEl.textContent = $$('[data-w]', body).reduce((s, el) => s + (parseInt(el.value, 10) || 0), 0);
  };
  $$('[data-w]', body).forEach(el => el.addEventListener('input', updateSum));
  updateSum();

  body.appendChild(modalFooter([['Cancel', '', closeModal], ['Save preset', 'primary', () => {
    const errBox = $('#p-err', body);
    const name = $('#p-name', body).value.trim();
    if (!name) { showErr(errBox, 'Preset name is required.'); return; }
    const weights = {};
    for (const c of CATEGORIES) {
      const raw = $('[data-w="' + c.key + '"]', body).value.trim();
      if (!/^\d+$/.test(raw)) { showErr(errBox, 'Weights must be whole numbers (0–100).'); return; }
      weights[c.key] = parseInt(raw, 10);
    }
    const sum = Object.values(weights).reduce((s, x) => s + x, 0);
    if (sum !== 100) { showErr(errBox, 'Weights must sum to 100 (currently ' + sum + ').'); return; }
    if (isNew) {
      const np = { id: p.id, name, weights };
      settings.weight_presets.push(np);
      settings.active_preset_id = np.id;
    } else {
      p.name = name; p.weights = weights;
    }
    save(); closeModal(); renderAll();
    toast('Preset saved');
  }]]));
  openModal(isNew ? 'New weight preset' : 'Edit weight preset', body);
}

/* ============================== share / export / import ============================== */

// Snapshot payload: apartments plus the settings a friend needs to make sense
// of the ranking (work info, car count, presets, active preset).
function buildSnapshot() {
  return JSON.stringify({
    v: 1,
    exported_at: new Date().toISOString(),
    settings: {
      work_addresses: settings.work_addresses,
      primary_work_address: settings.primary_work_address,
      num_cars: settings.num_cars,
      weight_presets: settings.weight_presets,
      active_preset_id: settings.active_preset_id,
    },
    apartments,
  });
}

// Encode for the URL hash. LZ-String when the CDN loaded, otherwise a plain
// 'u:'-prefixed encoded payload so the decoder can tell them apart.
function encodeSnapshot(json) {
  if (window.LZString && LZString.compressToEncodedURIComponent) {
    return LZString.compressToEncodedURIComponent(json);
  }
  return 'u:' + encodeURIComponent(json);
}

function decodeSnapshot(s) {
  let json = null;
  try {
    if (s.startsWith('u:')) {
      json = decodeURIComponent(s.slice(2));
    } else if (window.LZString && LZString.decompressFromEncodedURIComponent) {
      json = LZString.decompressFromEncodedURIComponent(s);
    } else {
      json = decodeURIComponent(s);
    }
    return json ? JSON.parse(json) : null;
  } catch (e) { return null; }
}

function copyText(text, okMsg) {
  const done = () => toast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); }
  catch (e) { toast('Copy failed — select the link manually'); }
  ta.remove();
}

function copyShareLink() {
  if (!Object.keys(apartments).length) { toast('Add an apartment before sharing'); return; }
  const base = location.href.split('#')[0];
  const link = base + '#s=' + encodeSnapshot(buildSnapshot());
  copyText(link,
    'Share link copied — it carries a snapshot copy of your current shortlist');
}

// On load with #s= present: offer to load the snapshot (confirm overwrite).
function checkShareHash() {
  const h = location.hash;
  if (!h || h.indexOf('#s=') !== 0) return;
  const payload = h.slice(3);
  const banner = $('#share-banner');
  banner.hidden = false;
  $('#share-dismiss').onclick = () => { banner.hidden = true; };
  $('#share-load').onclick = () => {
    const snap = decodeSnapshot(payload);
    if (!snap || typeof snap.apartments !== 'object') {
      toast('Could not read that snapshot link');
      return;
    }
    const n = Object.keys(snap.apartments).length;
    if (!confirm('Load the shared snapshot? This replaces your current Housing Ranker data (' +
        n + ' apartment' + (n === 1 ? '' : 's') + ' in the snapshot).')) return;
    if (snap.settings && typeof snap.settings === 'object') {
      const s = snap.settings;
      settings.work_addresses = Array.isArray(s.work_addresses) ? s.work_addresses : [];
      settings.primary_work_address = Number.isInteger(s.primary_work_address) ? s.primary_work_address : 0;
      settings.num_cars = num(s.num_cars);
      if (Array.isArray(s.weight_presets) && s.weight_presets.length) {
        settings.weight_presets = s.weight_presets;
        settings.active_preset_id = s.active_preset_id || s.weight_presets[0].id;
      }
      settings.onboarded = true; // a snapshot implies a configured app
    }
    apartments = snap.apartments;
    save();
    banner.hidden = true;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
    renderAll();
    toast('Snapshot loaded');
  };
}

function exportJSON() {
  const blob = new Blob([buildSnapshot()], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = 'housing-ranker-export-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('Export downloaded');
}

function importJSONFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast('Import failed: not valid JSON'); return; }
    if (!data || typeof data.apartments !== 'object' || typeof data.settings !== 'object') {
      toast('Import failed: unrecognized file format');
      return;
    }
    if (!confirm('Import this file? It will overwrite your current Housing Ranker data.')) return;
    const s = data.settings;
    settings.work_addresses = Array.isArray(s.work_addresses) ? s.work_addresses : [];
    settings.primary_work_address = Number.isInteger(s.primary_work_address) ? s.primary_work_address : 0;
    settings.num_cars = num(s.num_cars);
    if (Array.isArray(s.weight_presets) && s.weight_presets.length) {
      settings.weight_presets = s.weight_presets;
      settings.active_preset_id = s.active_preset_id || s.weight_presets[0].id;
    }
    settings.onboarded = true;
    apartments = data.apartments;
    save(); renderAll();
    toast('Import complete');
  };
  reader.readAsText(file);
}

/* ============================== header wiring & boot ============================== */

function wireHeader() {
  $('#btn-add-apt').innerHTML = icon('plus') + ' Add apartment';
  $('#btn-share').innerHTML = icon('share') + ' Share link';
  $('#btn-export').innerHTML = icon('download') + ' Export';
  $('#btn-import').innerHTML = icon('upload') + ' Import';
  $('#btn-add-apt').onclick = () => openApartmentForm();
  $('#btn-share').onclick = copyShareLink;
  $('#btn-export').onclick = exportJSON;
  $('#btn-import').onclick = () => $('#import-file').click();
  $('#btn-add-apt-2').onclick = () => openApartmentForm();
  $('#btn-manage-presets').onclick = () => setTab('settings');
  $('#preset-select').onchange = e => {
    settings.active_preset_id = e.target.value;
    save(); renderAll();
  };
  $('#sort-score').onclick = () => { sortMode = 'score'; renderRankings(); };
  $('#sort-cost').onclick = () => { sortMode = 'cost'; renderRankings(); };
  $$('.tab-btn').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
  $('#import-file').addEventListener('change', e => {
    if (e.target.files && e.target.files[0]) importJSONFile(e.target.files[0]);
    e.target.value = '';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  wireHeader();
  renderAll();
  checkShareHash();
  if (!settings.onboarded && !location.hash.startsWith('#s=')) {
    openOnboarding();
  }
});
