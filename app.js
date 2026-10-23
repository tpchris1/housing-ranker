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

// Shown wherever an address is entered (onboarding + settings).
const PRIVACY_NOTE = 'Privacy: your address is never sent to or stored on a server. It stays in this browser, on this device. Only the coordinates are kept, so the app can score commutes — the address text itself is not saved. Geocoding sends what you type to OpenStreetMap once to find the coordinates. If you create a share link, the coordinates travel with it — only when you choose to share.';

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
let seedChat = []; // free-AI seed conversation (session only, never persisted)

function freshSettings() {
  return {
    work_addresses: [
      { name: 'Office', lat: null, lng: null },
      { name: 'Home', lat: null, lng: null },
    ],
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
  normalizeSettings();
}

// Locations hygiene: raw address text is never kept (only label + coords),
// the Office and Home slots always exist, and the primary index stays in range.
function normalizeSettings() {
  if (!settings) return;
  if (!Array.isArray(settings.work_addresses)) settings.work_addresses = [];
  settings.work_addresses.forEach(w => { if (w && typeof w === 'object') delete w.addr; });
  if (!settings.work_addresses.some(w => w && w.name === 'Office')) {
    settings.work_addresses.push({ name: 'Office', lat: null, lng: null });
  }
  if (!settings.work_addresses.some(w => w && w.name === 'Home')) {
    settings.work_addresses.push({ name: 'Home', lat: null, lng: null });
  }
  const last = settings.work_addresses.length - 1;
  const p = parseInt(settings.primary_work_address, 10);
  settings.primary_work_address = Number.isFinite(p) ? Math.min(Math.max(p, 0), last) : 0;
}

function save() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(APARTMENTS_KEY, JSON.stringify(apartments));
}

const activePreset = () =>
  settings.weight_presets.find(p => p.id === settings.active_preset_id) || settings.weight_presets[0];

const hasCoords = w => !!w && Number.isFinite(parseFloat(w.lat)) && Number.isFinite(parseFloat(w.lng));

// The primary location if it has coordinates, else the first location that
// does (e.g. Office unset but Home set), else null.
const primaryWork = () => {
  const w = settings.work_addresses[settings.primary_work_address];
  if (hasCoords(w)) return w;
  return settings.work_addresses.find(hasCoords) || null;
};

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
      '<button class="btn primary" id="empty-add">Add apartment</button> ' +
      '<button class="btn" id="empty-seed">Seed apartments</button></div>';
    $('#empty-add').onclick = () => openApartmentForm();
    $('#empty-seed').onclick = () => openSeedModal();
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
    (i === settings.primary_work_address ? ' checked' : '') + ' title="Set as primary location" aria-label="Set ' + esc(w.name) + ' as primary location">' +
    '<b>' + esc(w.name) + '</b><span class="hint">' + (w.lat == null || w.lng == null ? 'not set yet' : esc(String(w.lat)) + ', ' + esc(String(w.lng))) + '</span>' +
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
    '<div class="set-section"><h3>Your locations</h3>' + (wAddrs || '<p class="hint">None yet.</p>') +
    '<div class="row-flex" style="margin-top:10px"><button class="btn small" id="set-add-addr">Add work address</button></div>' +
    '<p class="hint">' + PRIVACY_NOTE + '</p></div>' +
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
      if (settings.work_addresses.length <= 1) { toast('Keep at least one location'); return; }
      if (!confirm('Remove this location?')) return;
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
// Builds one location row: name, address text (auto-geocoded, never saved),
// lat/lng, status, remove.
function workAddressRow(w, canRemove, onRemove) {
  w = w || { name: '', lat: null, lng: null };
  const latVal = w.lat == null ? '' : String(w.lat);
  const lngVal = w.lng == null ? '' : String(w.lng);
  const div = document.createElement('div');
  div.className = 'ob-addr';
  div.innerHTML =
    '<div class="fld-row">' +
    '<label class="fld"><span>Name</span><input type="text" data-wa="name" value="' + esc(w.name) + '" placeholder="e.g. Office"></label>' +
    '<label class="fld"><span>Address (for geocoding)</span><input type="text" data-wa="addr" value="" placeholder="1 Infinite Loop, Cupertino CA"></label>' +
    '</div>' +
    '<div class="geo-row">' +
    '<label class="fld"><span>Latitude</span><input type="number" step="any" data-wa="lat" value="' + esc(latVal) + '" placeholder="37.33"></label>' +
    '<label class="fld"><span>Longitude</span><input type="number" step="any" data-wa="lng" value="' + esc(lngVal) + '" placeholder="-122.01"></label>' +
    (canRemove ? '<button type="button" class="btn small danger" data-wa="rm">Remove</button>' : '') +
    '</div><div class="geo-status" data-wa="status"></div>';
  const status = $('[data-wa="status"]', div);
  const addrInput = $('[data-wa="addr"]', div);
  if (latVal !== '' && lngVal !== '') {
    status.textContent = 'Coordinates saved: ' + latVal + ', ' + lngVal + ' — type an address to change them.';
  }
  // Auto-geocode: debounce 900ms while typing, plus on blur if the current
  // text has not been looked up yet. The address text is used for the lookup
  // only; it is never stored (see readWorkAddressRow / normalizeSettings).
  let geoTimer = null;
  const runGeocode = async () => {
    const q = addrInput.value.trim();
    if (!q || div.dataset.geoQuery === q) return;
    div.dataset.geoQuery = q;
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
  };
  addrInput.addEventListener('input', () => {
    clearTimeout(geoTimer);
    geoTimer = setTimeout(runGeocode, 900);
  });
  addrInput.addEventListener('blur', () => {
    clearTimeout(geoTimer);
    runGeocode();
  });
  if (canRemove) $('[data-wa="rm"]', div).onclick = () => { div.remove(); onRemove && onRemove(); };
  return div;
}

