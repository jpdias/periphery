const STORE_KEY = "minidash-config";

// Defaults externalized in config.js (the client-side analog of env.h).
const D = window.MINIDASH_CONFIG || {};

let cfg = {
  lat: D.defaultLat ?? 41.17,
  lon: D.defaultLon ?? -8.43,
  flightRange: D.defaultFlightRange ?? 25,
  ipStation: "",
  ipStationName: "",
  apiBase: D.apiBase ?? "",
  useApiProxy: D.useApiProxy ?? true,
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
}
function saveConfig() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}

function setStatus(text, cls = "") {
  const el = document.getElementById("status");
  el.classList.remove("ok", "err");
  if (cls) el.classList.add(cls);
  document.getElementById("status-text").textContent = text;
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

// ---- Weather -------------------------------------------------------------

async function loadWeather() {
  try {
    const { data } = await apiGet("weather", { lat: cfg.lat, lon: cfg.lon });
    const cur = data.current;
    document.getElementById("weather-icon").textContent = wmoIcon(cur.weather_code);
    document.getElementById("weather-temp").textContent = `${Math.round(cur.temperature_2m)}°`;
    document.getElementById("weather-sub").innerHTML =
      `<div>${cur.relative_humidity_2m}% humidity</div>` +
      `<div>☀ ${fmtTime(data.daily.sunrise[0])} · ☾ ${fmtTime(data.daily.sunset[0])}</div>`;
  } catch (e) {
    setStatus(e.message, "err");
  }
}

// ---- Forecast ------------------------------------------------------------

const WMO = {
  0: { i: "☀️", t: "Clear" }, 1: { i: "🌤️", t: "Mostly clear" },
  2: { i: "⛅", t: "Partly cloudy" }, 3: { i: "☁️", t: "Overcast" },
  45: { i: "🌫️", t: "Fog" }, 48: { i: "🌫️", t: "Icy fog" },
  51: { i: "🌦️", t: "Drizzle" }, 53: { i: "🌦️", t: "Drizzle" }, 55: { i: "🌦️", t: "Drizzle" },
  61: { i: "🌧️", t: "Rain" }, 63: { i: "🌧️", t: "Rain" }, 65: { i: "🌧️", t: "Heavy rain" },
  66: { i: "🌧️", t: "Freezing rain" }, 67: { i: "🌧️", t: "Freezing rain" },
  71: { i: "❄️", t: "Snow" }, 73: { i: "❄️", t: "Snow" }, 75: { i: "❄️", t: "Heavy snow" },
  77: { i: "❄️", t: "Snow grains" },
  80: { i: "🌦️", t: "Showers" }, 81: { i: "🌦️", t: "Showers" }, 82: { i: "⛈️", t: "Storm" },
  85: { i: "🌨️", t: "Snow showers" }, 86: { i: "🌨️", t: "Snow showers" },
  95: { i: "⛈️", t: "Thunderstorm" },
  96: { i: "⛈️", t: "Hail storm" }, 99: { i: "⛈️", t: "Hail storm" },
};

function wmoIcon(code) { return (WMO[code] || { i: "🌡️" }).i; }
function wmoText(code) { return (WMO[code] || { i: "🌡️", t: "—" }).t; }

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return iso; }
}

