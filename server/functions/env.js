// Central environment config for the Netlify functions — the web analog of the
// firmware's src/env.h. Every URL / token / tunable lives here with a sensible
// default, overridable via Netlify environment variables. Secrets (ArcGIS URL,
// tokens) MUST be set as Netlify env vars, never committed.

export const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

// --- Weather / Forecast (open-meteo) ---
export const OPEN_METEO_BASE = env("OPEN_METEO_BASE", "https://api.open-meteo.com");
export const OPEN_METEO_PATH = env("OPEN_METEO_PATH", "/v1/forecast");
export const WEATHER_TTL = Number(env("WEATHER_TTL", "600"));
export const FORECAST_TTL = Number(env("FORECAST_TTL", "600"));
export const FORECAST_DAYS = env("FORECAST_DAYS", "4");

// --- Moon / Sun (sunrise-sunset.org) ---
export const SUNRISE_SUNSET_BASE = env("SUNRISE_SUNSET_BASE", "https://api.sunrise-sunset.org");
export const SUNRISE_SUNSET_PATH = env("SUNRISE_SUNSET_PATH", "/v2");
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

// --- Upstream fetch defaults (shared) ---
export const UPSTREAM_TIMEOUT_MS = Number(env("UPSTREAM_TIMEOUT_MS", "15000"));