function readWorkAddressRow(div) {
  const name = $('[data-wa="name"]', div).value.trim();
  if (!name) return { error: 'Each work address needs a name.' };
  const latRaw = $('[data-wa="lat"]', div).value.trim();
  const lngRaw = $('[data-wa="lng"]', div).value.trim();
  if (latRaw === '' && lngRaw === '') return { value: { name, lat: null, lng: null } };
  const lat = parseFloat(latRaw);
  const lng = parseFloat(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: 'Address "' + name + '" needs both latitude and longitude (type the address and let it look them up, or enter both).' };
  }
  return { value: { name, lat, lng } };
}

/* ---------- onboarding ---------- */

function openOnboarding() {
  const body = document.createElement('div');
  body.innerHTML =
    '<div class="ob-step"><h3>1. Your locations</h3><p class="hint">Commute estimates are measured to your primary location. Fill in either or both — you can change them later.</p>' +
    '<div id="ob-addrs"></div><button type="button" class="btn small" id="ob-add-addr">Add another location</button>' +
    '<p class="hint">' + PRIVACY_NOTE + '</p></div>' +
    '<div class="ob-step"><h3>2. How many cars?</h3>' +
    '<label class="fld" style="max-width:160px"><span>Number of cars</span><input type="number" id="ob-cars" min="0" step="1" value="1"></label></div>' +
    '<div class="ob-step"><h3>3. What matters most?</h3><p class="hint">Pick a starting weight preset — you can tweak or add presets later.</p>' +
    '<div class="radio-cards" id="ob-presets"></div></div>' +
    '<div class="err" id="ob-err"></div>';

  const addrsBox = $('#ob-addrs', body);
  const addRow = w => addrsBox.appendChild(workAddressRow(w, addrsBox.children.length > 0));
  addRow({ name: 'Office', lat: null, lng: null });
  addRow({ name: 'Home', lat: null, lng: null });
  $('#ob-add-addr', body).onclick = () => addRow({ name: '' });

  $('#ob-presets', body).innerHTML = STARTER_PRESETS.map((p, i) => {
    const ws = CATEGORIES.map(c => c.label + ' ' + p.weights[c.key]).join(' · ');
    return '<label class="radio-card"><input type="radio" name="ob-preset" value="' + esc(p.id) + '"' + (i === 0 ? ' checked' : '') + '>' +
      '<span class="rn">' + esc(p.name) + '</span><span class="rw">' + esc(ws) + '</span></label>';
  }).join('');

  body.appendChild(modalFooter([['Start ranking', 'primary', () => {
    const errBox = $('#ob-err', body);
    const rows = $$('#ob-addrs .ob-addr', body);
    if (!rows.length) { showErr(errBox, 'Add at least one location.'); return; }
    const addrs = [];
    for (const r of rows) {
      const res = readWorkAddressRow(r);
      if (res.error) { showErr(errBox, res.error); return; }
      addrs.push(res.value);
    }
    const firstGeo = addrs.findIndex(a => a.lat != null && a.lng != null);
    if (firstGeo < 0) { showErr(errBox, 'Give at least one location an address so we can look up its coordinates.'); return; }
    const cars = Math.max(0, parseInt($('#ob-cars', body).value, 10) || 0);
    const picked = ($('input[name="ob-preset"]:checked', body) || {}).value || 'balanced';
    settings.work_addresses = addrs;
    settings.primary_work_address = firstGeo;
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
    toast('Location added');
  }]]));
  openModal('Add location', body);
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

  // The apartment address auto-geocodes into lat/lng: debounce 900ms while
  // typing, plus on blur if the current text has not been looked up yet.
  const fAddr = $('#f-address', body);
  const fStatus = $('#f-geo-status', body);
  let fGeoTimer = null;
  let fGeoQuery = '';
  const runAptGeocode = async () => {
    const q = fAddr.value.trim();
    if (!q || fGeoQuery === q) return;
    fGeoQuery = q;
    fStatus.className = 'geo-status';
    fStatus.textContent = 'Looking up…';
    try {
      const g = await geocode(q);
      if (!g) fStatus.textContent = 'No results found — check the address or enter coordinates manually.';
      else {
        $('#f-lat', body).value = g.lat.toFixed(6);
        $('#f-lng', body).value = g.lng.toFixed(6);
        fStatus.className = 'geo-status ok';
        fStatus.textContent = 'Found: ' + g.display.slice(0, 90);
      }
    } catch (err) { fStatus.textContent = 'Geocoding failed (' + err.message + '). Enter coordinates manually.'; }
  };
  fAddr.addEventListener('input', () => {
    clearTimeout(fGeoTimer);
    fGeoTimer = setTimeout(runAptGeocode, 900);
  });
  fAddr.addEventListener('blur', () => {
    clearTimeout(fGeoTimer);
    runAptGeocode();
  });

  // Commute estimate from distance; manual edits clear the flag.
  const estTag = $('#f-est-tag', body);
  $('#f-est-commute', body).onclick = () => {
    const lat = parseFloat($('#f-lat', body).value), lng = parseFloat($('#f-lng', body).value);
    const work = primaryWork();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast('Need apartment coordinates first'); return; }
    if (!work) { toast('Set a location in Settings first'); return; }
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

/* ============================== seeding apartments ============================== */

// Pull an apartment array out of arbitrary text: a ```json fenced block, a
// bare [ ... ] array, or a lone { ... } object (wrapped into an array).
// Returns the raw item array, or null when nothing parses.
function extractSeedJSON(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    s = fence[1];
  } else {
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
      s = s.slice(a, b + 1);
    } else {
      const c = s.indexOf('{'), d = s.lastIndexOf('}');
      if (c >= 0 && d > c) s = s.slice(c, d + 1);
      else return null;
    }
  }
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return null;
  } catch (e) { return null; }
}

