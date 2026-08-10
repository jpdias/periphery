const STORE_KEY = "periphery-config";

// Defaults externalized in config.js (the client-side analog of env.h).
const D = window.PERIPHERY_CONFIG || {};

let cfg = {
  lat: D.defaultLat ?? 41.17,
  lon: D.defaultLon ?? -8.43,
  flightRange: D.defaultFlightRange ?? 25,
  incidentRadius: D.defaultIncidentRadius ?? 20,
  ipStation: "",
  ipStationName: "",
  apiBase: D.apiBase ?? "",
  useApiProxy: D.useApiProxy ?? true,
  locName: "",
  ipCity: "",
  uptimeSites: D.defaultUptimeSites ?? [],
  satellites: D.defaultSatellites ?? [],
  clocks: D.defaultClocks ?? [],
  hiddenWidgets: D.hiddenWidgets ?? [],
  cardOrder: D.defaultCardOrder ?? [],
  earthquakeRadius: D.earthquakeRadius ?? 1500,
  lightningRadius: D.lightningRadius ?? 500,
  alerts: D.alerts ?? ["incidents", "warnings"],
  units: D.units ?? { temperature: "C", wind: "kmh", distance: "km", pressure: "hPa" },
  clocksAll: true,
};

// Set true when the detected location is outside Portugal; disables the
// Portugal-only widgets (trains, incidents, IPMA warnings).
let outsidePT = false;

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    // Merge over the derived defaults, never replace them wholesale.
    cfg = { ...cfg, ...stored };
  } catch { /* ignore */ }
}
function saveConfig() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

function setStatus(text, cls = "") {
  const el = document.getElementById("status");
  el.classList.remove("ok", "err");
  if (cls) el.classList.add(cls);
  document.getElementById("status-text").textContent = text;
}

// Stamp the "last updated" HH:MM:SS on a widget card after a successful refresh.
function stamp(widget) {
  const el = document.getElementById(`upd-${widget}`);
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function apiPath(widget) {
  const base = cfg.apiBase ? cfg.apiBase.replace(/\/$/, "") : "";
  return `${base}/api/${widget}`;
}

async function apiGet(widget, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `${apiPath(widget)}${q ? "?" + q : ""}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

// ---- Widget visibility ------------------------------------------------

function widgetVisible(name) { return !(cfg.hiddenWidgets || []).includes(name); }

// ---- Alerts (tab title + toasts) ----------------------------------------

const ALERT_STORE_KEY = "periphery-alerts";

// Widgets that can raise alerts. Each entry maps the widget id to a human label.
// "uv" reads the forecast's daily UV max; "solar" fires on M/X-class flares.
const ALERTABLE = [
  ["incidents", "Incidents"],
  ["warnings", "Avisos (IPMA)"],
  ["airquality", "Bad air quality"],
  ["uv", "High UV index"],
  ["solar", "Solar flares"],
  ["seismic", "Seismic activity"],
];

let titleTimer = null;

function loadAlertStore() {
  try { return JSON.parse(localStorage.getItem(ALERT_STORE_KEY)) || {}; } catch { return {}; }
}
function saveAlertStore(store) {
  try { localStorage.setItem(ALERT_STORE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

// Flash an alert in the browser tab title, reverting shortly after.
function flashTitle(count, label) {
  const base = "periphery";
  document.title = `⚠ ${count} new ${label.toLowerCase()} · ${base}`;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => { document.title = base; }, 8000);
}
function resetTitle() {
  clearTimeout(titleTimer);
  document.title = "periphery";
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) resetTitle(); });
window.addEventListener("focus", resetTitle);

// Toast popup, dismissable; dismissing marks the alert as acknowledged so it
// never re-fires.
function showAlertToast(widget, label, items) {
  const box = document.getElementById("toasts");
  if (!box) return;
  items.slice(0, 3).forEach(({ sig, text }) => {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
      <span class="toast-tag">${esc(label)}</span>
      <span class="toast-msg">${esc(text)}</span>
      <button type="button" class="toast-x" aria-label="Dismiss">✕</button>`;
    toast.querySelector(".toast-x").addEventListener("click", () => {
      const store = loadAlertStore();
      if (store[widget] && store[widget][sig] != null) store[widget][sig].dismissed = true;
      saveAlertStore(store);
      toast.classList.add("gone");
      setTimeout(() => toast.remove(), 250);
    });
    box.appendChild(toast);
  });
}

// Compare freshly fetched item signatures against previously seen ones. A
// signature only fires once (persisted in localStorage, so it never re-fires
// across reloads either); dismissing marks it acknowledged for the record.
function trackAlerts(widget, items) {
  if (!cfg.alerts.includes(widget)) return;
  const store = loadAlertStore();
  const seen = store[widget] || (store[widget] = {});
  const fresh = items.filter(it => !seen[it.sig]);
  if (!fresh.length) return;
  fresh.forEach(it => { seen[it.sig] = { ts: Date.now(), dismissed: false }; });
  saveAlertStore(store);
  const label = (ALERTABLE.find(a => a[0] === widget) || [widget, widget])[1];
  flashTitle(fresh.length, label);
  showAlertToast(widget, label, fresh.map(it => ({ sig: it.sig, text: it.text })));
}

function renderAlertToggles() {
  const box = document.getElementById("alert-toggles");
  if (!box) return;
  box.innerHTML = ALERTABLE.map(([name, label]) => `
    <div class="wsec" data-alert="${name}">
      <div class="wsec-head">
        <span class="wsec-title">${label}</span>
        <input type="checkbox" class="w-toggle a-toggle" data-alert="${name}"
          ${cfg.alerts.includes(name) ? "checked" : ""} aria-label="Alert on ${label}">
      </div>
    </div>`).join("");
}

function renderWidgetToggles() {
  // Per-widget settings sections live in the sidebar. Each has a toggle in its
  // header; config fields show/hide based on that toggle.
  document.querySelectorAll(".wsec[data-widget]").forEach(sec => {
    const name = sec.dataset.widget;
    const toggle = sec.querySelector(".w-toggle");
    if (toggle) toggle.checked = widgetVisible(name);
    sec.classList.toggle("on", widgetVisible(name));
  });
  // Global "all clocks" switch lives in the Clocks group.
  const allClocks = document.getElementById("cfg-clocks-all");
  if (allClocks) allClocks.checked = cfg.clocksAll !== false;
}

function setWidgetSection(name, on) {
  const sec = document.querySelector(`.wsec[data-widget="${name}"]`);
  if (sec) sec.classList.toggle("on", on);
}

function applyWidgetVisibility() {
  // The "all clocks" switch is the master: turning it off hides every clock.
  const clocksOff = cfg.clocksAll === false;
  document.querySelectorAll("[data-widget]").forEach(card => {
    const name = card.dataset.widget;
    let show = widgetVisible(name);
    if (clocksOff && /^clock(\d+)?$/.test(name)) show = false;
    // Portugal-only widgets don't apply when the observer is outside the country.
    if (outsidePT && ["trains", "incidents", "warnings"].includes(name)) show = false;
    // Small clocks also need a configured timezone to be useful.
    const m = /^clock(\d+)$/.exec(name);
    if (m) {
      const idx = parseInt(m[1], 10) - 2;
      if (!(cfg.clocks[idx] || {}).tz) show = false;
    }
    card.style.display = show ? "" : "none";
  });
}

// Apply the saved card order (cfg.cardOrder) by moving cards in the grid so
// the DOM matches the user's drag-and-drop arrangement.
function applyCardOrder() {
  const grid = document.getElementById("grid");
  if (!grid || !Array.isArray(cfg.cardOrder) || !cfg.cardOrder.length) return;
  cfg.cardOrder.forEach(name => {
    const card = grid.querySelector(`.card[data-widget="${name}"]`);
    if (card) grid.appendChild(card);
  });
}

// Grafana-style grip handle (six dots) shown on each card; only it starts a drag.
const DRAG_HANDLE_SVG = `
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="2.5" r="1.6"/><circle cx="7.5" cy="2.5" r="1.6"/>
    <circle cx="2.5" cy="8"   r="1.6"/><circle cx="7.5" cy="8"   r="1.6"/>
    <circle cx="2.5" cy="13.5" r="1.6"/><circle cx="7.5" cy="13.5" r="1.6"/>
  </svg>`;

function addDragHandle(card) {
  if (!card || card.querySelector(".drag-handle")) return;
  const h = document.createElement("span");
  h.className = "drag-handle";
  h.title = "Drag to reorder";
  h.draggable = true;
  h.innerHTML = DRAG_HANDLE_SVG;
  card.prepend(h);
}

function injectDragHandles() {
  document.querySelectorAll(".card").forEach(addDragHandle);
}

// Drag & drop reordering for dashboard cards via Pointer Events (works with
// mouse and touch). Only the grip handle starts a drag. Order persists in
// cfg.cardOrder. Fallback to HTML5 DnD when Pointer Events are unsupported.
function initCardDrag() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  if (!window.PointerEvent) {
    initHtml5Drag(grid);
    return;
  }

  let dragEl = null, touchId = null;

  const cardFromPoint = (x, y) => {
    dragEl.style.display = "none";
    const el = document.elementFromPoint(x, y);
    dragEl.style.display = "";
    return el ? el.closest(".card") : null;
  };

  const reorderUnder = (x, y) => {
    const target = cardFromPoint(x, y);
    if (!target || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    if (y > rect.top + rect.height / 2) {
      if (dragEl !== target.nextElementSibling) target.after(dragEl);
    } else {
      if (dragEl !== target.previousElementSibling) target.before(dragEl);
    }
  };

  const onMove = e => {
    if (!dragEl) return;
    if (touchId !== null && e.pointerId !== touchId) return;
    reorderUnder(e.clientX, e.clientY);
  };

  const persist = () => {
    cfg.cardOrder = [...grid.querySelectorAll(".card")].map(c => c.dataset.widget);
    saveConfig();
    if (dragEl) {
      dragEl.classList.remove("dragging");
      dragEl.style.zIndex = "";
    }
    dragEl = null;
    touchId = null;
    document.body.style.cursor = "";
  };

  const onDown = e => {
    const handle = e.target.closest ? e.target.closest(".drag-handle") : null;
    if (!handle) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    touchId = e.pointerId;
    const card = handle.closest(".card");
    if (!card) return;
    dragEl = card;
    card.classList.add("dragging");
    card.style.zIndex = 50;
    document.body.style.cursor = "grabbing";
    try { grid.setPointerCapture(e.pointerId); } catch {}
  };

  grid.addEventListener("pointerdown", onDown);
  grid.addEventListener("pointermove", onMove);
  grid.addEventListener("pointerup", persist);
  grid.addEventListener("pointercancel", persist);
}

