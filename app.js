'use strict';
/* Senderos BTT — ver senderos con su nombre y dificultad y llegar hasta ellos con el Karoo o el móvil */

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RAD = Math.PI / 180;
function dist(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}
const lineLen = g => g.reduce((s, p, i) => i ? s + dist(g[i - 1], p) : 0, 0);
const fmtKm = m => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toLocaleString('es-ES', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let toastT;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function status(msg, busy = false) {
  const s = $('#status'); s.textContent = msg || ''; s.classList.toggle('show', !!msg); s.classList.toggle('busy', busy);
}

// ---------- almacenamiento: mapas y senderos guardados para ir sin cobertura ----------
let db;
const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open('senderosbtt', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(db = r.result);
  r.onerror = () => rej(r.error);
});
const tx = (mode, fn) => new Promise((res, rej) => {
  const t = db.transaction('kv', mode), s = t.objectStore('kv'); let out; const r = fn(s);
  if (r) r.onsuccess = () => { out = r.result; };
  t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error);
});
const kvGet = k => db ? tx('readonly', s => s.get(k)).catch(() => null) : Promise.resolve(null);
const kvPut = (k, v) => db ? tx('readwrite', s => s.put(v, k)).catch(() => {}) : Promise.resolve();
const kvHas = k => db ? tx('readonly', s => s.count(k)).catch(() => 0) : Promise.resolve(0);
const kvClear = () => tx('readwrite', s => s.clear());

const settings = Object.assign({ layer: 'mtn', view: null }, JSON.parse(localStorage.getItem('senderos.settings') || '{}'));
const saveSettings = () => localStorage.setItem('senderos.settings', JSON.stringify(settings));

