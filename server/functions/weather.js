import { handleOptions, ok, fail, requireParams, upstreamJson, toQuery, rawResponse } from "./utils.js";
import { OPEN_METEO_BASE, OPEN_METEO_PATH, WEATHER_TTL } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const q = toQuery({
    latitude: params.lat,
    longitude: params.lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility",
    daily: "sunrise,sunset,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,precipitation_probability_max",
    forecast_days: 1,
    timezone: "auto",
  });

  const { status, body } = await upstreamJson(`${OPEN_METEO_BASE}${OPEN_METEO_PATH}?${q}`);
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream weather request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: WEATHER_TTL });
}