// HTML5 drag & drop fallback for browsers without PointerEvent support.
function initHtml5Drag(grid) {
  let dragEl = null;

  grid.addEventListener("dragstart", e => {
    const handle = e.target.closest(".drag-handle");
    if (!handle) return;
    const card = handle.closest(".card");
    if (!card) return;
    dragEl = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.widget);
  });
  grid.addEventListener("dragover", e => {
    e.preventDefault();
    if (!dragEl) return;
    e.dataTransfer.dropEffect = "move";
    const target = e.target.closest(".card");
    if (!target || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY > rect.top + rect.height / 2) target.after(dragEl);
    else target.before(dragEl);
  });
  const done = () => {
    if (!dragEl) return;
    cfg.cardOrder = [...grid.querySelectorAll(".card")].map(c => c.dataset.widget);
    saveConfig();
    dragEl.classList.remove("dragging");
    dragEl = null;
  };
  grid.addEventListener("drop", done);
  grid.addEventListener("dragend", done);
}

// Common IANA timezones for the small-clock dropdown.
const TIMEZONES = [
  "UTC", "Europe/Lisbon", "Europe/London", "Europe/Paris", "Europe/Madrid",
  "Europe/Berlin", "Europe/Rome", "Europe/Athens", "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg",
  "Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "Asia/Dubai", "Asia/Kolkata",
  "Australia/Sydney", "Pacific/Auckland",
];

function fillTimezoneSelect(sel, current) {
  if (!sel) return;
  const emptyOpt = current ? "" : `<option value="">—</option>`;
  sel.innerHTML = emptyOpt + TIMEZONES.map(tz =>
    `<option value="${tz}" ${tz === current ? "selected" : ""}>${tz}</option>`
  ).join("");
  sel.value = current || "";
}

// Render one settings row per configured small clock (max 2), each with a
// widget toggle, label + timezone fields and a remove button. Rows are pure
// DOM; cfg.clocks is only rebuilt from them on Save.
function renderSmallClockConfigs() {
  const box = document.getElementById("small-clock-configs");
  if (!box) return;
  box.innerHTML = "";
  cfg.clocks.forEach((c, i) => {
    const n = i + 2;
    const name = `clock${n}`;
    const row = document.createElement("div");
    row.className = "wsec clk-row";
    row.dataset.widget = name;
    row.innerHTML = `
      <div class="wsec-head">
        <span class="wsec-title">Clock ${n}</span>
        <span class="clk-head-right">
          <button type="button" class="btn-square clk-rm" title="Remove clock" aria-label="Remove clock">✕</button>
        <input type="checkbox" class="w-toggle" data-widget="${name}" aria-label="Show Clock ${n}">
        </span>
      </div>
      <div class="wcfg">
        <label>Label
          <input type="text" id="cfg-clock${n}-label" value="${esc(c.label || "")}" placeholder="e.g. Tokyo">
        </label>
        <label>Timezone
          <select id="cfg-clock${n}-tz"></select>
        </label>
      </div>`;
    box.appendChild(row);
    fillTimezoneSelect(row.querySelector(`#cfg-clock${n}-tz`), c.tz || "");
    const on = widgetVisible(name) && cfg.clocksAll !== false;
    row.querySelector(".w-toggle").checked = on;
    row.classList.toggle("on", on);
  });
}

// Build a new small-clock settings row appended to the Clocks section.
function addClockRow() {
  const box = document.getElementById("small-clock-configs");
  if (!box) return;
  const n = box.querySelectorAll(".clk-row").length + 2;
  const name = `clock${n}`;
  const row = document.createElement("div");
  row.className = "wsec clk-row";
  row.dataset.widget = name;
  row.innerHTML = `
    <div class="wsec-head">
      <span class="wsec-title">Clock ${n}</span>
      <span class="clk-head-right">
        <button type="button" class="btn-square clk-rm" title="Remove clock" aria-label="Remove clock">✕</button>
        <input type="checkbox" class="w-toggle" data-widget="${name}" checked aria-label="Show Clock ${n}">
      </span>
    </div>
    <div class="wcfg">
      <label>Label
        <input type="text" id="cfg-clock${n}-label" placeholder="e.g. Tokyo">
      </label>
      <label>Timezone
        <select id="cfg-clock${n}-tz"></select>
      </label>
    </div>`;
  box.appendChild(row);
  fillTimezoneSelect(row.querySelector(`#cfg-clock${n}-tz`), "");
  row.classList.toggle("on", widgetVisible(name));
}

function removeClockRow(row) {
  if (!row) return;
  row.remove();
}

function fmtTZ(date, tz, opts) {
  try {
    return new Intl.DateTimeFormat([], { timeZone: tz, ...opts }).format(date);
  } catch { return "--:--"; }
}

function updateSmallClocks() {
  const now = new Date();
  cfg.clocks.forEach((c, i) => {
    const n = i + 2; // clock2, clock3, clock4, ...
    const label = document.getElementById(`clock${n}-label`);
    const time = document.getElementById(`clock${n}-time`);
    const date = document.getElementById(`clock${n}-date`);
    if (!time) return;
    if (!c.tz) return;
    if (label) label.textContent = c.label || `Clock ${n}`;
    time.textContent = fmtTZ(now, c.tz, { hour: "2-digit", minute: "2-digit" });
    if (date) date.textContent = fmtTZ(now, c.tz, { weekday: "short", day: "2-digit", month: "short" });
  });
}

// Create one small-clock card in the grid per configured clock. The main clock
// card (data-widget="clock") is static in index.html and stays untouched.
function renderClockCards() {
  const grid = document.getElementById("grid");
  const main = document.querySelector('.card[data-widget="clock"]');
  if (!grid || !main) return;
  // Drop any stale dynamic clock cards (clock2, clock3, ...).
  document.querySelectorAll('.card[data-widget^="clock"]').forEach(card => {
    if (card !== main && /^clock\d+$/.test(card.dataset.widget)) card.remove();
  });
  cfg.clocks.forEach((c, i) => {
    const n = i + 2;
    const existing = document.getElementById(`clock${n}-time`);
    if (existing) return;
    const card = document.createElement("section");
    card.className = "card smallclock-card";
    card.dataset.widget = `clock${n}`;
    card.draggable = true;
    card.innerHTML = `
      <h2 class="card-title" data-tip="Extra clock — timezone set in settings"><span class="sc-label" id="clock${n}-label">${esc(c.label || `Clock ${n}`)}</span><span class="upd" id="upd-clock${n}"></span></h2>
      <div class="clock-time small" id="clock${n}-time">--:--</div>
      <div class="clock-date" id="clock${n}-date"></div>`;
    const lastClock = [...grid.querySelectorAll('.card[data-widget^="clock"]:not([data-widget="clock"])')].pop();
    (lastClock || main).after(card);
    addDragHandle(card);
  });
}

// ---- Weather -------------------------------------------------------------

async function loadWeather() {
  try {
    const { data } = await apiGet("weather", { lat: cfg.lat, lon: cfg.lon });
    const cur = data.current || {};
    document.getElementById("weather-icon").innerHTML = wmoIcon(cur.weather_code);
    const temp = convertTemperature(cur.temperature_2m, cfg.units.temperature);
    document.getElementById("weather-temp").textContent =
      temp != null ? `${Math.round(temp)}°` : "—";
    document.getElementById("weather-desc").textContent = wmoText(cur.weather_code);
    const d = data.daily || {};
    const kmh = v => Math.round(v);
    // Color scale helpers (green→red; low value = good unless noted).
    const cell = (k, v, cls) => `<div class="wcell"><span class="wk">${k}</span><span class="wv${cls ? " " + cls : ""}">${v}</span></div>`;
    const hum = cur.relative_humidity_2m;
    const clouds = cur.cloud_cover;
    const windKmh = cur.wind_speed_10m;
    const gustKmh = cur.wind_gusts_10m;
    const cells = [
      cell("Feels like", `${Math.round(convertTemperature(cur.apparent_temperature, cfg.units.temperature))}°`),
      cell("Humidity", hum != null ? `${Math.round(hum)}%` : "—", scaleClass(hum, 30, 85)),
      cell("Dew point", `${Math.round(convertTemperature(cur.dew_point_2m, cfg.units.temperature))}°`),
      cell("Clouds", clouds != null ? `${Math.round(clouds)}%` : "—", scaleClass(clouds, 15, 85)),
      cell("Wind", windKmh != null ? `${convertWindSpeed(kmh(windKmh), cfg.units.wind)} ${cfg.units.wind === 'mph' ? 'mph' : 'km/h'}` : "—", scaleClass(kmh(windKmh), 10, 50)),
      cell("Gusts", gustKmh != null ? `${convertWindSpeed(kmh(gustKmh), cfg.units.wind)} ${cfg.units.wind === 'mph' ? 'mph' : 'km/h'}` : "—", scaleClass(kmh(gustKmh), 15, 70)),
      cell("Wind dir", `${cur.wind_direction_10m}°`),
      cell("Pressure", `${Math.round(convertPressure(cur.pressure_msl, cfg.units.pressure))} ${cfg.units.pressure === 'inHg' ? 'inHg' : 'hPa'}`),
      cell("Visibility", `${Math.round(convertDistance(cur.visibility / 1000, cfg.units.distance))} ${cfg.units.distance === 'mi' ? 'mi' : 'km'}`),
      cell("Precip", `${convertDistance(cur.precipitation, cfg.units.distance)} mm`),
    ];
    if (d.uv_index_max?.[0] != null) cells.push(cell("UV index", d.uv_index_max[0].toFixed(1), uvClass(d.uv_index_max[0])));
    if (d.precipitation_probability_max?.[0] != null)
      cells.push(cell("Rain chance", `${Math.round(d.precipitation_probability_max[0])}%`, scaleClass(d.precipitation_probability_max[0], 15, 80)));
    document.getElementById("weather-grid").innerHTML = cells.join("");
    stamp("weather");
  } catch (e) {
    setStatus(e.message, "err");
  }
}

