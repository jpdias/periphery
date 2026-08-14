// Central environment config for the Netlify functions — the web analog of the
// firmware's src/env.h. Tunables (TTLs, paths, limits) keep sensible defaults
// here; every real endpoint URL and token MUST be provided via Netlify
// environment variables (or server/.env for local dev) and never committed —
// see server/.env.example. Set each `process.env.X` below in your site config.

export const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

// Browser CORS allowlist: only origins listed here may call the API from a
// browser. Comma-separated Netlify env var. REQUIRED, no committed default.
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN; // required, no default

// --- Weather / Forecast (open-meteo) ---
export const OPEN_METEO_BASE = process.env.OPEN_METEO_BASE; // required, no default
export const OPEN_METEO_PATH = env("OPEN_METEO_PATH", "/v1/forecast");
export const OPEN_METEO_AQ_BASE = process.env.OPEN_METEO_AQ_BASE; // required, no default
export const OPEN_METEO_AQ_PATH = env("OPEN_METEO_AQ_PATH", "/v1/air-quality");
export const WEATHER_TTL = Number(env("WEATHER_TTL", "600"));
export const FORECAST_TTL = Number(env("FORECAST_TTL", "600"));
export const FORECAST_DAYS = env("FORECAST_DAYS", "4");

// --- Moon / Sun (NASA JPL Horizons observer RTS ephemeris) ---
export const HORIZONS_BASE = process.env.HORIZONS_BASE; // required, no default
export const HORIZONS_RTS_STEP = env("HORIZONS_RTS_STEP", "1m TVH"); // rise/transit/set, true visual horizon
export const MOON_TTL = Number(env("MOON_TTL", "86400"));

// --- Incidents (ArcGIS FeatureServer) — org-specific, keep private ---
export const ARC_GIS_URL = process.env.ARC_GIS_URL; // required, no default
export const ARC_GIS_TOKEN = process.env.ARC_GIS_TOKEN || undefined;
export const INCIDENT_RADIUS_M = Number(env("INCIDENT_RADIUS_M", "20000"));
export const INCIDENT_MAX = Number(env("INCIDENT_MAX", "12"));
export const INCIDENT_TTL = Number(env("INCIDENT_TTL", "300"));

// --- Flights (ADS-B) ---
export const ADSB_BASE = process.env.ADSB_BASE; // required, no default
export const ADSB_PATH = env("ADSB_PATH", "/api/v2");
export const FLIGHTS_TTL = Number(env("FLIGHTS_TTL", "30"));
export const FLIGHT_DEFAULT_DIST = env("FLIGHT_DEFAULT_DIST", "25");

// --- Trains (Infraestruturas de Portugal) ---
export const TRAIN_HOST = process.env.TRAIN_HOST; // required, no default
export const TRAIN_PATH = env("TRAIN_PATH", "/negocios-e-servicos");
export const TRAIN_SVC = env(
  "TRAIN_SVC",
  "INTERNACIONAL,%20ALFA,%20IC,%20IR,%20REGIONAL,%20URB%7CSUBUR,%20ESPECIAL,%20MERCADORIAS,%20SERVI%C3%87O",
);
export const TRAIN_UA = env(
  "TRAIN_UA",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
);
export const TRAIN_TTL = Number(env("TRAIN_TTL", "300"));
export const TRAIN_WINDOW_H = Number(env("TRAIN_WINDOW_H", "3"));

// --- External IP ---
export const IPINFO_BASE = process.env.IPINFO_BASE; // required, no default
export const IPINFO_PATH = env("IPINFO_PATH", "/json");
export const IPINFO_TOKEN = process.env.IPINFO_TOKEN || undefined;
export const IP_TTL = Number(env("IP_TTL", "3600"));

// --- Solar activity (NOAA SWPC GOES products) ---
export const SWPC_BASE = process.env.SWPC_BASE; // required, no default
export const SOLAR_TTL = Number(env("SOLAR_TTL", "300"));

// --- Radiation + air quality (APA, Portugal: RADNET / QualAr) ---
export const APA_GEO_BASE = process.env.APA_GEO_BASE; // required, no default
export const RADNET_SERVICE = env("RADNET_SERVICE", "/sirad/MapServer/1"); // gama dose rate in air
export const QAR_SERVICE = env("QAR_SERVICE", "/QAR/MapServer/1"); // IQAR global per station
export const QAR_POLUENTES = env("QAR_POLUENTES", "/QAR/MapServer/0"); // per-pollutant indices
export const RADNET_TTL = Number(env("RADNET_TTL", "600"));
export const AIRQUALITY_TTL = Number(env("AIRQUALITY_TTL", "600"));
export const RADNET_MAX = Number(env("RADNET_MAX", "60"));
// Safecast: global crowd-sourced gamma radiation (fallback outside Portugal).
export const SAFECAST_BASE = process.env.SAFECAST_BASE; // required, no default
export const SAFECAST_PATH = env("SAFECAST_PATH", "/en-US/measurements.json");
export const SAFECAST_RADIUS_KM = Number(env("SAFECAST_RADIUS_KM", "200"));
export const SAFECAST_MAX = Number(env("SAFECAST_MAX", "50"));
export const SAFECAST_TTL = Number(env("SAFECAST_TTL", "900"));

// --- Earthquakes (USGS GeoJSON feeds) ---
export const USGS_BASE = process.env.USGS_BASE; // required, no default
export const USGS_FEED = env("USGS_FEED", "2.5_day.geojson"); // mag >= 2.5, last 24h
export const EARTHQUAKE_TTL = Number(env("EARTHQUAKE_TTL", "300"));
export const EARTHQUAKE_MAX = Number(env("EARTHQUAKE_MAX", "8"));

