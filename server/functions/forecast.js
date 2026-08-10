import { handleOptions, ok, fail, requireParams, upstreamJson, haversineKm, isInPortugal, toQuery } from "./utils.js";
import { IPMA_BASE, OPEN_METEO_BASE, OPEN_METEO_PATH, FORECAST_TTL } from "./env.js";

// Daily forecast. Inside Portugal we use IPMA open-data (nearest city, plus UV
// and weather-type tables). Outside Portugal we fall back to the generic
// Open-Meteo daily forecast so the widget still works anywhere in the world.
const IPMA_DAILY_PATH = "/forecast/meteorology/cities/daily/hp-daily-forecast-day";
const IPMA_UV_PATH = "/forecast/meteorology/uv/uv.json";
const IPMA_WEATHER_TYPE_PATH = "/weather-type-classe.json";
const IPMA_WIND_PATH = "/wind-speed-daily-classe.json";

const MAX_DAYS = 3; // IPMA only publishes day0..day2

// Open-Meteo WMO weather_code -> forecast icon key (mirrors WMO in app.js).
const WMO_ICON = {
  0: "sun", 1: "sun", 2: "sun-cloud", 3: "cloud",
  45: "fog", 48: "fog", 51: "drizzle", 53: "drizzle", 55: "drizzle",
  56: "drizzle", 57: "drizzle", 61: "rain", 63: "rain", 65: "rain",
  66: "rain", 67: "rain", 71: "snow", 73: "snow", 75: "snow",
  77: "snow", 80: "showers", 81: "rain", 82: "storm", 85: "snow",
  86: "snow", 95: "storm", 96: "storm", 99: "storm",
};

const WMO_TEXT = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
  55: "Dense drizzle", 56: "Freezing drizzle", 57: "Dense freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
  67: "Heavy freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Light showers", 81: "Showers", 82: "Violent showers",
  85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm",
  96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

// Degrees (0–360) -> compass point, e.g. 328 -> "NW".
function degToCompass(deg) {
  if (deg == null || !isFinite(deg)) return null;
  const pts = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return pts[Math.round(deg / 45) % 8];
}

// Generic fallback: Open-Meteo daily forecast, shaped like the IPMA response so
// the client can render either source unchanged.
async function fallbackOpenMeteo(lat, lon) {
  const q = toQuery({
    latitude: lat,
    longitude: lon,
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,wind_direction_10m_dominant",
    forecast_days: 3,
    timezone: "auto",
  });
  const { status, body } = await upstreamJson(`${OPEN_METEO_BASE}${OPEN_METEO_PATH}?${q}`);
  if (status !== 200 || !body?.daily) {
    return fail(502, "Upstream forecast request failed", { upstreamStatus: status });
  }
  const d = body.daily;
  const days = (d.time || []).map((date, i) => {
    const code = d.weather_code?.[i] ?? 3;
    return {
      date,
      t_min: d.temperature_2m_min?.[i] ?? null,
      t_max: d.temperature_2m_max?.[i] ?? null,
      precip_prob: d.precipitation_probability_max?.[i] ?? null,
      wind_dir: degToCompass(d.wind_direction_10m_dominant?.[i]),
      wind_class: null,
      weather_type_id: code,
      weather_type: WMO_TEXT[code] || "—",
      weather_type_pt: WMO_TEXT[code] || "—",
      weather_icon: WMO_ICON[code] || "cloud",
      uv: d.uv_index_max?.[i] ?? null,
    };
  });
  return ok({
    source: "Open-Meteo",
    city: { global_id: null, distance_km: 0, lat, lon },
    days,
  }, { ttl: FORECAST_TTL });
}