// ---- Forecast ------------------------------------------------------------

// Weather code → monochrome SVG icon (stroke-based, inherits currentColor so the
// terminal theme stays consistent and nothing depends on emoji font support).
const WMO = {
  0:  { i: svgIcon("sun"), t: "Clear" },
  1:  { i: svgIcon("sun-cloud"), t: "Mostly clear" },
  2:  { i: svgIcon("sun-cloud"), t: "Partly cloudy" },
  3:  { i: svgIcon("cloud"), t: "Overcast" },
  45: { i: svgIcon("fog"), t: "Fog" }, 48: { i: svgIcon("fog"), t: "Icy fog" },
  51: { i: svgIcon("drizzle"), t: "Drizzle" }, 53: { i: svgIcon("drizzle"), t: "Drizzle" }, 55: { i: svgIcon("drizzle"), t: "Drizzle" },
  61: { i: svgIcon("rain"), t: "Rain" }, 63: { i: svgIcon("rain"), t: "Rain" }, 65: { i: svgIcon("rain"), t: "Heavy rain" },
  66: { i: svgIcon("rain"), t: "Freezing rain" }, 67: { i: svgIcon("rain"), t: "Freezing rain" },
  71: { i: svgIcon("snow"), t: "Snow" }, 73: { i: svgIcon("snow"), t: "Snow" }, 75: { i: svgIcon("snow"), t: "Heavy snow" },
  77: { i: svgIcon("snow"), t: "Snow grains" },
  80: { i: svgIcon("showers"), t: "Showers" }, 81: { i: svgIcon("showers"), t: "Showers" }, 82: { i: svgIcon("storm"), t: "Storm" },
  85: { i: svgIcon("snow"), t: "Snow showers" }, 86: { i: svgIcon("snow"), t: "Snow showers" },
  95: { i: svgIcon("storm"), t: "Thunderstorm" },
  96: { i: svgIcon("storm"), t: "Hail storm" }, 99: { i: svgIcon("storm"), t: "Hail storm" },
};

