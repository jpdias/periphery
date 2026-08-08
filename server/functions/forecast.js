import { handleOptions, ok, fail, requireParams, upstreamJson, haversineKm } from "./utils.js";
import { IPMA_BASE, FORECAST_TTL } from "./env.js";

// Daily forecast for Portugal from IPMA open-data. The hp-daily-forecast-dayN
// feeds return a row per city for each day (day0 = today, day2 = +2). We pick
// the nearest city to the observer, join UV (forecast/meteorology/uv/uv.json),
// and map weather-type + wind-speed class ids to friendly labels.
const IPMA_DAILY_PATH = "/forecast/meteorology/cities/daily/hp-daily-forecast-day";
const IPMA_UV_PATH = "/forecast/meteorology/uv/uv.json";
const IPMA_WEATHER_TYPE_PATH = "/weather-type-classe.json";
const IPMA_WIND_PATH = "/wind-speed-daily-classe.json";

const MAX_DAYS = 3; // IPMA only publishes day0..day2

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