// ---------- mapa ----------
const IGN = (svc, layer) => `https://www.ign.es/wmts/${svc}?layer=${layer}&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix={z}&TileCol={x}&TileRow={y}`;
const A_IGN = '© <a href="https://www.ign.es">IGN</a>', A_OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const LAYERS = {
  mtn: { name: 'IGN Topográfico', url: IGN('mapa-raster', 'MTN'), max: 17, bulk: true, attr: A_IGN + ' · senderos ' + A_OSM },
  base: { name: 'IGN Mapa base', url: IGN('ign-base', 'IGNBaseTodo'), max: 18, bulk: true, attr: A_IGN + ' · senderos ' + A_OSM },
  pnoa: { name: 'Ortofoto (satélite)', url: IGN('pnoa-ma', 'OI.OrthoimageCoverage'), max: 19, bulk: true, attr: A_IGN + ' · senderos ' + A_OSM },
  topo: { name: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, attr: A_OSM + ' · OpenTopoMap' },
  cyclosm: { name: 'CyclOSM (bici)', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', max: 18, attr: A_OSM + ' · CyclOSM' },
};
// Primero busca la tesela guardada; si no, la baja y la guarda
const CachedLayer = L.TileLayer.extend({
  createTile(c, done) {
    const img = document.createElement('img'); img.alt = '';
    const url = this.getTileUrl(c), key = 'tile/' + this.options.key + '/' + c.z + '/' + c.x + '/' + c.y;
    img.onload = () => { if (img._u) { URL.revokeObjectURL(img._u); img._u = null; } done(null, img); };
    img.onerror = e => done(e, img);
    const show = b => { img._u = URL.createObjectURL(b); img.src = img._u; };
    kvGet(key).then(b => b ? show(b) : fetch(url, { mode: 'cors' }).then(r => { if (!r.ok) throw 0; return r.blob(); })
      .then(b => { if (b.size) kvPut(key, b); show(b); })).catch(() => { img.src = url; });
    return img;
  }
});
const map = L.map('map', { zoomControl: false, maxZoom: 19, tap: false });
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
let baseLayer;
function setLayer(k) {
  if (!LAYERS[k]) k = 'mtn';
  if (baseLayer) map.removeLayer(baseLayer);
  const d = LAYERS[k];
  baseLayer = new CachedLayer(d.url, { key: k, maxNativeZoom: d.max, maxZoom: 19, subdomains: 'abc', attribution: d.attr, crossOrigin: true }).addTo(map);
  baseLayer.bringToBack();
  settings.layer = k; saveSettings();
}
map.on('moveend', debounce(() => { settings.view = { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }; saveSettings(); }, 500));

// ---------- senderos de OpenStreetMap ----------
// Se piden a Overpass por celdas de 0,05° (unos 5 km) y se guardan 30 días
const CELL = 0.05, MINZ = 13, DAYS = 30;
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const LEVELS = [
  { c: '#27a844', t: 'S0 · Fácil' }, { c: '#1e6fd9', t: 'S1 · Intermedio' }, { c: '#111111', t: 'S2 · Difícil' },
  { c: '#111111', t: 'S3 · Muy difícil', d: '9 4' }, { c: '#d0021b', t: 'S4 · Extremo' }, { c: '#d0021b', t: 'S5 · Extremo', d: '9 4' }];
const SURF = { ground: 'tierra', dirt: 'tierra', earth: 'tierra', gravel: 'grava', fine_gravel: 'grava fina', rock: 'roca', stone: 'piedra', grass: 'hierba', sand: 'arena', asphalt: 'asfalto', paved: 'asfaltado', compacted: 'compactada', unpaved: 'sin asfaltar', pebblestone: 'piedras', roots: 'raíces', concrete: 'hormigón', mud: 'barro' };
map.createPane('trails').style.zIndex = 350;
const touch = matchMedia('(pointer: coarse)').matches;
const trailRend = L.canvas({ pane: 'trails', tolerance: touch ? 14 : 7, padding: 0.3 });
const L_trails = L.layerGroup().addTo(map), L_sel = L.layerGroup().addTo(map);
const cells = new Map();
let loading = false;
const cellKey = (lat, lng) => Math.floor(lat / CELL) + '_' + Math.floor(lng / CELL);
function cellsIn(b, ring = 0) {
  const out = [];
  const i0 = Math.floor(b.getSouth() / CELL) - ring, i1 = Math.floor(b.getNorth() / CELL) + ring;
  const j0 = Math.floor(b.getWest() / CELL) - ring, j1 = Math.floor(b.getEast() / CELL) + ring;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push([i, j, i + '_' + j]);
  return out;
}
function loadedWays() {
  const seen = new Set(), out = [];
  for (const list of cells.values()) for (const w of list) if (!seen.has(w.id)) { seen.add(w.id); out.push(w); }
  return out;
}
function trailStyle(w) {
  const s = parseInt(w.s);
  if (s >= 0) { const l = LEVELS[Math.min(s, 5)]; return { color: l.c, weight: 4, opacity: 0.9, dashArray: l.d || null }; }
  if (w.h === 'track') return { color: '#9a6b3c', weight: 3, opacity: 0.85, dashArray: '7 5' };
  return { color: '#e8590c', weight: 3, opacity: 0.9, dashArray: '2 6' };
}
const wayName = w => w.n || w.ref || (w.r && w.r[0]) || '';
function drawTrails() {
  L_trails.clearLayers();
  if (map.getZoom() < MINZ) return;
  const seen = new Set();
  for (const [, , k] of cellsIn(map.getBounds(), 1)) for (const w of cells.get(k) || []) {
    if (seen.has(w.id)) continue; seen.add(w.id);
    L.polyline(w.g, { ...trailStyle(w), renderer: trailRend, bubblingMouseEvents: false }).on('click', e => selectTrail(w, e.latlng)).addTo(L_trails);
  }
  // Nombres escritos: uno por sendero, en su tramo más largo, sin que se pisen
  if (map.getZoom() < 15) return;
  const b = map.getBounds(), best = new Map();
  for (const [, , k] of cellsIn(b)) for (const w of cells.get(k) || []) {
    if (!w.n) continue;
    const mid = w.g[Math.floor(w.g.length / 2)];
    if (!b.contains(mid)) continue;
    const prev = best.get(w.n);
    if (!prev || w.g.length > prev.len) best.set(w.n, { len: w.g.length, mid, w });
  }
  const boxes = []; let n = 0;
  for (const [name, { mid, w }] of [...best].sort((a, c) => c[1].len - a[1].len)) {
    if (n >= 100) break;
    const p = map.latLngToContainerPoint(mid), bw = name.length * 6.3 + 14, box = [p.x - bw / 2, p.y - 26, p.x + bw / 2, p.y - 6];
    if (boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
    boxes.push(box); n++;
    L.marker(mid, { interactive: false, keyboard: false, pane: 'trails', icon: L.divIcon({ className: 'traillbl', html: `<span style="border-color:${trailStyle(w).color}">${esc(name)}</span>`, iconSize: null }) }).addTo(L_trails);
  }
}
async function fetchOverpass(q) {
  for (let round = 0; round < 2; round++) {
    if (round) await wait(6000);
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(70000) });
        if (r.ok) return await r.json();
      } catch { }
    }
  }
  throw new Error('Los servidores de senderos están ocupados');
}
// Baja de una vez las celdas que falten (como mucho un rectángulo de 8 × 8 celdas)
async function fetchCells(missing) {
  const s = Math.min(...missing.map(c => c[0])) * CELL, n = (Math.max(...missing.map(c => c[0])) + 1) * CELL;
  const w = Math.min(...missing.map(c => c[1])) * CELL, e = (Math.max(...missing.map(c => c[1])) + 1) * CELL;
  const bb = [s, w, n, e].map(v => v.toFixed(5)).join(',');
  const j = await fetchOverpass(`[out:json][timeout:65];(way["highway"~"^(path|track|bridleway)$"](${bb});way["highway"]["mtb:scale"](${bb});way["highway"]["mtb:name"](${bb}););out tags geom;rel(bw)["route"~"^(mtb|bicycle|hiking|foot)$"];out body;`);
  const byCell = new Map(missing.map(c => [c[2], []]));
  // Los tramos sin nombre propio suelen llevar el de la ruta señalizada (GR, PR, rutas BTT…)
  const inRoutes = new Map();
  for (const el of j.elements) {
    if (el.type !== 'relation') continue;
    const t = el.tags || {}, rn = [t.ref, t.name].filter(Boolean).join(' · ');
    if (rn) for (const m of el.members || []) if (m.type === 'way') { const a = inRoutes.get(m.ref) || []; if (!a.includes(rn) && a.length < 4) a.push(rn); inRoutes.set(m.ref, a); }
  }
  for (const el of j.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const g = el.geometry.map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]), t = el.tags || {};
    const k = g.map(p => cellKey(p[0], p[1])).find(k => byCell.has(k));
    // mtb:name es el nombre que usan los ciclistas; name, el oficial
    const official = t.name || t['name:ca'] || t['name:es'] || '';
    if (k) byCell.get(k).push({ id: el.id, n: t['mtb:name'] || official, n2: t['mtb:name'] && official !== t['mtb:name'] ? official : '', ref: t.ref || '', r: inRoutes.get(el.id) || [], s: t['mtb:scale'] ?? '', h: t.highway, f: t.surface || '', g });
  }
  for (const [k, list] of byCell) { cells.set(k, list); kvPut('trail/' + k, { t: Date.now(), w: list }); }
}
async function loadTrails() {
  if (map.getZoom() < MINZ) { L_trails.clearLayers(); if (!$('#sheet.show')) status('Acércate para ver los senderos'); return; }
  const missing = [];
  for (const c of cellsIn(map.getBounds())) {
    if (cells.has(c[2])) continue;
    const v = await kvGet('trail/' + c[2]);
    if (v && Date.now() - v.t < DAYS * 864e5) cells.set(c[2], v.w); else missing.push(c);
  }
  drawTrails(); status('');
  if (!missing.length || loading || zone) return; // mientras se guarda una zona, ya se están bajando
  if (!navigator.onLine) { status('Sin conexión: aquí no hay senderos guardados'); return; }
  loading = true; status('Cargando senderos de esta zona…', true);
  try { await fetchCells(missing); status(''); }
  catch (e) { status(e.message + '. Mueve el mapa para reintentar'); }
  loading = false;
  drawTrails();
  if (map.getZoom() >= MINZ && cellsIn(map.getBounds()).some(c => !cells.has(c[2]))) loadTrails();
}
map.on('moveend', debounce(loadTrails, 350));