function svgIcon(name) {
  const paths = {
    sun: `<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>`,
    cloud: `<path d="M7 18a4.5 4.5 0 0 1-.5-9 5.5 5.5 0 0 1 10.6 1.3A3.8 3.8 0 0 1 17 18Z"/>`,
    "sun-cloud": `<circle cx="8.5" cy="9" r="3"/><path d="M8.5 3v1.5M3 8.5h1.5M5 5l1 1M12 5l-1 1M16 17a3.5 3.5 0 0 1-.4-7 4.3 4.3 0 0 1 8.3 1A3 3 0 0 1 22 17Z" transform="translate(-2 -1)"/>`,
    fog: `<path d="M4 7a3 3 0 0 1 .4-5.9A3.6 3.6 0 0 1 8 2a4 4 0 0 1 7.6 1A2.7 2.7 0 0 1 17 7H4Z"/><path d="M3 12h18M5 16h14M7 20h10"/>`,
    drizzle: `<path d="M7 15a4 4 0 0 1-.4-7.9A5 5 0 0 1 16.4 5 3.4 3.4 0 0 1 16 15Z"/><path d="M8 19l-1 2M13 19l-1 2M17.5 19l-1 2"/>`,
    rain: `<path d="M7 14a4 4 0 0 1-.4-7.9A5 5 0 0 1 16.4 4 3.4 3.4 0 0 1 16 14Z"/><path d="M8 19l-1.2 2.4M13.5 19l-1.2 2.4M19 19l-1.2 2.4"/>`,
    showers: `<circle cx="8" cy="8.5" r="3"/><path d="M8 3.5v1M3 8.5h1M4.8 4.8l.9.9M15 14a3.5 3.5 0 0 1-.4-7 4.2 4.2 0 0 1 8 1 3 3 0 0 1 1.4 6Z" transform="translate(0 -1)"/><path d="M11 19l-1 2M15.5 19l-1 2"/>`,
    storm: `<path d="M7 13a4 4 0 0 1-.4-7.9A5 5 0 0 1 16.4 3 3.4 3.4 0 0 1 16 13Z"/><path d="M13 13l-3 5h3l-2 5"/>`,
    snow: `<path d="M7 14a4 4 0 0 1-.4-7.9A5 5 0 0 1 16.4 4 3.4 3.4 0 0 1 16 14Z"/><path d="M9 19v2M9 18.5l-1.7 1M9 18.5l1.7 1M14 19v2M14 18.5l-1.7 1M14 18.5l1.7 1M19 19v2M19 18.5l-1.7 1M19 18.5l1.7 1"/>`,
    therm: `<path d="M10 4a2 2 0 1 1 4 0v9.2a4.5 4.5 0 1 1-4 0Z"/><path d="M12 9v6"/>`,
  };
  const d = paths[name] || paths.therm;
  return `<svg class="wsvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function wmoIcon(code) { return (WMO[code] || WMO[0]).i; }
function wmoText(code) { return (WMO[code] || { t: "—" }).t; }

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

async function loadForecast() {
  try {
    const { data } = await apiGet("forecast", { lat: cfg.lat, lon: cfg.lon });
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let html = "";
    const todayStr = new Date().toDateString();
    (data.days || []).forEach((d, i) => {
      const dt = d.date ? new Date(d.date) : null;
      const today = dt && dt.toDateString() === todayStr;
      const fields = [
        ["UV", d.uv != null ? `<span class="${uvClass(d.uv)}">${d.uv.toFixed(1)}</span>` : "—"],
        ["Rain", d.precip_prob != null ? `<span class="${scaleClass(d.precip_prob, 15, 80)}">${Math.round(d.precip_prob)}%</span>` : "—"],
        ["Wind", d.wind_dir ? `<span class="f-meta-v">${esc(d.wind_dir)}${d.wind_class ? " " + esc(d.wind_class) : ""}</span>` : (d.wind_class ? `<span>${esc(d.wind_class)}</span>` : "—")],
      ].map(([k, v]) => `<span class="f-meta"><b>${k}</b>${v}</span>`).join("");
      html += `<div class="forecast-line${today ? " today" : ""}">
        <span class="day">${today ? "Today" : (dt ? days[dt.getDay()] : `+${i}`)}</span>
        <span class="ic">${svgIcon(d.weather_icon || "cloud")}</span>
        <span class="desc">${esc(d.weather_type || "—")}</span>
         <span class="hi">${Math.round(convertTemperature(d.t_max, cfg.units.temperature))}°</span>
         <span class="lo">${Math.round(convertTemperature(d.t_min, cfg.units.temperature))}°</span>
        <span class="f-fields">${fields}</span>
      </div>`;
    });
    if (!(data.days || []).length) html = `<div class="empty">No forecast data</div>`;
    document.getElementById("forecast-row").innerHTML = html;
    const uvToday = (data.days || [])[0]?.uv;
    if (uvToday != null && uvToday >= 8) {
      trackAlerts("uv", [{
        sig: `uv:${uvToday.toFixed(1)}`,
        text: `UV index ${uvToday.toFixed(1)} today — very high`,
      }]);
    }
    stamp("forecast");
  } catch (e) {
    document.getElementById("forecast-row").innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Incidents -----------------------------------------------------------

async function loadIncidents() {
  try {
    const { data } = await apiGet("incidents", {
      lat: cfg.lat, lon: cfg.lon, radius: cfg.incidentRadius,
    });
    const el = document.getElementById("incident-list");
    const countEl = document.getElementById("incident-count");
    if (data.outside_pt) {
      if (countEl) countEl.textContent = "0";
      el.innerHTML = `<div class="empty">Fire incidents layer only covers Portugal</div>`;
      stamp("incidents");
      return;
    }
    // Safety net: the upstream geofence can be trusted, but clamp anything that
    // slips through the radius so the card never shows out-of-range incidents.
    const radius = cfg.incidentRadius || 20;
    const feats = (data.features || []).map(f => {
      const c = f.geometry && f.geometry.coordinates;
      const dist = Array.isArray(c) && c.length >= 2
        ? haversineKm(cfg.lat, cfg.lon, c[1], c[0]) : Infinity;
      return { f, dist };
    }).filter(x => x.dist <= radius).sort((a, b) => a.dist - b.dist).map(x => x.f);

    if (!feats.length) {
      el.innerHTML = `<div class="empty">No incidents within ${radius} km</div>`;
      if (countEl) countEl.textContent = "0";
      stamp("incidents");
      return;
    }
    const count = feats.filter(f => isActive(f.properties.EstadoOcorrencia)).length;
    if (countEl) countEl.textContent = `${feats.length} within ${radius} km · ${count} active`;
    el.innerHTML = feats.map(f => {
      const p = f.properties;
      const c = f.geometry && f.geometry.coordinates;
      const d = Array.isArray(c) && c.length >= 2
        ? haversineKm(cfg.lat, cfg.lon, c[1], c[0]) : null;
      return `<li>
        <span class="con">${esc(p.Concelho || "—")}</span>
        ${esc(p.Natureza || "")}
        <span class="when">${d != null ? d.toFixed(1) + " km · " : ""}${esc(p.EstadoOcorrencia || "")}</span>
      </li>`;
    }).join("");
    trackAlerts("incidents", feats.map(f => ({
      sig: `${f.properties.Concelho}|${f.properties.Natureza}|${f.properties.EstadoOcorrencia}`,
      text: `${f.properties.Natureza || "Incident"} · ${f.properties.Concelho || "—"} (${f.properties.EstadoOcorrencia || ""})`,
    })));
    stamp("incidents");
  } catch (e) {
    document.getElementById("incident-list").innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isActive(estado) {
  const s = (estado || "").toLowerCase();
  return s.includes("chegada") || s.includes("ativa") || s.includes("em curso") || !s;
}

function esc(s) { return s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// ---- Trains --------------------------------------------------------------

function trainWindow(shiftHours = 0) {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Window is ~now-1h → now+3h; shifted forward when the previous window was empty.
  const start = new Date(now.getTime() - 60 * 60 * 1000 + shiftHours * 3600 * 1000);
  const end = new Date(start.getTime() + 4 * 3600 * 1000);
  return {
    date: iso(start),
    start: hhmm(start),
    end: hhmm(end),
  };
}

// Turn one upstream trains response into a sorted, future-only departure list.
function collectTrainRows(response) {
  const rows = [];
  for (const tbl of response || []) {
    if ((tbl.TipoPedido | 0) !== 1) continue;
    for (const el2 of (tbl.NodesComboioTabelsPartidasChegadas || [])) {
      if (el2.ComboioPassou) continue;
      const dep = el2.DataHoraPartidaChegada;
      if (!dep) continue;
      // Upstream sends "HH:MM"; tolerate a full ISO string if it ever appears.
      const time = /^\d{2}:\d{2}/.test(dep) ? dep.slice(0, 5) : dep.slice(11, 16);
      // Sort by the epoch millis when present (correct across midnight), else fall back.
      const ms = /\/Date\((\d+)[+-]/.exec(el2.DataHoraPartidaChegada_ToOrderByi || "");
      const sortKey = ms ? Number(ms[1]) : Infinity;
      rows.push({
        time,
        dest: el2.NomeEstacaoDestino || "—",
        num: el2.NComboio1,
        op: el2.Operador || "",
        obs: el2.Observacoes || "",
        sortKey,
      });
    }
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);
  return rows;
}

async function loadTrains() {
  const el = document.getElementById("train-list");
  document.getElementById("train-station").textContent = cfg.ipStationName || "";
  if (!cfg.ipStation) {
    el.innerHTML = `<div class="empty">No train station configured (see settings)</div>`;
    return;
  }
  try {
    // Slide forward through 4h windows until we have the next 4 departures.
    // Busy stations fill up on the first window (one fetch); quiet ones take a
    // few. Cap at ~12h ahead so we never hammer the upstream.
    const want = 4, MAX_SHIFT = 12;
    let rows = [], seen = new Set();
    for (let shift = 0; shift <= MAX_SHIFT && rows.length < want; shift += 3) {
      const win = trainWindow(shift);
      const { data } = await apiGet("trains", {
        station: cfg.ipStation,
        date: win.date, start: win.start, end: win.end,
      });
      const fresh = collectTrainRows(data.response).filter(r => {
        if (seen.has(r.sortKey)) return false;
        seen.add(r.sortKey);
        return true;
      });
      rows = rows.concat(fresh);
    }
    rows.sort((a, b) => a.sortKey - b.sortKey);
    const top = rows.slice(0, want);
    if (!top.length) {
      el.innerHTML = `<div class="empty">No departures in the next few hours</div>`;
      stamp("trains");
      return;
    }
    el.innerHTML = top.map(r => {
      const delay = parseDelay(r.obs);
      return `<li>
        <span class="time">${r.time}</span>
        <span class="dest"><b>${esc(r.dest)}</b><span>#${r.num} · ${esc(r.op)}</span></span>
        ${delay ? `<span class="delay">+${delay}′</span>` : ""}
      </li>`;
    }).join("");
    stamp("trains");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function parseDelay(obs) {
  const m = /atraso de\s+(\d+)\s*min/.exec(obs || "");
  return m ? parseInt(m[1], 10) : 0;
}

// ---- Solar ---------------------------------------------------------------

async function loadSolar() {
  const el = document.getElementById("solar-flare");
  const grid = document.getElementById("solar-grid");
  try {
    const { data } = await apiGet("solar", { lat: cfg.lat, lon: cfg.lon });
    const flare = data.flare || {};
    const kp = data.kp || {};
    const cls = flare.current_class || flare.max_class || "—";
    el.textContent = cls;
    el.className = "solar-big " + flareClassColor(cls);
    document.getElementById("solar-flare-desc").textContent =
      `X-ray flux · ${data.flare_storm?.label || ""}`;
    setFlareScaleMarker(cls);
    const loc = data.location || {};
    const kpNum = kp.index ?? kp.estimated;
    // Kp 0–9, low is good: map onto the 5-step green→red ramp.
    const kpCellCls = kpNum == null ? "" : scaleClass(kpNum, 2, 6);
    const stormLvl = (data.geomagnetic_storm?.level || "").replace(/^G/, "");
    const stormCls = data.geomagnetic_storm?.level == null ? "" :
      /^[012]$/.test(stormLvl) ? "sc1" : /^[34]$/.test(stormLvl) ? "sc3" : "sc5";
    const cells = [
      ["Kp index", `<span class="${kpCellCls}">${kpNum ?? "—"} (${kp.label || ""})</span>`.trim()],
      ["Geomag storm", data.geomagnetic_storm?.level ? `<span class="${stormCls}">${data.geomagnetic_storm.level}</span>` : "—"],
      ["Background", data.background_class || "—"],
    ];
    if (loc.geomagnetic_latitude != null) {
      cells.push(["GeoMag lat", `${loc.geomagnetic_latitude}°`]);
    }
    if (data.aurora) {
      cells.push([
        "Aurora",
        `${data.aurora.chance}${data.aurora.visible_now ? " · now" : ""} (Kp≥${data.aurora.min_kp})`,
      ]);
    }
    if (data.flare_storm && data.flare_storm.local_impact != null) {
      cells.push(["Local radio", data.flare_storm.local_impact ? "☀️ day-side" : "🌙 night"]);
    }
    grid.innerHTML = cells.map(([k, v]) =>
      `<div class="wcell"><span class="wk">${k}</span><span class="wv">${v}</span></div>`).join("");
    const letter = (cls || "").trim().toUpperCase().charAt(0);
    if (letter === "M" || letter === "X") {
      trackAlerts("solar", [{
        sig: `flare:${cls.trim().toUpperCase()}`,
        text: `Solar flare ${cls} · ${data.flare_storm?.label || ""}`,
      }]);
    }
    stamp("solar");
  } catch (e) {
    el.textContent = "—";
    grid.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function flareClassColor(cls) {
  const c = (cls || "").trim().toUpperCase();
  if (c.startsWith("X")) return "sc5";
  if (c.startsWith("M")) return "sc4";
  if (c.startsWith("C")) return "sc3";
  if (c.startsWith("B")) return "sc2";
  return "sc1";
}

// Position the marker on the A–X severity bar (log-ish mapping to letters).
function setFlareScaleMarker(cls) {
  const marker = document.getElementById("solar-scale-marker");
  if (!marker) return;
  const c = (cls || "").trim().toUpperCase();
  const letter = (c.match(/^[ABCMX]/) || ["A"])[0];
  const mag = parseFloat(c.slice(1)) || 0;
  const base = { A: 0, B: 0.2, C: 0.4, M: 0.6, X: 0.8 }[letter] ?? 0;
  const pct = Math.min(100, Math.max(0, (base + Math.min(mag, 10) / 10 * 0.19) * 100));
  marker.style.left = `${pct}%`;
}

// ---- Flights -------------------------------------------------------------

async function loadFlights() {
  const el = document.getElementById("flight-list");
  try {
    const { data } = await apiGet("flights", {
      lat: cfg.lat, lon: cfg.lon, dist: cfg.flightRange,
    });
    const ac = data.aircraft || [];
    document.getElementById("flight-count").textContent =
      `${ac.length} aircraft within ${cfg.flightRange}nm`;
    if (!ac.length) {
      el.innerHTML = `<div class="empty">No flights in range</div>`;
      stamp("flights");
      return;
    }
    el.innerHTML = ac.map(a => {
      const alt = a.alt_baro ?? (a.alt_geom ?? "—");
      const spd = a.gs ?? "—";
      const call = a.flight || a.hex;
      const { tag, cls } = classifyAc(a.category, a.dbFlags);
      return `<li>
        <span class="callsign">${esc(call)}</span>
        <span class="actag ${cls}">${tag}</span>
        <span class="meta">${alt}ft · ${spd}kt</span>
      </li>`;
    }).join("");
    stamp("flights");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// Derive a short class tag from the ADS-B emitter category + military flag,
// mirroring the firmware's flight.cpp classify().
function classifyAc(cat, dbFlags) {
  if (dbFlags & 1) return { tag: "MIL", cls: "mil" };
  const a = (cat || "").charAt(0), b = (cat || "").charAt(1);
  if (a === "A") {
    switch (b) {
      case "7": return { tag: "HEL", cls: "hel" };
      case "3": case "4": case "5": return { tag: "COM", cls: "com" };
      case "1": case "2": case "6": return { tag: "LGT", cls: "lgt" };
    }
  } else if (a === "B") {
    switch (b) {
      case "1": return { tag: "GLI", cls: "gli" };
      case "2": return { tag: "BAL", cls: "bal" };
      case "4": return { tag: "ULT", cls: "ult" };
      case "6": return { tag: "UAV", cls: "uav" };
    }
  }
  return { tag: "CIV", cls: "civ" };
}

// ---- Radiation (APA RADNET) ---------------------------------------------

function radClass(n) {
  if (n >= 1000) return { cls: "high", pct: 100 };
  if (n >= 300) return { cls: "warn", pct: 30 + (n / 1000) * 70 };
  return { cls: "", pct: (n / 300) * 30 };
}

async function loadRadiation() {
  const el = document.getElementById("rad-value");
  const grid = document.getElementById("rad-grid");
  try {
    const { data } = await apiGet("radiation", { lat: cfg.lat, lon: cfg.lon });
    const n = data.nearest || {};
    const v = Number(n.dose_nsvh);
    document.getElementById("rad-station").textContent = `${n.station || "—"} · ${n.distance_km ?? "—"}km`;
    el.textContent = isFinite(v) ? v : "—";
    el.className = "rad-big " + (isFinite(v) ? radClass(v).cls : "");
    document.getElementById("rad-unit").textContent = n.unit || "nSv/h";
    const marker = document.getElementById("rad-marker");
    if (marker) marker.style.left = `${isFinite(v) ? radClass(v).pct : 0}%`;
    const cells = [
      ["Sensor", n.station || "—"],
      ["Dist", `${n.distance_km ?? "—"} km`],
      ["Status", n.status || "—"],
    ];
    if (n.updated) cells.push(["Updated", fmtTime(n.updated)]);
    grid.innerHTML = cells.map(([k, v]) =>
      `<div class="wcell"><span class="wk">${k}</span><span class="wv">${v}</span></div>`).join("");
    stamp("radiation");
  } catch (e) {
    el.textContent = "—";
    grid.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Air quality (APA QualAr) -------------------------------------------

function airClass(v) {
  const cls = v == null ? "q0" : `q${Math.max(0, Math.min(5, v))}`;
  const pct = v == null ? 0 : ((Math.max(1, Math.min(5, v)) - 1) / 4) * 100;
  return { cls, pct };
}

async function loadAirQuality() {
  const el = document.getElementById("air-value");
  const grid = document.getElementById("air-grid");
  try {
    const { data } = await apiGet("airquality", { lat: cfg.lat, lon: cfg.lon });
    const s = data.station || {};
    const gi = data.global_index || {};
    document.getElementById("air-station").textContent = `${s.name || "—"} · ${s.distance_km ?? "—"}km`;
    const v = gi.value;
    el.textContent = v != null ? v : "—";
    el.className = "air-big " + airClass(v).cls;
    document.getElementById("air-label").textContent = gi.label || "IQAR";
    const marker = document.getElementById("air-marker");
    if (marker) marker.style.left = `${airClass(v).pct}%`;
    const cells = (data.pollutants || []).map(p => `
      <div class="wcell${p.alert ? " alert" : ""}">
        <span class="wk">${esc(p.pollutant)}</span>
        <span class="wv">${p.indexName || "—"} ${p.value ? `(${esc(p.value)})` : ""}</span>
      </div>`).join("");
    grid.innerHTML = cells || `<div class="empty">No pollutant data</div>`;
    if (v != null && v >= 4) {
      trackAlerts("airquality", [{
        sig: `air:${v}`,
        text: `${gi.label || "IQAR"} ${v} · ${s.name || "air quality station"}`,
      }]);
    }
    stamp("airquality");
  } catch (e) {
    el.textContent = "—";
    grid.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Meteor showers (astro calendar) ------------------------------------

async function loadAstro() {
  const el = document.getElementById("astro-list");
  try {
    const { data } = await apiGet("astro");
    const active = data.active || [];
    const next = data.next || [];
    let html = "";
    for (const s of active) {
      html += `<li class="active">
        <span class="sh-tag">now</span>
        <span class="sh-name">${esc(s.name)}</span>
        <span class="sh-peak">${esc(s.peak_date)}</span>
        <span class="sh-zhr">ZHR ${s.zhr}</span>
      </li>`;
    }
    for (const s of next) {
      if (s.days_until_peak > 0 && s.days_until_peak < 100) {
        html += `<li>
          <span class="sh-name">${esc(s.name)}</span>
          <span class="sh-peak">${esc(s.peak_date)}</span>
          <span class="sh-days">in ${s.days_until_peak}d</span>
          <span class="sh-zhr">ZHR ${s.zhr}</span>
        </li>`;
      }
    }
    if (!html) html = `<div class="empty">No active showers — see next peak</div>`;
    el.innerHTML = html;
    stamp("astro");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Uptime monitors -----------------------------------------------------

async function loadUptime() {
  const el = document.getElementById("uptime-list");
  const sites = cfg.uptimeSites;
  document.getElementById("uptime-count").textContent = sites.length ? `${sites.length} monitors` : "";
  if (!sites.length) {
    el.innerHTML = `<div class="empty">No monitors configured (see settings)</div>`;
    return;
  }
  try {
    const { data } = await apiGet("uptime", { sites: JSON.stringify(sites) });
    const up = data.sites || [];
    const down = up.filter(s => !s.ok);
    document.getElementById("uptime-count").textContent =
      `${up.filter(s => s.ok).length}/${up.length} up${down.length ? " · " + down.length + " down" : ""}`;
    el.innerHTML = up.map(s => `
      <li>
        <span class="up-dot ${s.ok ? "ok" : "down"}"></span>
        <span class="up-label">${esc(s.label)}</span>
        ${s.status ? `<span class="up-status">${s.status}</span>` : ""}
        <span class="up-ms ${s.ok ? "" : "down"}">${s.ok ? s.ms + "ms" : (s.error || "down")}</span>
      </li>`).join("");
    stamp("uptime");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Lightning -----------------------------------------------------------

function agoStr(sec) {
  if (sec == null) return "—";
  if (sec < 120) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

// Lightning proximity scale: closer strikes get hotter colors.
function boltDistClass(km) {
  if (km == null) return "";
  if (km <= 50) return "b-near";
  if (km <= 150) return "b-close";
  if (km <= 350) return "b-far";
  return "";
}

// ---- Units conversion -----------------------------------------------------

// Reference-value color helpers (used by propagation, space weather, UV).
// Return a CSS class (good/mid/bad) given a numeric value and breakpoints.
// refClass: low is good (geomagnetic indices). refClassHigh: high is good (SFI).
function refClass(v, good, bad) {
  if (v == null) return "";
  if (v <= good) return "good";
  if (v >= bad) return "bad";
  return "mid";
}

function refClassHigh(v, good, bad) {
  if (v == null) return "";
  if (v >= good) return "good";
  if (v <= bad) return "bad";
  return "mid";
}

// Uniform 5-step green→red scale for arbitrary numeric values.
// `bad` maps to red, `good` to green, everything in between interpolates by
// fraction. Returns one of sc1..sc5 (see .scN in style.css).
function scaleClass(v, good, bad) {
  if (v == null || !isFinite(v)) return "";
  const t = (v - good) / (bad - good);
  if (t >= 0.75) return "sc5";
  if (t >= 0.5) return "sc4";
  if (t >= 0.25) return "sc3";
  if (t >= 0.05) return "sc2";
  return "sc1";
}

function uvClass(v) {
  if (v == null) return "";
  if (v < 3) return "uv-low";
  if (v < 6) return "uv-mod";
  if (v < 8) return "uv-high";
  if (v < 11) return "uv-vhigh";
  return "uv-extreme";
}

function convertTemperature(value, toUnit) {
  if (value == null) return null;
  if (toUnit === "F") {
    return value * 9 / 5 + 32;
  }
  return value; // default C
}
function convertWindSpeed(value, toUnit) {
  if (value == null) return null;
  if (toUnit === "mph") {
    return value * 0.621371;
  }
  return value; // default km/h
}
function convertDistance(value, toUnit) {
  if (value == null) return null;
  if (toUnit === "mi") {
    return value * 0.621371;
  }
  return value; // default km
}
function convertPressure(value, toUnit) {
  if (value == null) return null;
  if (toUnit === "inHg") {
    return value * 0.0295299830714;
  }
  return value; // default hPa
}

async function loadLightning() {
  const el = document.getElementById("bolt-list");
  try {
    const { data } = await apiGet("lightning", {
      lat: cfg.lat, lon: cfg.lon, radius: cfg.lightningRadius,
    });
    const st = (data.strikes || [])
      .slice()
      .sort((a, b) => (a.distance_km - b.distance_km) || ((a.seconds_ago ?? 0) - (b.seconds_ago ?? 0)));
    document.getElementById("bolt-count").textContent = `${st.length} within ${data.radius_km}km`;
    if (!st.length) {
      el.innerHTML = `<div class="empty">No recent strikes in range</div>`;
      stamp("lightning");
      return;
    }
    el.innerHTML = st.map(s => `
      <li>
        <span class="b-pol ${s.polarity < 0 ? "neg" : ""}">${s.polarity < 0 ? "−" : "+"}</span>
        <span class="b-dist ${boltDistClass(s.distance_km)}">${s.distance_km}km</span>
        <span class="b-when">${agoStr(s.seconds_ago)}</span>
      </li>`).join("");
    stamp("lightning");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Warnings (IPMA avisos) ---------------------------------------------

async function loadWarnings() {
  const el = document.getElementById("warning-list");
  try {
    const { data } = await apiGet("warnings", { lat: cfg.lat, lon: cfg.lon });
    if (data.outside_pt) {
      document.getElementById("warnings-count").textContent = "";
      el.innerHTML = `<div class="empty">IPMA advisories only cover Portugal</div>`;
      stamp("warnings");
      return;
    }
    const alerts = data.alerts || [];
    document.getElementById("warnings-count").textContent =
      data.area ? `${data.area.name}${data.count ? " · " + data.count : ""}` : "";
    if (!alerts.length) {
      el.innerHTML = `<div class="empty">No active warnings in ${data.area?.name || "your district"}</div>`;
      stamp("warnings");
      return;
    }
    el.innerHTML = alerts.map(a => `
      <li class="lv-${a.level}">
        <div class="w-dist">${esc(a.type)} <span class="lv-tag">${esc(a.level)}</span></div>
        <div class="w-alerts">until ${a.end ? fmtTime(a.end) : "—"}</div>
      </li>`).join("");
    trackAlerts("warnings", alerts
      .filter(a => a.level !== "green")
      .map(a => ({
        sig: `${a.type}|${a.level}|${a.start || ""}|${a.end || ""}`,
        text: `${a.type} (${a.level}) · until ${a.end ? fmtTime(a.end) : "—"}`,
      })));
    stamp("warnings");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Satellites (SGP4 next passes) --------------------------------------

function fmtSatTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

async function loadSatellites() {
  const el = document.getElementById("sat-list");
  try {
    const { data } = await apiGet("satellites", {
      lat: cfg.lat, lon: cfg.lon, sats: JSON.stringify(cfg.satellites),
    });
    const sats = data.satellites || [];
    document.getElementById("sat-count").textContent = data.satellites ? `${sats.length} tracked` : "";
    if (!sats.length) {
      el.innerHTML = `<div class="empty">No satellites configured (see settings)</div>`;
      stamp("satellites");
      return;
    }
    el.innerHTML = sats.map(s => {
      if (s.error || !s.next) {
        return `<li><span class="sat-name">${esc(s.name)}</span><span class="sat-none">${s.error || "no pass in 48h"}</span></li>`;
      }
      const p = s.next;
      const mins = p.duration_min;
      return `<li>
        <span class="sat-name">${esc(s.name)}</span>
        <span class="sat-pass">
          <span class="sat-when">${fmtSatTime(p.rise)}</span>
          <span class="sat-meta"> · elev ${p.max_elev}° · ${mins}min</span>
        </span>
      </li>`;
    }).join("");
    stamp("satellites");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- National grid (REN) -------------------------------------------------

function renW(name, short) {
  return `<div class="ren-src"><span class="ren-src-name">${short}</span><span class="ren-src-val">${name ?? "—"}</span></div>`;
}

async function loadRen() {
  const el = document.getElementById("ren-sources");
  try {
    const { data } = await apiGet("ren");
    const mix = data.mix;
    document.getElementById("ren-sub").textContent = data.date || "";
    if (!mix) {
      el.innerHTML = `<div class="empty">Grid data unavailable (REN upstream)</div>`;
      stamp("ren");
      return;
    }
    const s = mix.sources || {};
    const demand = mix.consumption_plus_storage ?? mix.consumption;
    document.getElementById("ren-consumption").textContent =
      demand != null ? `${Math.round(demand)}` : "—";
    document.getElementById("ren-label").textContent = "MW demand";
    const marker = document.getElementById("ren-marker");
    if (marker && mix.renewable_share_pct != null) {
      marker.style.left = `${Math.min(100, Math.max(0, mix.renewable_share_pct))}%`;
    }
    el.innerHTML = [
      renW(s.wind, "wind"), renW(s.solar, "solar"), renW(s.hydro, "hydro"),
      renW(s.natural_gas, "gas"), renW(s.coal, "coal"), renW(s.biomass, "bio"),
      renW(s.wave, "wave"), renW(s.other_thermal, "therm"),
    ].join("");
    const share = mix.renewable_share_pct;
    if (share != null) {
      el.innerHTML += `<div class="ren-share ${scaleClass(share, 80, 20)}">${share}% renewable</div>`;
    }
    // Daily energy totals (MWh) from the consumption/supply endpoint.
    const price = document.getElementById("ren-price");
    const sup = data.supply || {};
    const parts = [];
    if (sup.total_generation != null) parts.push(`gen ${Math.round(sup.total_generation)}MWh`);
    if (sup.consumption != null) parts.push(`cons ${Math.round(sup.consumption)}MWh`);
    if (sup.renewable_generation != null) parts.push(`ren ${Math.round(sup.renewable_generation)}MWh`);
    if (parts.length) {
      price.innerHTML = `<span class="ren-price-val">${parts.join(" · ")}</span>`;
    } else {
      price.innerHTML = "";
    }
    stamp("ren");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Seismic (IPMA) ------------------------------------------------------

function seismoClass(m) { return m >= 4.5 ? "m4" : m >= 3.5 ? "m3" : m >= 2.5 ? "m2" : m >= 1.5 ? "m1" : "m0"; }

async function loadSeismic() {
  const el = document.getElementById("seismic-list");
  try {
    const { data } = await apiGet("seismic", { lat: cfg.lat, lon: cfg.lon });
    // Newest first, then closest (time + distance, not magnitude).
    const ev = (data.events || [])
      .slice()
      .sort((a, b) =>
        (new Date(b.time || 0) - new Date(a.time || 0)) ||
        ((a.distance_km ?? 1e9) - (b.distance_km ?? 1e9)));
    document.getElementById("seismic-count").textContent =
      data.last_activity ? `as of ${fmtTime(data.last_activity)}` : "";
    const maxMag = ev.length ? Math.max(...ev.map(e => e.mag)) : null;
    const marker = document.getElementById("seismo-marker");
    if (marker) marker.style.left = `${maxMag == null ? 0 : Math.min(100, Math.max(0, (maxMag / 6) * 100))}%`;
    if (!ev.length) {
      el.innerHTML = `<div class="empty">No recent seismic activity</div>`;
      stamp("seismic");
      return;
    }
    el.innerHTML = ev.map(e => `
      <li>
        <span class="q-mag ${seismoClass(e.mag)}">M${e.mag.toFixed(1)}</span>
        <span class="q-place">${esc(e.region)}</span>
        <span class="q-meta">${e.distance_km}km · ${e.depth_km}km · ${e.time ? fmtTime(e.time) : "—"}</span>
      </li>`).join("");
    trackAlerts("seismic", ev
      .filter(e => e.mag >= 4.0)
      .map(e => ({
        sig: `${e.time}|${e.lat}|${e.lon}`,
        text: `M${e.mag.toFixed(1)} ${e.region} · ${e.distance_km}km away`,
      })));
    stamp("seismic");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Fuel prices (API Aberta / DGEG) -------------------------------------

const FUEL_ICONS = { gasoline_95: "⛽", gasoline_98: "⛽", diesel: "🛢", diesel_plus: "🛢", gpl_auto: "◔", gnc_kg: "◔" };

async function loadFuel() {
  const el = document.getElementById("fuel-list");
  try {
    const { data } = await apiGet("fuel");
    const fuels = data.fuels || [];
    document.getElementById("fuel-sub").textContent = data.date || "";
    if (!fuels.length) {
      el.innerHTML = `<div class="empty">Fuel data unavailable</div>`;
      stamp("fuel");
      return;
    }
    el.innerHTML = fuels.map(f => {
      const lo = Math.min(...fuels.map(x => x.avg));
      const hi = Math.max(...fuels.map(x => x.avg));
      const cls = hi > lo ? scaleClass(f.avg, lo, hi) : "";
      return `
      <li>
        <span class="fuel-ic">${FUEL_ICONS[f.slug] || "•"}</span>
        <span class="fuel-name">${esc(f.name)}</span>
        <span class="fuel-price${cls ? " " + cls : ""}">€${f.avg.toFixed(3)}</span>
        <span class="fuel-meta">${f.min.toFixed(3)}–${f.max.toFixed(3)}</span>
      </li>`;
    }).join("");
    stamp("fuel");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- FX (ECB / Frankfurter) ----------------------------------------------

async function loadFx() {
  const el = document.getElementById("fx-list");
  try {
    const { data } = await apiGet("fx");
    const rates = data.rates || {};
    document.getElementById("fx-sub").textContent = data.date || "";
    const entries = Object.entries(rates);
    if (!entries.length) {
      el.innerHTML = `<div class="empty">FX data unavailable</div>`;
      stamp("fx");
      return;
    }
    el.innerHTML = entries.map(([code, r]) => {
      const cls = r.change_pct == null ? "" : r.change_pct >= 0 ? "up" : "down";
      const delta = r.change_pct == null ? "—" : `${r.change_pct >= 0 ? "+" : ""}${r.change_pct}%`;
      return `<li>
        <span class="fx-code">${esc(code)}</span>
        <span class="fx-rate">${Number(r.rate).toFixed(4)}</span>
        <span class="fx-chg ${cls}">${delta}</span>
      </li>`;
    }).join("");
    stamp("fx");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Lisbon stock index (PSI) --------------------------------------------

async function loadPsi() {
  try {
    const { data } = await apiGet("psi");
    document.getElementById("psi-sub").textContent = data.symbol || "";
    const big = document.getElementById("psi-price");
    big.textContent =
      data.price != null ? data.price.toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
    big.classList.toggle("down", data.change != null && data.change < 0);
    const chg = data.change_pct;
    document.getElementById("psi-change").innerHTML =
      chg == null ? "—" : `<span class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "+" : ""}${chg}%</span>`;
    const range = document.getElementById("psi-range");
    range.innerHTML = [
      data.day_low != null ? `day ${data.day_low.toLocaleString()}–${data.day_high?.toLocaleString()}` : "",
      data.fifty_two_week?.low != null ? `52w ${data.fifty_two_week.low.toLocaleString()}–${data.fifty_two_week.high?.toLocaleString()}` : "",
    ].filter(Boolean).map(t => `<span class="psi-range-item">${t}</span>`).join("");
    stamp("psi");
   } catch (e) {
     document.getElementById("psi-price").textContent = "—";
     document.getElementById("psi-change").textContent = e.message;
   }
 }
 
 // ---- Propagation (NOAA SWPC + Kyoto) --------------------------------------
 
 async function loadPropagation() {
   const el = document.getElementById("propagation-bands");
   try {
     const { data } = await apiGet("propagation");
     const indices = data.indices || {};
     document.getElementById("propagation-sub").textContent = data.updated ? fmtTime(data.updated) : "";
     const sfi = indices.sfi;
     const aIndex = indices.a_index;
     const kp = indices.kp;
     const dst = indices.dst;
     const trend = indices.sfi_trend;
 
     // SFI line
     const sfiEl = document.getElementById("propagation-sfi");
     if (sfiEl) {
       sfiEl.textContent = sfi != null ? `${Math.round(sfi)}` : "—";
       sfiEl.className = "prop-value " + refClassHigh(sfi, 150, 100);
       if (trend && trend.direction) {
         sfiEl.title = `SFI trend: ${trend.direction} ${Math.abs(trend.delta || 0)} sfu/7d`;
       } else {
         sfiEl.title = "";
       }
     }
 
     // A-index line
     const aEl = document.getElementById("propagation-a");
     if (aEl) {
       aEl.textContent = aIndex != null ? `${aIndex}` : "—";
       aEl.className = "prop-value " + refClass(aIndex, 10, 30);
     }
 
     // Kp line
     const kpEl = document.getElementById("propagation-kp");
     if (kpEl) {
       kpEl.textContent = kp != null ? `${kp.toFixed(2)}` : "—";
       kpEl.className = "prop-value " + refClass(kp, 3, 5);
       if (indices.kp_label) {
         kpEl.title = indices.kp_label;
       }
     }
 
     // Dst line (more negative = worse storm)
     const dstEl = document.getElementById("propagation-dst");
     if (dstEl) {
       dstEl.textContent = dst != null ? `${dst}` : "—";
       dstEl.className = "prop-value " + (dst == null ? "" : dst > -30 ? "good" : dst < -80 ? "bad" : "mid");
       if (dst != null && dst < -50) {
         dstEl.title = "Geomagnetic storm";
       } else {
         dstEl.title = "";
       }
     }
 
     // Gray-line
     const grayEl = document.getElementById("propagation-gray");
     if (grayEl) {
       const gray = data.gray_line || {};
       grayEl.textContent = gray.label || "—";
       grayEl.title = gray.next_event || "";
       if (gray.active) {
         grayEl.classList.add("active");
       } else {
         grayEl.classList.remove("active");
       }
     }
 
     // Bands
     const bandsEl = document.getElementById("propagation-bands");
     if (bandsEl) {
       const bands = data.bands || [];
       bandsEl.innerHTML = bands.map(b => {
         const cls = b.quality === "excellent" ? "prop-excellent" :
                       b.quality === "good" ? "prop-good" :
                       b.quality === "fair" ? "prop-fair" :
                       b.quality === "poor" ? "prop-poor" :
                       "prop-closed";
         return `<li><span class="prop-band">${b.band}</span><span class="prop-value ${cls}">${b.quality}</span></li>`;
       }).join("");
     }
 
     // Overall quality
     const overallEl = document.getElementById("propagation-overall");
     if (overallEl) {
       const overall = data.overall || {};
       overallEl.textContent = overall.label || "—";
       overallEl.className = `prop-overall ${overall.level || ""}`;
     }
 
     stamp("propagation");
   } catch (e) {
     el.innerHTML = `<div class="empty">${e.message}</div>`;
   }
 }
 
 // ---- System / moon -------------------------------------------------------

function updateLocChip() {
  document.getElementById("loc-coords").textContent =
    `${cfg.lat.toFixed(4)}, ${cfg.lon.toFixed(4)}`;
  const name = document.getElementById("loc-name");
  const approx = cfg.locName || cfg.ipCity || "";
  name.textContent = approx;
  if (approx) name.classList.add("has");
}

async function loadSystem() {
  document.getElementById("sys-loc").textContent = `${cfg.lat.toFixed(4)}, ${cfg.lon.toFixed(4)}`;
  updateLocChip();
  try {
    const { data } = await apiGet("ip");
    document.getElementById("sys-ip").textContent = data.ip || "—";
    if (data.city && !cfg.locName) {
      cfg.ipCity = `${data.city}${data.region ? ", " + data.region : ""}`;
      saveConfig();
      updateLocChip();
    }
  } catch { document.getElementById("sys-ip").textContent = "—"; }
  stamp("system");
}

async function loadMoon() {
  try {
    const { data } = await apiGet("moon", { lat: cfg.lat, lon: cfg.lon });
    // Sun/Moon rise & set from the NASA Horizons RTS table (UTC → local).
    const fmt = iso => {
      if (!iso) return "--:--";
      try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
      catch { return "--:--"; }
    };
    document.getElementById("sun-rise").textContent = fmt(data.sunrise);
    document.getElementById("sun-set").textContent = fmt(data.sunset);
    document.getElementById("moon-rise").textContent = fmt(data.moonrise);
    document.getElementById("moon-set").textContent = fmt(data.moonset);
    const frac = data.moon_phase ?? synodicFraction(new Date());
    document.getElementById("moon-phase").innerHTML = moonDisc(frac);
    document.getElementById("moon-label").textContent = describeMoon(frac, data);
    stamp("sunmoon");
  } catch {
    // keep defaults
  }
}

function describeMoon(frac, data) {
  const name = data && data.moon_phase_name ? data.moon_phase_name : moonPhaseName(frac);
  const illum = Math.round((data && data.moon_illumination) || frac * 100);
  return `${name} · ${illum}%`;
}

function moonPhaseName(frac) {
  if (frac < 0.02 || frac > 0.98) return "New Moon";
  if (frac < 0.25) return "Waxing Crescent";
  if (frac < 0.48) return "First Quarter";
  if (frac < 0.52) return "Full Moon";
  if (frac < 0.75) return "Last Quarter";
  if (frac < 0.98) return "Waning Crescent";
  return "New Moon";
}

function synodicFraction(d) {
  // Moon age from synodic month (29.53d), known new moon epoch ~2000-01-06 18:14 UTC.
  const epoch = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((d.getTime() - epoch) / 86400000) % 29.530588853;
  return age < 0 ? age + 29.53 : age;
}

// Render the moon phase as an SVG disc with a real terminator, mirroring the
// firmware's scanline algorithm (ui_draw_moon): phase 0/1 = new, 0.5 = full.
// The lit lens is built by sampling the terminator curve x = C ± k·sqrt(R²-y²),
// where k = cos(2π·phase); lit on the right while waxing, left while waning.
function moonDisc(phase) {
  const R = 48, C = 50, STEPS = 40;
  const k = Math.cos(2 * Math.PI * phase);   // +1 new … -1 full
  const waxing = phase < 0.5;
  // Terminator edge: inner boundary of the lit lens, top → bottom.
  let d = "";
  for (let i = 0; i <= STEPS; i++) {
    const y = C - R + (2 * R * i) / STEPS;
    const half = Math.sqrt(Math.max(0, R * R - (y - C) ** 2));
    const x = waxing ? C + k * half : C - k * half;
    d += `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }
  // Outer lit boundary: moon disc limb, bottom → top on the lit side.
  for (let i = STEPS; i >= 0; i--) {
    const y = C - R + (2 * R * i) / STEPS;
    const half = Math.sqrt(Math.max(0, R * R - (y - C) ** 2));
    const x = waxing ? C + half : C - half;
    d += `L${x.toFixed(2)},${y.toFixed(2)}`;
  }
  d += "Z";
  const lit = (1 - k) / 2;   // illuminated fraction 0..1
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${C}" cy="${C}" r="${R}" fill="#0d0f14" stroke="#3a4150" stroke-width="2"/>
    <path d="${d}" fill="url(#moonshade)" opacity="${0.55 + 0.45 * lit}"/>
    <defs>
      <radialGradient id="moonshade" cx="0.38" cy="0.35" r="0.9">
        <stop offset="0" stop-color="#f8f8f2"/>
        <stop offset="1" stop-color="#9a9278"/>
      </radialGradient>
    </defs>
  </svg>`;
}

// ---- Clock ---------------------------------------------------------------

function tick() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("clock-time").textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  document.getElementById("clock-date").textContent =
    now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  updateSmallClocks();
}

// ---- Settings ------------------------------------------------------------

function openSettings() {
  document.getElementById("cfg-lat").value = cfg.lat;
  document.getElementById("cfg-lon").value = cfg.lon;
  document.getElementById("cfg-range").value = cfg.flightRange;
  document.getElementById("cfg-incident-radius").value = cfg.incidentRadius;
  document.getElementById("cfg-quake-radius").value = cfg.earthquakeRadius;
  document.getElementById("cfg-lightning-radius").value = cfg.lightningRadius;
  document.getElementById("cfg-station").value = cfg.ipStation;
  document.getElementById("cfg-station-name").value = cfg.ipStationName;
  const upBox = document.getElementById("cfg-uptime-sites");
  if (upBox) upBox.value = (cfg.uptimeSites || []).map(s => `${s.label} | ${s.url}`).join("\n");
  const satBox = document.getElementById("cfg-satellites");
  if (satBox) satBox.value = (cfg.satellites || []).map(s => `${s.name} | ${s.id}`).join("\n");
  renderSmallClockConfigs();
  renderWidgetToggles();
  renderAlertToggles();
  document.getElementById("settings-panel").classList.remove("hidden");
  document.getElementById("settings-scrim").classList.remove("hidden");
}
function closeSettings() {
  document.getElementById("settings-panel").classList.add("hidden");
  document.getElementById("settings-scrim").classList.add("hidden");
}
function saveSettings() {
  cfg.lat = parseFloat(document.getElementById("cfg-lat").value) || cfg.lat;
  cfg.lon = parseFloat(document.getElementById("cfg-lon").value) || cfg.lon;
  cfg.flightRange = parseInt(document.getElementById("cfg-range").value, 10) || 25;
  cfg.incidentRadius = parseInt(document.getElementById("cfg-incident-radius").value, 10) || 20;
  cfg.ipStation = document.getElementById("cfg-station").value.trim();
  cfg.ipStationName = document.getElementById("cfg-station-name").value.trim();
  cfg.earthquakeRadius = parseInt(document.getElementById("cfg-quake-radius").value, 10) || cfg.earthquakeRadius;
  cfg.lightningRadius = parseInt(document.getElementById("cfg-lightning-radius").value, 10) || cfg.lightningRadius;
  const upBox = document.getElementById("cfg-uptime-sites");
  if (upBox) {
    cfg.uptimeSites = upBox.value.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf("|");
      if (i > 0) return { label: l.slice(0, i).trim(), url: l.slice(i + 1).trim() };
      return { label: l, url: l };
    });
  }
  const satBox = document.getElementById("cfg-satellites");
  if (satBox) {
    cfg.satellites = satBox.value.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf("|");
      if (i > 0) return { name: l.slice(0, i).trim(), id: l.slice(i + 1).trim() };
      return { name: l, id: l };
    });
  }
  cfg.clocks = [...document.querySelectorAll(".clk-row")].map(row => ({
    label: row.querySelector('input[type="text"]').value.trim(),
    tz: row.querySelector("select").value,
  }));
  cfg.hiddenWidgets = [...document.querySelectorAll(".wsec[data-widget] .w-toggle")].filter(cb => !cb.checked).map(cb => cb.dataset.widget);
  const allClocks = document.getElementById("cfg-clocks-all");
  if (allClocks) cfg.clocksAll = allClocks.checked;
  cfg.alerts = [...document.querySelectorAll(".a-toggle")].filter(cb => cb.checked).map(cb => cb.dataset.alert);
  saveConfig();
  renderClockCards();
  applyWidgetVisibility();
  updateSmallClocks();
  updateLocChip();
  closeSettings();
  setStatus("saved", "ok");
  refreshAll();
}

function useMyLocation(close = true) {
  if (!navigator.geolocation) { setStatus("Geolocation unsupported", "err"); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    cfg.lat = +pos.coords.latitude.toFixed(5);
    cfg.lon = +pos.coords.longitude.toFixed(5);
    cfg.locName = "you are here";
    saveConfig();
    updateLocChip();
    if (close) closeSettings();
    setStatus("location set", "ok");
    refreshAll();
  }, err => setStatus(`Location error: ${err.message}`, "err"));
}

// ---- Boot ----------------------------------------------------------------

// Ask /api/region whether the current coordinates are inside Portugal. Hides
// the Portugal-only widgets (trains, incidents, warnings) when they aren't.
async function detectRegion() {
  try {
    const { data } = await apiGet("region", { lat: cfg.lat, lon: cfg.lon });
    outsidePT = data.in_pt === false;
    applyWidgetVisibility();
  } catch { /* keep previous state */ }
}

function refreshAll() {  if (widgetVisible("weather")) loadWeather();
  if (widgetVisible("forecast")) loadForecast();
  if (widgetVisible("incidents") && !outsidePT) loadIncidents();
  if (widgetVisible("warnings") && !outsidePT) loadWarnings();
  if (widgetVisible("trains") && !outsidePT) loadTrains();
  if (widgetVisible("flights")) loadFlights();
  if (widgetVisible("solar")) loadSolar();
  if (widgetVisible("sunmoon")) loadMoon();
  if (widgetVisible("radiation")) loadRadiation();
  if (widgetVisible("airquality")) loadAirQuality();
  if (widgetVisible("astro")) loadAstro();
  if (widgetVisible("uptime")) loadUptime();

  if (widgetVisible("lightning")) loadLightning();
  if (widgetVisible("satellites")) loadSatellites();
  if (widgetVisible("ren")) loadRen();
  if (widgetVisible("seismic")) loadSeismic();
  if (widgetVisible("fuel")) loadFuel();
  if (widgetVisible("fx")) loadFx();
  if (widgetVisible("psi")) loadPsi();
   if (widgetVisible("system")) loadSystem();
   if (widgetVisible("propagation")) loadPropagation();
}

function refreshIntervalMs() {
  return (D.refreshMs ?? 60000);
}

// ---- Station search (mirrors the firmware's /api/stations) --------------

async function searchStations() {
  const q = document.getElementById("cfg-station-q").value.trim();
  const box = document.getElementById("station-results");
  if (!q) { box.innerHTML = `<span class="hint">type a station name first</span>`; return; }
  box.innerHTML = `<span class="hint">searching…</span>`;
  try {
    const { data } = await apiGet("stations", { q });
    const arr = data.stations || [];
    if (!arr.length) {
      box.innerHTML = `<span class="hint">no matches — try accents, e.g. Campanhã</span>`;
      return;
    }
    box.innerHTML = "";
    arr.forEach(s => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stn";
      b.textContent = `${s.name} [${s.id}]`;
      b.onclick = () => {
        document.getElementById("cfg-station").value = s.id;
        document.getElementById("cfg-station-name").value = s.name;
        box.innerHTML = `<span class="hint">selected ${s.name} [${s.id}] — click Save</span>`;
      };
      box.appendChild(b);
    });
  } catch (e) {
    box.innerHTML = `<span class="hint">search failed: ${e.message}</span>`;
  }
}

function clearStation() {
  document.getElementById("cfg-station").value = "";
  document.getElementById("cfg-station-name").value = "";
  document.getElementById("cfg-station-q").value = "";
  document.getElementById("station-results").innerHTML = "";
}

// Tooltip system: show/hide #tip on elements with data-tip attribute.
function initTooltips() {
  const tip = document.getElementById("tip");
  if (!tip) return;
  document.addEventListener("mouseover", e => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    tip.textContent = el.dataset.tip;
    tip.classList.remove("hidden");
    positionTip(e.clientX, e.clientY);
  });
  document.addEventListener("mouseout", e => {
    if (e.target.closest && e.target.closest("[data-tip]")) {
      document.getElementById("tip").classList.add("hidden");
    }
  });
  document.addEventListener("mousemove", e => {
    if (!document.getElementById("tip").classList.contains("hidden")) {
      positionTip(e.clientX, e.clientY);
    }
  });
}
function positionTip(x, y) {
  const tip = document.getElementById("tip");
  const winW = window.innerWidth, winH = window.innerHeight;
  const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
  // Tip is position:fixed, so position with viewport coords (clientX/Y).
  // Account for scroll so it stays glued to the cursor regardless of scroll.
  let left = x + 12;
  let top = y + 12;
  if (left + tipW > winW) left = x - tipW - 12;
  if (top + tipH > winH) top = y - tipH - 12;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// Wire up events and init tooltip system.
function wireEvents() {
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("close-settings-btn").addEventListener("click", closeSettings);
  document.getElementById("settings-scrim").addEventListener("click", closeSettings);
  document.getElementById("save-btn").addEventListener("click", saveSettings);
  document.getElementById("cancel-btn").addEventListener("click", closeSettings);
  document.getElementById("loc-btn").addEventListener("click", useMyLocation);
  document.getElementById("search-station-btn").addEventListener("click", searchStations);
  document.getElementById("clear-station-btn").addEventListener("click", clearStation);
  document.getElementById("cfg-station-q").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); searchStations(); }
  });
  // Delegated: handles both static sections and dynamically created clock rows.
  document.getElementById("settings-panel").addEventListener("change", e => {
    // Master "All clocks" switch: apply live + force small-clock rows off/on.
    if (e.target.id === "cfg-clocks-all") {
      cfg.clocksAll = e.target.checked;
      applyWidgetVisibility();
      document.querySelectorAll(".clk-row").forEach(row => {
        const t = row.querySelector(".w-toggle");
        const on = e.target.checked && widgetVisible(t?.dataset.widget);
        if (t) t.checked = on;
        row.classList.toggle("on", on);
      });
      return;
    }
    const toggle = e.target.closest(".w-toggle");
    if (toggle) setWidgetSection(toggle.dataset.widget, toggle.checked);
  });
  document.getElementById("add-clock-btn").addEventListener("click", addClockRow);
  document.getElementById("small-clock-configs").addEventListener("click", e => {
    const rm = e.target.closest(".clk-rm");
    if (rm) removeClockRow(rm.closest(".clk-row"));
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("settings-panel").classList.contains("hidden")) {
      closeSettings();
    }
  });
  // Unit converters — persist the choice and re-render widgets with the new unit.
  const bindUnit = (id, key) => {
    document.getElementById(id).addEventListener('change', (e) => {
      cfg.units = { ...cfg.units, [key]: e.target.value };
      saveConfig();
      refreshAll();
    });
  };
  bindUnit('cfg-temp-unit', 'temperature');
  bindUnit('cfg-wind-unit', 'wind');
  bindUnit('cfg-dist-unit', 'distance');
  bindUnit('cfg-pressure-unit', 'pressure');
  initTooltips();
}

loadConfig();
wireEvents();
setStatus("loading…");
const bootFrac = synodicFraction(new Date());
document.getElementById("moon-phase").innerHTML = moonDisc(bootFrac);
document.getElementById("moon-label").textContent = describeMoon(bootFrac);
renderClockCards();
applyCardOrder();
injectDragHandles();
applyWidgetVisibility();
updateSmallClocks();
initCardDrag();
detectRegion();
refreshAll();
setInterval(() => { refreshAll(); }, refreshIntervalMs());
setInterval(tick, 1000);

// Ask the browser for a precise location so flights/weather use where you are.
if ("geolocation" in navigator) {
  navigator.geolocation.getCurrentPosition(pos => {
    cfg.lat = +pos.coords.latitude.toFixed(5);
    cfg.lon = +pos.coords.longitude.toFixed(5);
    cfg.locName = "you are here";
    saveConfig();
    updateLocChip();
    detectRegion();
    refreshAll();
  }, () => { /* user denied or unavailable — keep defaults */ }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}