// --- Lightning (Blitzortung via pocketworld.org relay) ---
export const LIGHTNING_BASE = process.env.LIGHTNING_BASE; // required, no default
export const LIGHTNING_TTL = Number(env("LIGHTNING_TTL", "60"));
export const LIGHTNING_MAX = Number(env("LIGHTNING_MAX", "12"));

// --- Weather warnings (IPMA, Portugal) ---
export const IPMA_BASE = process.env.IPMA_BASE; // required, no default
export const IPMA_WARNINGS_PATH = env("IPMA_WARNINGS_PATH", "/forecast/warnings/warnings_www.json");
export const WARNINGS_TTL = Number(env("WARNINGS_TTL", "300"));

// --- Satellites (Celestrak TLE + satellite.js SGP4) ---
export const CELESTRAK_BASE = process.env.CELESTRAK_BASE; // required, no default
export const TLE_FALLBACK_BASE = process.env.TLE_FALLBACK_BASE; // required, no default
export const SAT_TTL = Number(env("SAT_TTL", "300"));
export const SAT_DEFAULTS = [
  { id: "25544", name: "ISS" },
  { id: "48274", name: "Tiangong" },
  { id: "20580", name: "Hubble" },
];

// --- National grid (REN Data Hub) ---
export const REN_BASE = process.env.REN_BASE; // required, no default
export const REN_TTL = Number(env("REN_TTL", "600"));
export const REN_MAX = Number(env("REN_MAX", "96")); // 15-min slots in the day

// --- Seismic activity (IPMA, Portugal) ---
export const IPMA_SEISMIC_PATH = env("IPMA_SEISMIC_PATH", "/observation/seismic/3.json"); // mainland + islands
export const IPMA_SEISMIC_PATH_AZORES = env(
  "IPMA_SEISMIC_PATH_AZORES",
  "/observation/seismic/7.json",
);
export const SEISMIC_TTL = Number(env("SEISMIC_TTL", "300"));
export const SEISMIC_MAX = Number(env("SEISMIC_MAX", "10"));
// USGS global feed used as the seismic fallback outside Portugal.
export const SEISMIC_USGS_FEED = env("SEISMIC_USGS_FEED", "all_day.geojson"); // any magnitude, last 24h

// --- Fuel prices (DGEG official portal, free, no key) ---
// Preço médio diário; the portal's own JS calls the /api/PrecoComb/PMD endpoint
// which returns avg, min and max price per fuel type per day. Prices come back
// as strings like "1,8854 €" (comma decimal separator), parsed in fuel.js.
// DGEG_BASE is org-specific — REQUIRED, set as a Netlify env var, never committed.
export const DGEG_BASE = process.env.DGEG_BASE; // required, no default
export const FUEL_PATH = env("FUEL_PATH", "/api/PrecoComb/PMD");
export const FUEL_TTL = Number(env("FUEL_TTL", "3600"));
// DGEG fuel type IDs for the fuels the widget actually shows.
export const FUEL_IDS = {
  gasoline_95: 3201, // Gasolina simples 95
  gasoline_98: 3400, // Gasolina 98
  diesel: 2101, // Gasóleo simples
  diesel_plus: 2105, // Gasóleo especial
  gpl_auto: 1120, // GPL Auto
  gnc_kg: 1143, // GNC (gás natural comprimido) - €/kg
};

// --- Reservoir storage (SNIRH, Portugal — free, no key) ---
// Boletim de armazenamento mensal nas albufeiras. The bulletin is an HTML table
// (one row per month, one column per river basin) giving % of full capacity
// (NPA). It updates monthly; anohi is the start year of the hydrologic year
// (Oct–Sep), so July 2026 lives under anohi=2025. The ArcGIS layer
// Atlas/Atlas_Agua/MapServer/9 gives per-dam coordinates used to order basins
// by proximity to a location.
// SNIRH_BASE and ALBUF_GEOM_URL are org-specific — REQUIRED, set as Netlify env
// vars, never committed.
export const SNIRH_BASE = process.env.SNIRH_BASE; // required, no default
export const ALBUF_PATH = env(
  "ALBUF_PATH",
  "/snirh/_dadossintese/albufeiras/tabelas/tabelageral.php",
);
export const ALBUF_GEOM_URL = process.env.ALBUF_GEOM_URL; // required, no default
export const ALBUF_TTL = Number(env("ALBUF_TTL", "43200"));
export const ALBUF_MAX_YEARS = Number(env("ALBUF_MAX_YEARS", "1"));

// --- Forex (Frankfurter, ECB reference rates, no key) ---
export const FX_BASE = process.env.FX_BASE; // required, no default
export const FX_TTL = Number(env("FX_TTL", "3600"));
export const FX_SYMBOLS = env("FX_SYMBOLS", "USD,GBP,CHF,JPY,BRL,CNY");

// --- Lisbon stock index (PSI, via Yahoo Finance) ---
export const PSI_BASE = process.env.PSI_BASE; // required, no default
export const PSI_SYMBOL = env("PSI_SYMBOL", "PSI20.LS");
export const PSI_TTL = Number(env("PSI_TTL", "600"));

// --- Upstream fetch defaults (shared) ---
export const UPSTREAM_TIMEOUT_MS = Number(env("UPSTREAM_TIMEOUT_MS", "15000"));