// Un sendero con nombre suele estar partido en varios tramos: se juntan todos los que se tocan
function wholeTrail(w) {
  const name = w.n;
  let g = w.g.slice(); const used = new Set([w.id]);
  if (name) {
    const pool = loadedWays().filter(o => o.n === name && o.id !== w.id);
    const near = (p, q) => dist(p, q) < 5;
    for (let grown = true; grown;) {
      grown = false;
      for (const o of pool) {
        if (used.has(o.id)) continue;
        const a = o.g[0], b = o.g[o.g.length - 1], s = g[0], e = g[g.length - 1];
        if (near(e, a)) g = g.concat(o.g.slice(1));
        else if (near(e, b)) g = g.concat(o.g.slice().reverse().slice(1));
        else if (near(s, b)) g = o.g.slice(0, -1).concat(g);
        else if (near(s, a)) g = o.g.slice().reverse().slice(0, -1).concat(g);
        else continue;
        used.add(o.id); grown = true;
      }
    }
  }
  return { g, parts: used.size };
}
// Nombre del camino del mismo tipo que se une con este (para tramos sin nombre)
function neighbourName(w) {
  const ends = [w.g[0], w.g[w.g.length - 1]];
  for (const o of loadedWays()) {
    if (o.id === w.id || !o.n || o.h !== w.h) continue;
    if ([o.g[0], o.g[o.g.length - 1]].some(p => ends.some(q => dist(p, q) < 3))) return o.n;
  }
  return '';
}