// idWeatherType -> svg icon key (see svgIcon() in app.js).
const WTYPE_ICON = {
  1: "sun", 2: "sun-cloud", 3: "sun-cloud", 4: "cloud", 5: "cloud",
  6: "rain", 7: "showers", 8: "rain", 9: "rain", 10: "drizzle",
  11: "rain", 12: "rain", 13: "drizzle", 14: "rain", 15: "drizzle",
  16: "fog", 17: "fog", 18: "snow", 19: "storm", 20: "storm",
  21: "rain", 22: "fog", 23: "storm",
};

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  // Outside Portugal: use the generic Open-Meteo daily forecast.
  if (!isInPortugal(lat, lon)) {
    return fallbackOpenMeteo(lat, lon);
  }

  // Load all days, the weather-type table and wind-speed classes in parallel.
  const days = await Promise.all(
    Array.from({ length: MAX_DAYS }, (_, i) =>
      upstreamJson(`${IPMA_BASE}${IPMA_DAILY_PATH}${i}.json`))
  );
  const uvRes = await upstreamJson(`${IPMA_BASE}${IPMA_UV_PATH}`);
  const wtRes = await upstreamJson(`${IPMA_BASE}${IPMA_WEATHER_TYPE_PATH}`);
  const windRes = await upstreamJson(`${IPMA_BASE}${IPMA_WIND_PATH}`);

  const weatherTypes = {};
  for (const t of wtRes.body?.data || []) {
    weatherTypes[t.idWeatherType] = {
      en: t.descWeatherTypeEN || "—",
      pt: t.descWeatherTypePT || "—",
      icon: WTYPE_ICON[t.idWeatherType] || "cloud",
    };
  }
  const windClasses = {};
  for (const w of windRes.body?.data || []) {
    if (w.classWindSpeed !== "-99" && w.descClassWindSpeedDailyEN) {
      windClasses[w.classWindSpeed] = w.descClassWindSpeedDailyEN;
    }
  }

  // UV rows are per (date, city) and may repeat by period; take the daily max.
  const uvMax = {};
  for (const r of uvRes.body || []) {
    const uv = Number(r.iUv);
    if (!isFinite(uv)) continue;
    const key = `${r.data}|${r.globalIdLocal}`;
    uvMax[key] = Math.max(uvMax[key] ?? 0, uv);
  }

  // Pick the city closest to the observer using day0's city grid.
  const day0 = days[0];
  if (day0.status !== 200 || !day0.body?.data?.length) {
    return fail(502, "IPMA forecast request failed", { upstreamStatus: day0.status });
  }
  let city = null, bestDist = Infinity;
  for (const c of day0.body.data) {
    const d = haversineKm(lat, lon, Number(c.latitude), Number(c.longitude));
    if (d < bestDist) { bestDist = d; city = c; }
  }
  if (!city) return fail(502, "No IPMA forecast city found");

  const daysOut = [];
  for (let i = 0; i < MAX_DAYS; i++) {
    const res = days[i];
    if (res.status !== 200 || !res.body?.data) continue;
    const row = res.body.data.find(c => c.globalIdLocal === city.globalIdLocal);
    if (!row) continue;
    const date = res.body.forecastDate || res.body.dataPrev || null;
    const wt = weatherTypes[row.idWeatherType] || { en: "—", pt: "—", icon: "cloud" };
    daysOut.push({
      date,
      t_min: row.tMin,
      t_max: row.tMax,
      precip_prob: row.precipitaProb != null ? Number(row.precipitaProb) : null,
      wind_dir: row.predWindDir || null,
      wind_class: windClasses[row.classWindSpeed] || null,
      weather_type_id: row.idWeatherType,
      weather_type: wt.en,
      weather_type_pt: wt.pt,
      weather_icon: wt.icon,
      uv: uvMax[`${date}|${city.globalIdLocal}`] ?? null,
    });
  }

  return ok({
    source: "IPMA",
    city: {
      global_id: city.globalIdLocal,
      distance_km: Math.round(bestDist),
      lat: Number(city.latitude),
      lon: Number(city.longitude),
    },
    days: daysOut,
  }, { ttl: FORECAST_TTL });
}