// Import seed results (from either the free AI chat or the Muse loop).
// Records get the same field set as the apartment form, blank 1–10 ratings,
// a notes line stamping the source, and an estimated commute when possible.
// Names that already exist are skipped, never overwritten.
function importSeedApartments(items, sourceLabel) {
  let added = 0, skipped = 0;
  const work = primaryWork();
  const stamp = sourceLabel + ' — added ' + new Date().toISOString().slice(0, 10);
  (items || []).forEach(item => {
    if (!item || typeof item !== 'object') { skipped++; return; }
    const name = String(item.name || '').trim();
    if (!name || apartments[name]) { skipped++; return; }
    const lat = parseFloat(item.latitude);
    const lng = parseFloat(item.longitude);
    let commute_minutes = '', commute_estimated = false;
    if (Number.isFinite(lat) && Number.isFinite(lng) && work) {
      commute_minutes = estimateCommuteMinutes(lat, lng, work);
      commute_estimated = true;
    }
    const plans = (Array.isArray(item.floor_plans) && item.floor_plans.length)
      ? item.floor_plans.map(p => {
          p = (p && typeof p === 'object') ? p : {};
          return {
            name: String(p.name || ''),
            price: p.price ?? '',
            sqft: p.sqft ?? '',
            hoa: p.hoa ?? '',
            property_tax: p.property_tax ?? '',
          };
        })
      : [{ name: '', price: '', sqft: '', hoa: '', property_tax: '' }];
    const ownNotes = String(item.notes || '').trim();
    apartments[name] = {
      address: String(item.address || ''),
      website: String(item.website || ''),
      year_built: item.year_built ?? '',
      walk_score: item.walk_score ?? '',
      latitude: item.latitude ?? '',
      longitude: item.longitude ?? '',
      commute_minutes,
      commute_estimated,
      google_review: item.google_review ?? '',
      notes: ownNotes ? ownNotes + '\n' + stamp : stamp,
      neighborhood_vibe: '',
      condition_score: '',
      appliances_score: '',
      gut_feeling: '',
      parking_spots_included: '',
      parking_cost_extra: '',
      parking_type: '',
      washer_dryer: '',
      dishwasher: '',
      stove_type: '',
      fridge: '',
      closet_style: '',
      floor_type: '',
      ac_type: '',
      floor_plans: plans,
      created_at: new Date().toISOString(),
    };
    added++;
  });
  if (added || skipped) { save(); renderAll(); }
  if (!added && !skipped) {
    toast('Nothing importable found in those results.');
  } else {
    toast('Added ' + added + ' apartment' + (added === 1 ? '' : 's') +
      (skipped ? ' (' + skipped + ' duplicates skipped)' : '') +
      '. Add your 1–10 ratings to rank them properly.');
  }
  return { added, skipped };
}

