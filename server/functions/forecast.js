import { handleOptions, ok, fail, requireParams, upstreamJson, toQuery, rawResponse } from "./utils.js";
import { OPEN_METEO_BASE, OPEN_METEO_PATH, FORECAST_TTL, FORECAST_DAYS } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const q = toQuery({
    latitude: params.lat,
    longitude: params.lon,
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    forecast_days: FORECAST_DAYS,
    timezone: "auto",
  });

  const { status, body } = await upstreamJson(`${OPEN_METEO_BASE}${OPEN_METEO_PATH}?${q}`);
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream forecast request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: FORECAST_TTL });
}