async function loadForecast() {
  try {
    const { data } = await apiGet("forecast", { lat: cfg.lat, lon: cfg.lon });
    const d = data.daily;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let html = "";
    for (let i = 0; i < d.time.length; i++) {
      const dt = new Date(d.time[i]);
      html += `<div class="forecast-day">
        <div class="day">${days[dt.getDay()]}</div>
        <div class="ic">${wmoIcon(d.weather_code[i])}</div>
        <div class="lo">${Math.round(d.temperature_2m_min[i])}°</div>
        <div class="hi">${Math.round(d.temperature_2m_max[i])}°</div>
      </div>`;
    }
    document.getElementById("forecast-row").innerHTML = html;
  } catch (e) {
    document.getElementById("forecast-row").innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- Incidents -----------------------------------------------------------

async function loadIncidents() {
  try {
    const { data } = await apiGet("incidents", { lat: cfg.lat, lon: cfg.lon });
    const feats = data.features || [];
    const el = document.getElementById("incident-list");
    const alerts = document.getElementById("incident-alerts");

    if (!feats.length) {
      el.innerHTML = `<div class="empty">No incidents nearby</div>`;
      alerts.innerHTML = "";
      return;
    }
    const count = feats.filter(f => isActive(f.properties.EstadoOcorrencia)).length;
    alerts.innerHTML = count ? `<span class="alert-chip">${count} active</span>` : "";
    el.innerHTML = feats.map(f => {
      const p = f.properties;
      return `<li>
        <span class="con">${esc(p.Concelho || "—")}</span>
        ${esc(p.Natureza || "")} ·
        <span class="when">${esc(p.EstadoOcorrencia || "")}</span>
      </li>`;
    }).join("");
  } catch (e) {
    document.getElementById("incident-list").innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function isActive(estado) {
  const s = (estado || "").toLowerCase();
  return s.includes("chegada") || s.includes("ativa") || s.includes("em curso") || !s;
}

function esc(s) { return s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// ---- Trains --------------------------------------------------------------

function trainWindow() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const start = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const end = new Date(now.getTime() + 3 * 3600 * 1000);
  return {
    date,
    start,
    end: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
  };
}

async function loadTrains() {
  const el = document.getElementById("train-list");
  document.getElementById("train-station").textContent = cfg.ipStationName || "";
  if (!cfg.ipStation) {
    el.innerHTML = `<div class="empty">No train station configured (see settings)</div>`;
    return;
  }
  try {
    const win = trainWindow();
    const { data } = await apiGet("trains", {
      station: cfg.ipStation,
      date: win.date, start: win.start, end: win.end,
    });
    const response = data.response || [];
    const rows = [];
    for (const tbl of response) {
      if ((tbl.TipoPedido | 0) !== 1) continue;
      for (const el2 of (tbl.NodesComboioTabelsPartidasChegadas || [])) {
        if (el2.ComboioPassou) continue;
        const dep = el2.DataHoraPartidaChegada;
        if (!dep) continue;
        rows.push({
          time: dep.slice(11, 16),
          dest: el2.NomeEstacaoDestino || "—",
          num: el2.NComboio1,
          op: el2.Operador || "",
          obs: el2.Observacoes || "",
        });
      }
    }
    rows.sort((a, b) => a.time.localeCompare(b.time));
    const top = rows.slice(0, 5);
    if (!top.length) {
      el.innerHTML = `<div class="empty">No departures in window</div>`;
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
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function parseDelay(obs) {
  const m = /atraso de\s+(\d+)\s*min/.exec(obs || "");
  return m ? parseInt(m[1], 10) : 0;
}

// ---- Flights -------------------------------------------------------------

async function loadFlights() {
  const el = document.getElementById("flight-list");
  try {
    const { data } = await apiGet("flights", {
      lat: cfg.lat, lon: cfg.lon, dist: cfg.flightRange,
    });
    const ac = data.ac || [];
    document.getElementById("flight-count").textContent =
      `${ac.length} aircraft within ${cfg.flightRange}nm`;
    if (!ac.length) {
      el.innerHTML = `<div class="empty">No flights in range</div>`;
      return;
    }
    el.innerHTML = ac.map(a => {
      const alt = a.alt_baro ?? (a.alt_geom ?? "—");
      const spd = a.gs ?? "—";
      const call = a.flight || a.hex;
      return `<li>
        <span class="callsign">${esc(call)}</span>
        ${esc(a.type || a.category || "")}
        <span class="meta">${alt}ft · ${spd}kt</span>
      </li>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

// ---- System / moon -------------------------------------------------------

async function loadSystem() {
  document.getElementById("sys-loc").textContent = `${cfg.lat.toFixed(4)}, ${cfg.lon.toFixed(4)}`;
  try {
    const { data } = await apiGet("ip");
    document.getElementById("sys-ip").textContent = data.ip || "—";
  } catch (e) { document.getElementById("sys-ip").textContent = "—"; }
  document.getElementById("sys-updated").textContent = new Date().toLocaleTimeString();
}

async function loadMoon() {
  try {
    const { data } = await apiGet("moon", { lat: cfg.lat, lon: cfg.lon });
    // rough phase estimate from sunrise/sunset (data has no moon fraction here);
    // fall back to date-based synodic cycle if fields are absent.
    const frac = data.moon_phase ?? synodicFraction(new Date());
    document.getElementById("moon-phase").style.background =
      moonDisc(frac);
  } catch (e) { /* keep default */ }
}

function synodicFraction(d) {
  // Moon age from synodic month (29.53d), known new moon epoch ~2000-01-06 18:14 UTC.
  const epoch = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((d.getTime() - epoch) / 86400000) % 29.530588853;
  return age < 0 ? age + 29.53 : age;
}

function moonDisc(age) {
  const light = Math.min(1, (Math.cos((2 * Math.PI * age) / 29.530588853) + 1) / 2);
  return `radial-gradient(circle at 35% 35%, rgba(248,248,242,${0.4 + 0.6 * light}), rgba(139,136,119,${0.6 * light}))`;
}

// ---- Clock ---------------------------------------------------------------

function tick() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  document.getElementById("clock-time").textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  document.getElementById("clock-date").textContent =
    now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// ---- Settings ------------------------------------------------------------

function openSettings() {
  document.getElementById("cfg-lat").value = cfg.lat;
  document.getElementById("cfg-lon").value = cfg.lon;
  document.getElementById("cfg-range").value = cfg.flightRange;
  document.getElementById("cfg-station").value = cfg.ipStation;
  document.getElementById("cfg-station-name").value = cfg.ipStationName;
  document.getElementById("settings-modal").classList.remove("hidden");
}
function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}
function saveSettings() {
  cfg.lat = parseFloat(document.getElementById("cfg-lat").value) || cfg.lat;
  cfg.lon = parseFloat(document.getElementById("cfg-lon").value) || cfg.lon;
  cfg.flightRange = parseInt(document.getElementById("cfg-range").value, 10) || 25;
  cfg.ipStation = document.getElementById("cfg-station").value.trim();
  cfg.ipStationName = document.getElementById("cfg-station-name").value.trim();
  saveConfig();
  closeSettings();
  setStatus("saved", "ok");
  refreshAll();
}

function useMyLocation() {
  if (!navigator.geolocation) { setStatus("Geolocation unsupported", "err"); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    cfg.lat = +pos.coords.latitude.toFixed(5);
    cfg.lon = +pos.coords.longitude.toFixed(5);
    saveConfig();
    closeSettings();
    setStatus("location set", "ok");
    refreshAll();
  }, err => setStatus(`Location error: ${err.message}`, "err"));
}

// ---- Boot ----------------------------------------------------------------

function refreshAll() {
  tick();
  loadWeather();
  loadForecast();
  loadIncidents();
  loadTrains();
  loadFlights();
  loadMoon();
  loadSystem();
}

function refreshIntervalMs() {
  return (D.refreshMs ?? 60000);
}

function wireEvents() {
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("save-btn").addEventListener("click", saveSettings);
  document.getElementById("cancel-btn").addEventListener("click", closeSettings);
  document.getElementById("loc-btn").addEventListener("click", useMyLocation);
}

loadConfig();
wireEvents();
setStatus("loading…");
refreshAll();
setInterval(() => { refreshAll(); }, refreshIntervalMs());

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}