// The prompt the user pastes into their own Muse (panel B).
function buildSeedPrompt(anchor, o) {
  let p = 'I am building a shortlist of rental apartments in my Housing Ranker app. Research REAL apartment properties for me.\n' +
    'Anchor: my ' + anchor.name + ', at latitude ' + anchor.lat + ', longitude ' + anchor.lng +
    '. Find up to ' + o.count + ' rental apartment properties within about ' + o.radius + ' miles of that point.';
  if (o.maxRent) p += '\nMax rent: $' + Number(o.maxRent).toLocaleString('en-US') + ' per month or less.';
  if (o.bedrooms) {
    const beds = { '1': '1 bedroom', '2': '2 bedrooms', '3+': '3+ bedrooms' }[o.bedrooms] || o.bedrooms;
    p += '\nBedrooms: ' + beds + '.';
  }
  if (o.mustHaves) p += '\nMust-haves: ' + o.mustHaves + '.';
  p += '\nUse web search to verify each property actually exists and currently rents units. For rents, use the lowest listed asking rent you can find for each floor-plan type; if you cannot find a listed rent, use null — never invent numbers. Give coordinates as accurately as you can. Include walk_score, year_built and google_review only when you find them, otherwise null.' +
    '\nReply with ONLY a ```json code block containing an array of objects with exactly these keys: name, address, website, latitude, longitude, walk_score, year_built, google_review, notes, floor_plans. notes is one short line naming your source (e.g. the listing site). floor_plans is an array of {name, price, sqft} — name like "1 bed / 1 bath", price the monthly rent (number or null), sqft a number or null. No text outside the code block.';
  return p;
}

