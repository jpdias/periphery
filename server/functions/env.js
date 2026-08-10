// Central environment config for the Netlify functions — the web analog of the
// firmware's src/env.h. Every URL / token / tunable lives here with a sensible
// default, overridable via Netlify environment variables. Secrets (ArcGIS URL,
// tokens) MUST be set as Netlify env vars, never committed.

export const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

// Browser CORS allowlist: only origins listed here may call the API from a
// browser. Comma-separated Netlify env var. Defaults to the GitHub Pages host.
export const ALLOWED_ORIGIN = env("ALLOWED_ORIGIN", "https://jpdias.me");

// --- Weather / Forecast (open-meteo) ---
export const OPEN_METEO_BASE = env("OPEN_METEO_BASE", "https://api.open-meteo.com");
export const OPEN_METEO_PATH = env("OPEN_METEO_PATH", "/v1/forecast");
export const WEATHER_TTL = Number(env("WEATHER_TTL", "600"));
export const FORECAST_TTL = Number(env("FORECAST_TTL", "600"));
export const FORECAST_DAYS = env("FORECAST_DAYS", "4");

// --- Moon / Sun (NASA JPL Horizons observer RTS ephemeris) ---
export const HORIZONS_BASE = env("HORIZONS_BASE", "https://ssd.jpl.nasa.gov/api/horizons.api");
export const HORIZONS_RTS_STEP = env("HORIZONS_RTS_STEP", "1m TVH");   // rise/transit/set, true visual horizon
export const MOON_TTL = Number(env("MOON_TTL", "86400"));

// --- Incidents (ArcGIS FeatureServer) — org-specific, keep private ---
export const ARC_GIS_URL = process.env.ARC_GIS_URL;              // required, no default
export const ARC_GIS_TOKEN = process.env.ARC_GIS_TOKEN || undefined;
export const INCIDENT_RADIUS_M = Number(env("INCIDENT_RADIUS_M", "20000"));
export const INCIDENT_MAX = Number(env("INCIDENT_MAX", "12"));
export const INCIDENT_TTL = Number(env("INCIDENT_TTL", "300"));

// --- Flights (ADS-B) ---
export const ADSB_BASE = env("ADSB_BASE", "https://opendata.adsb.fi");
export const ADSB_PATH = env("ADSB_PATH", "/api/v2");
export const FLIGHTS_TTL = Number(env("FLIGHTS_TTL", "30"));
export const FLIGHT_DEFAULT_DIST = env("FLIGHT_DEFAULT_DIST", "25");

// --- Trains (Infraestruturas de Portugal) ---
export const TRAIN_HOST = env("TRAIN_HOST", "www.infraestruturasdeportugal.pt");
export const TRAIN_PATH = env("TRAIN_PATH", "/negocios-e-servicos");
export const TRAIN_SVC =
  env("TRAIN_SVC", "INTERNACIONAL,%20ALFA,%20IC,%20IR,%20REGIONAL,%20URB%7CSUBUR,%20ESPECIAL,%20MERCADORIAS,%20SERVI%C3%87O");