// ---------- mi posición ----------
let me = null, meMk = null, meAcc = null, watchId = null, follow = false;
function startGPS(center) {
  if (!navigator.geolocation) { toast('Este navegador no da la posición'); return; }
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(p => {
      const first = !me;
      me = [p.coords.latitude, p.coords.longitude];
      if (!meMk) {
        meAcc = L.circle(me, { radius: p.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
        meMk = L.marker(me, { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(map);
      } else { meMk.setLatLng(me); meAcc.setLatLng(me).setRadius(p.coords.accuracy); }
      $('#locBtn').classList.add('on');
      if (follow || (first && center)) map.setView(me, Math.max(map.getZoom(), 15), { animate: !first });
      if (sel) updateDistance();
    }, e => {
      toast(e.code === 1 ? 'Sin permiso para usar tu posición. Actívalo en los ajustes del navegador' : 'No se pudo obtener la posición');
      watchId = null; setFollow(false);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  } else if (me && center) map.setView(me, Math.max(map.getZoom(), 15));
}
function setFollow(on) { follow = on; $('#locBtn').classList.toggle('follow', on); }
$('#locBtn').onclick = () => { if (follow) { setFollow(false); return; } setFollow(true); startGPS(true); };
map.on('dragstart', () => setFollow(false));

// ---------- ficha inferior ----------
let sel = null; // { w, g, name, … }
let screen = 'trail'; // qué enseña la ficha: trail, go, karoo o layers
function openSheet(html, keepSel = false) {
  if (!keepSel && !sel) L_sel.clearLayers();
  $('#sheetBody').innerHTML = `<button class="x" data-a="close" aria-label="Cerrar">✕</button>` + html;
  const s = $('#sheet');
  if (!s.classList.contains('show')) { s.classList.add('show'); history.pushState({ sheet: 1 }, ''); }
  sizeSheet();
  $('#install').classList.remove('show');
}
function closeSheet(fromHistory = false) {
  const s = $('#sheet'); if (!s.classList.contains('show')) return;
  s.classList.remove('show'); sel = null; L_sel.clearLayers(); sizeSheet();
  if (!fromHistory && history.state && history.state.sheet) history.back();
}
function sizeSheet() {
  const s = $('#sheet'), mobile = innerWidth < 700;
  document.documentElement.style.setProperty('--sheetH', s.classList.contains('show') && mobile ? s.offsetHeight + 'px' : '0px');
}
window.addEventListener('popstate', () => closeSheet(true));
window.addEventListener('resize', sizeSheet);
$('#sheet').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a;
  if (a === 'close') closeSheet();
  else if (a === 'go') goMenu();
  else if (a === 'karoo') karooMenu();
  else if (a === 'back') showTrail();
  else if (a === 'flip') { sel.flip = !sel.flip; drawSelection(); ({ trail: showTrail, go: goMenu, karoo: karooMenu })[screen](); }
  else if (a === 'nav') openNav(b.dataset.app);
  else if (a === 'gpx') sendKaroo(b.dataset.m);
  else if (a === 'sharePoint') sharePoint();
  else if (a === 'layer') { setLayer(b.dataset.k); layersSheet(); }
  else if (a === 'saveZone') saveZone(+b.dataset.km);
  else if (a === 'stopZone') zoneStop = true;
  else if (a === 'wipe') wipe();
});
map.on('click', () => { if ($('#sheet.show')) closeSheet(); $('#results').classList.remove('show'); });

// ---------- elegir un sendero ----------
function selectTrail(w, tapLL) {
  const whole = wholeTrail(w);
  const routesTxt = (w.r || []).filter(n => n !== w.n);
  const own = w.n || w.ref, near = own || routesTxt.length ? '' : neighbourName(w);
  const tipo = w.h === 'track' ? 'Pista' : w.h === 'bridleway' ? 'Camino de herradura' : w.h === 'path' ? 'Sendero' : 'Camino';
  let name, note = '';
  if (own) { name = own; note = [w.n2 && 'También llamado: <b>' + esc(w.n2) + '</b>', routesTxt.length && 'Forma parte de: <b>' + esc(routesTxt.join(', ')) + '</b>'].filter(Boolean).join('<br>'); }
  else if (routesTxt.length) { name = routesTxt[0]; note = 'Tramo de esta ruta señalizada'; }
  else if (near) { name = near; note = 'Tramo sin nombre propio que continúa este camino'; }
  else { name = tipo + ' sin nombre'; note = 'Sin nombre en OpenStreetMap'; }
  sel = { w, g: whole.g, parts: whole.parts, name, note, tipo, flip: false, ele: null };
  // Se empieza por el extremo más cercano a ti (o al punto tocado si no hay GPS)
  const ref = me || (tapLL ? [tapLL.lat, tapLL.lng] : null);
  if (ref) sel.flip = dist(ref, sel.g[sel.g.length - 1]) < dist(ref, sel.g[0]);
  drawSelection();
  showTrail();
  fitSelection();
  loadElevation(sel);
}
// Encaja el sendero entero en la parte del mapa que no tapa la ficha
function fitSelection() {
  if (!sel) return;
  const mobile = innerWidth < 700, sh = $('#sheet').offsetHeight;
  map.fitBounds(L.latLngBounds(sel.g), {
    paddingTopLeft: [mobile ? 30 : 440, 90], paddingBottomRight: [70, mobile ? sh + 30 : 40], maxZoom: 17, animate: true
  });
}
const selLine = () => sel.flip ? sel.g.slice().reverse() : sel.g;
function drawSelection() {
  L_sel.clearLayers(); if (!sel) return;
  const g = selLine(), start = g[0], end = g[g.length - 1];
  L.polyline(g, { color: '#ffd400', weight: 10, opacity: 0.6, interactive: false }).addTo(L_sel);
  L.polyline(g, { ...trailStyle(sel.w), weight: 4, interactive: false }).addTo(L_sel);
  L.marker(end, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="entry" style="background:#333;width:22px;height:22px;font-size:11px">🏁</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(L_sel);
  L.marker(start, { interactive: false, zIndexOffset: 800, icon: L.divIcon({ className: '', html: '<div class="entry">🚩</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(L_sel);
  if (me) L.polyline([me, start], { color: '#1a73e8', weight: 3, dashArray: '6 8', opacity: 0.9, interactive: false }).addTo(L_sel);
}
function updateDistance() {
  const el = $('#selDist'); if (!el || !sel) return;
  el.innerHTML = me ? `Estás a <b>${fmtKm(dist(me, selLine()[0]))}</b> de la entrada 🚩 (en línea recta)` : '<span class="muted">Pulsa ⌖ para ver a qué distancia estás</span>';
  drawSelection();
}
function showTrail() {
  if (!sel) return;
  screen = 'trail';
  const s = parseInt(sel.w.s), lvl = s >= 0 ? LEVELS[Math.min(s, 5)] : null;
  const len = lineLen(sel.g);
  // Subida y bajada en el sentido en que vas a entrar
  const e = sel.ele && (sel.flip ? { up: sel.ele.down, down: sel.ele.up } : sel.ele);
  const eleTxt = e ? (e.up < 15 && e.down > 15 ? `↘ baja ${Math.round(e.down)} m` : e.down < 15 && e.up > 15 ? `↗ sube ${Math.round(e.up)} m` : `↗ ${Math.round(e.up)} m · ↘ ${Math.round(e.down)} m`) : '';
  openSheet(`<h2>${esc(sel.name)}</h2>${sel.note ? `<div class="muted">${sel.note}</div>` : ''}
    <div class="chips">
      <span class="chip"><i style="background:${trailStyle(sel.w).color}"></i>${lvl ? esc(lvl.t) : 'Dificultad sin marcar'}</span>
      <span class="chip">${esc(sel.tipo)} · ${fmtKm(len)}</span>
      ${eleTxt ? `<span class="chip">${eleTxt}</span>` : ''}
      ${sel.w.f ? `<span class="chip">${esc(SURF[sel.w.f] || sel.w.f)}</span>` : ''}
    </div>
    <div class="dist" id="selDist"></div>
    <div class="acts"><button class="btn pri" data-a="go">🧭 Llévame</button><button class="btn" data-a="karoo">🚴 Al Karoo</button></div>
    <div class="sub"><button class="btn" data-a="flip" style="padding:7px 10px;font-size:13px">⇄ Entrar por el otro lado</button>
      <a href="https://www.openstreetmap.org/way/${sel.w.id}" target="_blank" rel="noopener">Ver en OpenStreetMap</a></div>`, true);
  updateDistance();
}
// Desnivel del sendero (Open-Meteo, gratis; hasta 100 puntos por petición)
async function loadElevation(s) {
  try {
    const g = s.g, step = Math.max(1, Math.ceil(g.length / 100)), pts = g.filter((_, i) => i % step === 0 || i === g.length - 1).slice(0, 100);
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p[0].toFixed(5)).join(',')}&longitude=${pts.map(p => p[1].toFixed(5)).join(',')}`);
    const el = (await r.json()).elevation; if (!el || sel !== s) return;
    let up = 0, down = 0; for (let i = 1; i < el.length; i++) { const d = el[i] - el[i - 1]; d > 0 ? up += d : down -= d; }
    s.ele = { up, down, pts, el };
    if (sel === s && screen === 'trail' && $('#sheet.show')) showTrail();
  } catch { }
}

// ---------- llévame con el navegador del móvil ----------
function goMenu() {
  screen = 'go';
  const [lat, lng] = selLine()[0].map(v => v.toFixed(6));
  const apps = [];
  apps.push(['google', '🗺️ Google Maps', 'Ruta en bici hasta la entrada del sendero']);
  if (isIOS) apps.push(['apple', '🍎 Mapas de Apple', 'Ruta a pie (Apple no tiene bici en todas partes)']);
  if (!isIOS) apps.push(['geo', '📍 Otra app de mapas', 'OsmAnd, Organic Maps, Komoot… la que elijas']);
  openSheet(`<h2>Llévame a «${esc(sel.name)}»</h2>
    <div class="muted" style="margin:4px 0 10px">Hasta la entrada 🚩 (${lat}, ${lng})</div>
    <div class="opts">${apps.map(([k, t, d], i) => `<button class="btn ${i ? '' : 'pri'}" data-a="nav" data-app="${k}"><span>${t}<small>${d}</small></span></button>`).join('')}</div>
    <div class="sub"><button class="btn" data-a="back" style="padding:7px 12px;font-size:13px">‹ Volver</button><button class="btn" data-a="flip" style="padding:7px 10px;font-size:13px">⇄ Entrar por el otro lado</button></div>`, true);
}
function openNav(app) {
  const [lat, lng] = selLine()[0].map(v => v.toFixed(6));
  const url = app === 'google' ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=bicycling`
    : app === 'apple' ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`
      : `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(sel.name)})`;
  location.href = url;
}

// ---------- mandarlo al Karoo ----------
function karooMenu() {
  screen = 'karoo';
  openSheet(`<h2>«${esc(sel.name)}» al Karoo</h2>
    <div class="muted" style="margin:4px 0 12px">Hace falta internet en el móvil y la app <b>Karoo Companion</b> (Hammerhead).</div>
    <div class="opts">
      <button class="btn ok" data-a="sharePoint"><span>📍 Solo la entrada, con aviso en el Karoo<small>Elige <b>Karoo Companion</b>: el Karoo te pregunta al momento si quieres ir hasta la entrada 🚩. Luego el sendero lo sigues en el mapa</small></span></button>
      <button class="btn" data-a="gpx" data-m="full" ${me ? '' : 'disabled'}><span>🚴 Desde aquí hasta el sendero y el sendero<small>${me ? 'Ruta GPX por caminos hasta la entrada 🚩 y todo el sendero. No avisa: en el Karoo, Rutas → ⋮ → Sincronizar' : 'Necesita tu posición: pulsa ⌖ primero'}</small></span></button>
      <button class="btn" data-a="gpx" data-m="trail"><span>〰️ Solo el sendero<small>Ruta GPX de la entrada 🚩 al final 🏁. No avisa: en el Karoo, Rutas → ⋮ → Sincronizar</small></span></button>
    </div>
    <div class="sub"><button class="btn" data-a="back" style="padding:7px 12px;font-size:13px">‹ Volver</button><button class="btn" data-a="flip" style="padding:7px 10px;font-size:13px">⇄ Entrar por el otro lado</button></div>`, true);
}
// La app Karoo Companion (Hammerhead) acepta este texto con un enlace de Google Maps con coordenadas:
// el Karoo lo recibe al momento y pregunta si navegar hasta el punto (probado con su Karoo)
async function sharePoint() {
  const [lat, lng] = selLine()[0].map(v => v.toFixed(6));
  const url = `https://maps.google.com/?q=${lat},${lng}`;
  const text = `${sel.name} (entrada)\n${url}`;
  if (navigator.share) {
    try { await navigator.share({ title: sel.name, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Este navegador no deja compartir: el punto se ha copiado', 5000); }
  catch { toast('Este navegador no deja compartir el punto', 5000); }
}
async function brouter(a, b) {
  const r = await fetch(`https://brouter.de/brouter?lonlats=${a[1].toFixed(6)},${a[0].toFixed(6)}|${b[1].toFixed(6)},${b[0].toFixed(6)}&profile=trekking&alternativeidx=0&format=geojson`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('no se pudo calcular el camino hasta el sendero');
  return (await r.json()).features[0].geometry.coordinates.map(c => [c[1], c[0], c[2] ?? null]);
}
async function elevations(g) {
  const out = g.map(p => [p[0], p[1], p[2] ?? null]);
  const idx = out.map((p, i) => p[2] == null ? i : -1).filter(i => i >= 0);
  for (let k = 0; k < idx.length && k < 1000; k += 100) {
    const part = idx.slice(k, k + 100);
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${part.map(i => out[i][0].toFixed(5)).join(',')}&longitude=${part.map(i => out[i][1].toFixed(5)).join(',')}`);
      const el = (await r.json()).elevation || [];
      part.forEach((i, n) => { if (el[n] != null) out[i][2] = el[n]; });
    } catch { break; }
  }
  return out;
}
const xml = s => esc(s);
function makeGPX(name, g, wpts) {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Senderos BTT" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${xml(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
  for (const w of wpts) s += `<wpt lat="${w[0].toFixed(6)}" lon="${w[1].toFixed(6)}"><name>${xml(w[2])}</name><sym>${xml(w[3] || 'Flag, Blue')}</sym></wpt>\n`;
  s += `<trk><name>${xml(name)}</name><trkseg>\n`;
  s += g.map(p => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${p[2] != null ? `<ele>${p[2].toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  return s + `\n</trkseg></trk>\n</gpx>\n`;
}
async function sendKaroo(m) {
  const s = sel; if (!s) return;
  const trail = selLine().map(p => [p[0], p[1], null]);
  let g = trail, name = s.name;
  try {
    if (m === 'full') {
      if (!me) { toast('Pulsa ⌖ para saber dónde estás'); return; }
      toast('Calculando el camino hasta el sendero…', 8000);
      const approach = dist(me, trail[0]) > 30 ? await brouter(me, trail[0]) : [];
      g = approach.slice(0, -1).concat(trail);
      name = 'Hasta ' + s.name;
    }
    toast('Preparando el GPX…', 6000);
    g = await elevations(g);
    const gpx = makeGPX(name, g, [[trail[0][0], trail[0][1], 'Inicio ' + s.name, 'Trailhead'], [trail[trail.length - 1][0], trail[trail.length - 1][1], 'Fin ' + s.name, 'Flag, Red']]);
    const fname = (name.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'sendero') + '.gpx';
    const file = new File([gpx], fname, { type: 'application/gpx+xml' });
    $('#toast').classList.remove('show');
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    // Chrome en Android no deja a las webs compartir archivos .gpx: se guarda y se explica cómo mandarlo
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    screen = 'karoo';
    openSheet(`<h2>GPX guardado en Descargas</h2>
      <div class="muted" style="margin:4px 0 12px">El navegador no deja pasarlo directamente a otra app, así que hay que mandarlo desde el archivo:</div>
      <ol style="margin:0 0 12px 18px;padding:0;line-height:1.7">
        <li>Abre la app <b>Archivos</b> (o <b>Descargas</b>) del móvil.</li>
        <li><b>Mantén pulsado</b> «${esc(fname)}».</li>
        <li>Pulsa <b>Compartir</b> (no «Abrir con») y elige <b>Karoo Companion</b>.</li>
      </ol>
      <div class="muted">La ruta sube a tu cuenta y el Karoo la recibe al sincronizar (necesita internet en el móvil). Luego, en el Karoo: <b>Rutas → ⋮ → Sincronizar</b>. Si Karoo Companion no sale en la lista: entra en <a href="https://dashboard.hammerhead.io" target="_blank" rel="noopener" style="color:inherit">dashboard.hammerhead.io</a> → Rutas → Importar y elige el archivo.</div>
      <div class="sub"><button class="btn" data-a="back" style="padding:7px 12px;font-size:13px">‹ Volver al sendero</button></div>`, true);
  } catch (e) { toast('No se pudo: ' + e.message, 5000); }
}

// ---------- buscar: senderos cargados, lugares o coordenadas ----------
$('#search').onsubmit = async e => {
  e.preventDefault();
  const q = $('#q').value.trim(), R = $('#results');
  if (!q) { R.classList.remove('show'); return; }
  $('#q').blur();
  const c = q.match(/^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/);
  if (c) { map.setView([+c[1].replace(',', '.'), +c[2].replace(',', '.')], 16); R.classList.remove('show'); return; }
  const nq = norm(q), seen = new Set(), found = [];
  for (const w of loadedWays()) {
    const n = wayName(w); if (!n || seen.has(n) || !norm(n).includes(nq)) continue;
    seen.add(n); found.push(w); if (found.length >= 8) break;
  }
  let html = found.map((w, i) => `<div data-t="${i}">🚵 ${esc(wayName(w))}<small>${esc(parseInt(w.s) >= 0 ? LEVELS[Math.min(parseInt(w.s), 5)].t : 'Sendero')} · ya cargado en el mapa</small></div>`).join('');
  R.innerHTML = html + '<div class="muted" style="cursor:default">Buscando lugares…</div>'; R.classList.add('show');
  let places = [];
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=es,pt,fr,ad&accept-language=es&q=' + encodeURIComponent(q));
    places = await r.json();
  } catch { }
  html += places.map((p, i) => `<div data-p="${i}">📍 ${esc(p.display_name.split(',')[0])}<small>${esc(p.display_name.split(',').slice(1, 4).join(','))}</small></div>`).join('');
  R.innerHTML = html || '<div class="muted" style="cursor:default">Nada encontrado</div>';
  R.onclick = ev => {
    const d = ev.target.closest('[data-t],[data-p]'); if (!d) return;
    R.classList.remove('show');
    if (d.dataset.t != null) { const w = found[+d.dataset.t]; map.fitBounds(L.latLngBounds(w.g), { maxZoom: 16, padding: [60, 60] }); selectTrail(w); }
    else { const b = places[+d.dataset.p].boundingbox.map(Number); map.fitBounds([[b[0], b[2]], [b[1], b[3]]], { maxZoom: 15 }); }
  };
};
$('#q').addEventListener('focus', () => { if ($('#results').innerHTML && $('#q').value) $('#results').classList.add('show'); });

// ---------- mapas y zonas sin cobertura ----------
let zone = null, zoneStop = false;
function layersSheet() {
  sel = null; L_sel.clearLayers(); screen = 'layers';
  openSheet(`<h2>Mapas</h2>
    <div class="layers" style="margin-top:10px">${Object.entries(LAYERS).map(([k, d]) => `<label data-a="layer" data-k="${k}"><input type="radio" name="lay" ${k === settings.layer ? 'checked' : ''}> ${d.name}</label>`).join('')}</div>
    <h3>Colores de los senderos</h3>
    <div class="legend">${LEVELS.filter((_, i) => i !== 5).map(l => `<span><i style="background:${l.d ? `repeating-linear-gradient(90deg,${l.c} 0 7px,transparent 7px 10px)` : l.c}"></i>${l.t}</span>`).join('')}
      <span><i style="background:repeating-linear-gradient(90deg,#e8590c 0 3px,transparent 3px 7px)"></i>Sendero sin dificultad</span><span><i style="background:repeating-linear-gradient(90deg,#9a6b3c 0 6px,transparent 6px 10px)"></i>Pista</span></div>
    <h3>Para ir sin cobertura</h3>
    <div class="muted">Lo que miras se guarda solo. Antes de salir, abre la zona de la ruta y guárdala entera (mapa IGN hasta mucho detalle + senderos).</div>
    <div id="zoneBox" style="margin-top:10px">${zoneHTML()}</div>
    <div class="muted" id="usage" style="margin-top:10px"></div>
    <h3>Acerca de</h3>
    <div class="muted">Senderos y nombres: © colaboradores de <a href="https://www.openstreetmap.org/copyright" style="color:inherit">OpenStreetMap</a>. Mapas: IGN, OpenTopoMap, CyclOSM. Rutas hasta el sendero: BRouter. Altitudes: Open-Meteo.</div>`);
  showUsage();
}
function zoneHTML() {
  if (zone) return `<b>Guardando la zona…</b><div class="prog"><i style="width:${Math.round(zone.done / zone.total * 100)}%"></i></div><div class="muted">${zone.done.toLocaleString('es-ES')} de ${zone.total.toLocaleString('es-ES')} · ${zone.msg || ''}</div><button class="btn" data-a="stopZone" style="margin-top:8px;width:100%">Detener</button>`;
  return `<div class="acts"><button class="btn ok" data-a="saveZone" data-km="5">⬇ 5 km a la redonda</button><button class="btn ok" data-a="saveZone" data-km="10">⬇ 10 km a la redonda</button></div>
    <div class="muted" style="margin-top:6px">Alrededor del centro del mapa. 5 km ≈ 25 MB · 10 km ≈ 90 MB (mejor con wifi).</div>`;
}
async function showUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const e = await navigator.storage.estimate(), u = $('#usage');
  if (u) u.innerHTML = `Guardado en este móvil: <b>${(e.usage / 1048576).toFixed(0)} MB</b> · <button data-a="wipe" style="background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;padding:0;font-size:13px">Borrar todo</button>`;
}
function tilesFor(b, z) {
  const n = 2 ** z, x = lng => Math.floor((lng + 180) / 360 * n), y = lat => { const r = lat * RAD; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
  const out = []; for (let i = x(b.getWest()); i <= x(b.getEast()); i++) for (let j = y(b.getNorth()); j <= y(b.getSouth()); j++) out.push([z, i, j]);
  return out;
}
async function saveZone(km = 5) {
  if (zone) return;
  // Solo el IGN permite bajar teselas en bloque; si se ve otro mapa, se guarda el topográfico
  const layer = LAYERS[settings.layer].bulk ? settings.layer : 'mtn';
  const c = map.getCenter(), dLat = km / 111.2, dLng = km / (111.2 * Math.cos(c.lat * RAD));
  const b = L.latLngBounds([c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]);
  let list = []; for (let z = 11; z <= 16; z++) list = list.concat(tilesFor(b, z));
  // Senderos en bloques de 3 × 3 celdas para no saturar el servidor
  const missing = cellsIn(b).filter(x => !cells.has(x[2])), chunks = [];
  for (const x of missing) {
    const key = Math.floor(x[0] / 3) + '_' + Math.floor(x[1] / 3);
    let ch = chunks.find(q => q.key === key); if (!ch) chunks.push(ch = { key, list: [] }); ch.list.push(x);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  zone = { total: list.length + chunks.length, done: 0, msg: 'senderos' }; zoneStop = false; refreshZone();
  map.fitBounds(b);
  try {
    for (const ch of chunks) { if (zoneStop) break; await fetchCells(ch.list); zone.done++; refreshZone(); }
    zone.msg = 'mapa ' + LAYERS[layer].name;
    const d = LAYERS[layer], tpl = d.url;
    let i = 0;
    const worker = async () => {
      while (i < list.length && !zoneStop) {
        const [z, x, y] = list[i++], key = `tile/${layer}/${z}/${x}/${y}`;
        if (!(await kvHas(key))) {
          try { const r = await fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a'), { mode: 'cors' }); if (r.ok) await kvPut(key, await r.blob()); } catch { }
        }
        zone.done++; if (zone.done % 20 === 0) refreshZone();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    toast(zoneStop ? 'Guardado detenido' : '✅ Zona guardada: ya puedes ir sin cobertura', 4000);
  } catch (e) { toast('No se pudo guardar: ' + e.message, 5000); }
  zone = null; refreshZone(); drawTrails(); showUsage();
}
function refreshZone() { const z = $('#zoneBox'); if (z) z.innerHTML = zoneHTML(); }
async function wipe() {
  if (!confirm('¿Borrar los mapas y senderos guardados en este móvil?')) return;
  await kvClear(); cells.clear(); drawTrails(); showUsage(); toast('Borrado');
}
$('#layBtn').onclick = () => { if ($('#sheet.show') && !sel) closeSheet(); else layersSheet(); };

// ---------- instalar como app ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; showInstall(); });
function showInstall() {
  if (standalone || localStorage.getItem('senderos.noinstall')) return;
  const box = $('#install');
  if (installEvt) box.innerHTML = `<p>📲 Instala <b>Senderos BTT</b> en el móvil para abrirla como una app</p><button class="btn pri" id="inst">Instalar</button><button class="x" id="noinst">✕</button>`;
  else if (isIOS) box.innerHTML = `<p>📲 Para tenerla como app: pulsa <b>Compartir</b> <span style="font-size:18px">⬆️</span> abajo y luego <b>«Añadir a pantalla de inicio»</b></p><button class="x" id="noinst">✕</button>`;
  else return;
  box.classList.add('show');
  const i = $('#inst'); if (i) i.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; box.classList.remove('show'); };
  $('#noinst').onclick = () => { localStorage.setItem('senderos.noinstall', '1'); box.classList.remove('show'); };
}

// ---------- arranque ----------
(async function start() {
  try { await openDB(); } catch { }
  setLayer(settings.layer);
  if (settings.view) map.setView(settings.view.c, settings.view.z);
  else map.setView([41.55, 2.1], 10);
  // Si ya dio permiso de ubicación, se usa directamente; la primera vez, se centra en él
  try {
    const p = navigator.permissions && await navigator.permissions.query({ name: 'geolocation' });
    if (p && p.state === 'granted') startGPS(!settings.view);
    else if (!settings.view) startGPS(true);
  } catch { if (!settings.view) startGPS(true); }
  loadTrails();
  if (isIOS) setTimeout(showInstall, 2500);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