function openSeedModal() {
  const body = document.createElement('div');
  const anchor = primaryWork();
  if (!anchor) {
    body.innerHTML = '<p class="hint">Set a location with coordinates first — Settings → Your locations.</p>';
    openModal('Seed apartments', body, true);
    return;
  }

  const anchorOptions = settings.work_addresses
    .map((w, i) => ({ w, i }))
    .filter(x => hasCoords(x.w))
    .map(x => '<option value="' + x.i + '"' + (x.w === anchor ? ' selected' : '') + '>' + esc(x.w.name) + '</option>')
    .join('');

  body.innerHTML =
    '<div class="radio-cards" id="seed-modes">' +
    '<label class="radio-card"><input type="radio" name="seed-mode" value="ai">' +
    '<span class="rn">Free AI chat</span><span class="rw">Chat right here, no account needed. Fast, but details may be invented — verify before trusting.</span></label>' +
    '<label class="radio-card"><input type="radio" name="seed-mode" value="claude" checked>' +
    '<span class="rn">Use my Muse</span><span class="rw">Your Muse researches real listings on the web. Most accurate.</span></label>' +
    '</div>' +

    '<div class="seed-panel" id="seed-panel-ai" hidden>' +
    '<div class="seed-msgs" id="seed-msgs"></div>' +
    '<div class="err" id="seed-ai-err"></div>' +
    '<div class="chat-row"><input type="text" id="seed-input" placeholder="e.g. 2 bed under $2,800, in-unit laundry…">' +
    '<button type="button" class="btn primary" id="seed-send">Send</button></div>' +
    '</div>' +

    '<div class="seed-panel" id="seed-panel-claude">' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Anchor location</span><select id="seed-anchor">' + anchorOptions + '</select></label>' +
    '<label class="fld"><span>Radius (miles)</span><input type="number" id="seed-radius" min="1" step="1" value="3"></label>' +
    '<label class="fld"><span>How many</span><input type="number" id="seed-count" min="1" max="20" step="1" value="6"></label>' +
    '</div>' +
    '<div class="fld-row">' +
    '<label class="fld"><span>Max rent $/mo (optional)</span><input type="number" id="seed-maxrent" min="0" step="50" placeholder="No limit"></label>' +
    '<label class="fld"><span>Bedrooms</span><select id="seed-beds"><option value="">Any</option><option value="1">1</option><option value="2">2</option><option value="3+">3+</option></select></label>' +
    '<label class="fld"><span>Must-haves (optional)</span><input type="text" id="seed-must" placeholder="e.g. in-unit laundry, parking"></label>' +
    '</div>' +
    '<label class="fld"><span>Your prompt — copy this into Muse</span>' +
    '<textarea class="copy-box" id="seed-prompt" readonly></textarea></label>' +
    '<div class="row-flex">' +
    '<button type="button" class="btn" id="seed-copy">Copy prompt</button>' +
    '<a class="btn primary" href="https://muse.ai" target="_blank" rel="noopener">Open my Muse</a>' +
    '</div>' +
    '<p class="hint">1. Copy the prompt. 2. Open your Muse and paste it. 3. Paste Muse\'s answer back below.</p>' +
    '<label class="fld"><span>Paste Muse\'s answer here</span>' +
    '<textarea id="seed-paste" placeholder="Paste the full answer, including the json code block…"></textarea></label>' +
    '<div class="err" id="seed-paste-err"></div>' +
    '<div class="row-flex"><button type="button" class="btn primary" id="seed-import">Import apartments</button></div>' +
    '</div>';

  openModal('Seed apartments', body, true);

  /* ----- chooser ----- */
  const panelAi = $('#seed-panel-ai', body);
  const panelClaude = $('#seed-panel-claude', body);
  const syncPanels = () => {
    const mode = ($('input[name="seed-mode"]:checked', body) || {}).value || 'claude';
    panelAi.hidden = mode !== 'ai';
    panelClaude.hidden = mode !== 'claude';
  };
  $$('input[name="seed-mode"]', body).forEach(r => { r.onchange = syncPanels; });
  syncPanels();

  /* ----- panel A: free AI chat (Pollinations, keyless) ----- */
  seedChat = [
    { role: 'system', content:
      'You help build a rental shortlist for Housing Ranker. The user\'s anchor location is "' + anchor.name +
      '" at latitude ' + anchor.lat + ', longitude ' + anchor.lng +
      '. Suggest real, well-known apartment complexes near that point matching the user\'s criteria. ' +
      'End EVERY reply that suggests apartments with a single ```json code block containing an array of objects with keys: ' +
      'name, address, website, latitude, longitude, walk_score, year_built, google_review, notes, floor_plans ' +
      '(array of {name, price, sqft}). Use null for anything you do not know — never invent rents; use typical listed rents ' +
      'only when you are fairly confident. price is monthly USD rent, sqft a number.' },
    { role: 'assistant', content: 'Tell me what you\'re looking for — bedrooms, budget, must-haves — and I\'ll suggest apartments near ' + anchor.name + '.' },
  ];
  const msgsBox = $('#seed-msgs', body);
  const appendMsg = (role, text) => {
    const d = document.createElement('div');
    d.className = 'seed-msg ' + role;
    d.textContent = text;
    msgsBox.appendChild(d);
    msgsBox.scrollTop = msgsBox.scrollHeight;
    return d;
  };
  appendMsg('assistant', seedChat[1].content);

  const aiErr = $('#seed-ai-err', body);
  const aiInput = $('#seed-input', body);
  const aiSend = $('#seed-send', body);
  const sendSeedChat = async () => {
    const text = aiInput.value.trim();
    if (!text || aiSend.disabled) return;
    showErr(aiErr, '');
    aiInput.value = '';
    seedChat.push({ role: 'user', content: text });
    appendMsg('user', text);
    aiSend.disabled = true;
    aiInput.disabled = true;
    const thinking = appendMsg('assistant', 'Thinking…');
    try {
      const res = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: seedChat }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const content = (data && data.choices && data.choices[0] && data.choices[0].message)
        ? String(data.choices[0].message.content || '') : '';
      if (!content) throw new Error('empty reply');
      thinking.remove();
      seedChat.push({ role: 'assistant', content });
      appendMsg('assistant', content);
      const items = (extractSeedJSON(content) || [])
        .filter(it => it && typeof it === 'object' && String(it.name || '').trim());
      if (items.length) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small primary';
        b.textContent = 'Add ' + items.length + ' apartment' + (items.length === 1 ? '' : 's') + ' from this reply';
        b.onclick = () => {
          const r = importSeedApartments(items, 'Seeded via free AI chat — UNVERIFIED, verify all details');
          if (r.added > 0) closeModal();
        };
        msgsBox.appendChild(b);
        msgsBox.scrollTop = msgsBox.scrollHeight;
      }
    } catch (e) {
      thinking.remove();
      seedChat.pop(); // drop the unanswered user turn so a retry stays clean
      aiInput.value = text;
      showErr(aiErr, 'The free AI is unavailable right now — try again, or use the Muse option.');
    }
    aiSend.disabled = false;
    aiInput.disabled = false;
    aiInput.focus();
  };
  aiSend.onclick = sendSeedChat;
  aiInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendSeedChat(); }
  });

  /* ----- panel B: Muse loop ----- */
  const promptBox = $('#seed-prompt', body);
  const readCriteria = () => {
    const idx = parseInt($('#seed-anchor', body).value, 10);
    return {
      anchor: settings.work_addresses[idx] || anchor,
      radius: parseFloat($('#seed-radius', body).value) || 3,
      count: Math.max(1, parseInt($('#seed-count', body).value, 10) || 6),
      maxRent: $('#seed-maxrent', body).value.trim(),
      bedrooms: $('#seed-beds', body).value,
      mustHaves: $('#seed-must', body).value.trim(),
    };
  };
  const regenPrompt = () => {
    const c = readCriteria();
    promptBox.value = buildSeedPrompt(c.anchor, c);
  };
  ['seed-anchor', 'seed-radius', 'seed-count', 'seed-maxrent', 'seed-beds', 'seed-must'].forEach(id => {
    const el = $('#' + id, body);
    el.addEventListener('input', regenPrompt);
    el.addEventListener('change', regenPrompt);
  });
  regenPrompt();
  $('#seed-copy', body).onclick = () => copyText(promptBox.value, 'Prompt copied — paste it into your Muse');
  $('#seed-import', body).onclick = () => {
    const errBox = $('#seed-paste-err', body);
    const items = extractSeedJSON($('#seed-paste', body).value);
    if (!items) {
      showErr(errBox, 'No apartment data found in that paste — make sure you copied Muse\'s full answer including the code block.');
      return;
    }
    showErr(errBox, '');
    const r = importSeedApartments(items, 'Seeded via Muse');
    if (r.added > 0) closeModal();
  };
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
      normalizeSettings();
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
    normalizeSettings();
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
  $('#btn-seed-apt').onclick = () => openSeedModal();
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