export const TRAIN_UA =
  env("TRAIN_UA", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36");
export const TRAIN_TTL = Number(env("TRAIN_TTL", "300"));
export const TRAIN_WINDOW_H = Number(env("TRAIN_WINDOW_H", "3"));

// --- External IP ---
export const IPINFO_BASE = env("IPINFO_BASE", "https://ipinfo.io");
export const IPINFO_PATH = env("IPINFO_PATH", "/json");
export const IPINFO_TOKEN = process.env.IPINFO_TOKEN || undefined;
export const IP_TTL = Number(env("IP_TTL", "3600"));

// --- Solar activity (NOAA SWPC GOES products) ---
export const SWPC_BASE = env("SWPC_BASE", "https://services.swpc.noaa.gov");
export const SOLAR_TTL = Number(env("SOLAR_TTL", "300"));

// --- Radiation + air quality (APA, Portugal: RADNET / QualAr) ---
export const APA_GEO_BASE = env("APA_GEO_BASE", "https://sniambgeoogc.apambiente.pt/getogc/rest/services/Visualizador");
export const RADNET_SERVICE = env("RADNET_SERVICE", "/sirad/MapServer/1");       // gama dose rate in air
export const QAR_SERVICE = env("QAR_SERVICE", "/QAR/MapServer/1");               // IQAR global per station
export const QAR_POLUENTES = env("QAR_POLUENTES", "/QAR/MapServer/0");           // per-pollutant indices
export const RADNET_TTL = Number(env("RADNET_TTL", "600"));
export const AIRQUALITY_TTL = Number(env("AIRQUALITY_TTL", "600"));
export const RADNET_MAX = Number(env("RADNET_MAX", "60"));

// --- Earthquakes (USGS GeoJSON feeds) ---
export const USGS_BASE = env("USGS_BASE", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary");
export const USGS_FEED = env("USGS_FEED", "2.5_day.geojson");                    // mag >= 2.5, last 24h
export const EARTHQUAKE_TTL = Number(env("EARTHQUAKE_TTL", "300"));
export const EARTHQUAKE_MAX = Number(env("EARTHQUAKE_MAX", "8"));

// --- Lightning (Blitzortung via pocketworld.org relay) ---
export const LIGHTNING_BASE = env("LIGHTNING_BASE", "https://pocketworld.org/api/lightning");
export const LIGHTNING_TTL = Number(env("LIGHTNING_TTL", "60"));
export const LIGHTNING_MAX = Number(env("LIGHTNING_MAX", "12"));

// --- Weather warnings (IPMA, Portugal) ---
export const IPMA_BASE = env("IPMA_BASE", "https://api.ipma.pt/open-data");
export const IPMA_WARNINGS_PATH = env("IPMA_WARNINGS_PATH", "/forecast/warnings/warnings_www.json");
export const WARNINGS_TTL = Number(env("WARNINGS_TTL", "300"));

// --- Satellites (Celestrak TLE + satellite.js SGP4) ---
export const CELESTRAK_BASE = env("CELESTRAK_BASE", "https://celestrak.org/NORAD/elements/gp.php");
export const TLE_FALLBACK_BASE = env("TLE_FALLBACK_BASE", "https://tle.ivanstanojevic.me/api/tle");
export const SAT_TTL = Number(env("SAT_TTL", "300"));
export const SAT_DEFAULTS = [
  { id: "25544", name: "ISS" },
  { id: "48274", name: "Tiangong" },
  { id: "20580", name: "Hubble" },
];

// --- National grid (REN Data Hub) ---
export const REN_BASE = env("REN_BASE", "https://servicebus.ren.pt/datahubapi/electricity");
export const REN_TTL = Number(env("REN_TTL", "600"));
export const REN_MAX = Number(env("REN_MAX", "96"));            // 15-min slots in the day

// --- Seismic activity (IPMA) ---
export const IPMA_SEISMIC_PATH = env("IPMA_SEISMIC_PATH", "/observation/seismic/3.json"); // mainland + islands
export const IPMA_SEISMIC_PATH_AZORES = env("IPMA_SEISMIC_PATH_AZORES", "/observation/seismic/7.json");
export const SEISMIC_TTL = Number(env("SEISMIC_TTL", "300"));
export const SEISMIC_MAX = Number(env("SEISMIC_MAX", "10"));

// --- Fuel prices (API Aberta — DGEG data, free, no key) ---
export const APIABERTA_BASE = env("APIABERTA_BASE", "https://api.apiaberta.pt");
export const FUEL_PATH = env("FUEL_PATH", "/v1/fuel/prices");
export const FUEL_TTL = Number(env("FUEL_TTL", "3600"));
export const FUEL_MAX = Number(env("FUEL_MAX", "50"));

// --- Forex (Frankfurter, ECB reference rates, no key) ---
export const FX_BASE = env("FX_BASE", "https://api.frankfurter.dev/v1");
export const FX_TTL = Number(env("FX_TTL", "3600"));
export const FX_SYMBOLS = env("FX_SYMBOLS", "USD,GBP,CHF,JPY,BRL,CNY");

// --- Lisbon stock index (PSI, via Yahoo Finance) ---
export const PSI_BASE = env("PSI_BASE", "https://query1.finance.yahoo.com/v8/finance/chart");
export const PSI_SYMBOL = env("PSI_SYMBOL", "PSI20.LS");
export const PSI_TTL = Number(env("PSI_TTL", "600"));

// --- Upstream fetch defaults (shared) ---
export const UPSTREAM_TIMEOUT_MS = Number(env("UPSTREAM_TIMEOUT_MS", "15000"));
