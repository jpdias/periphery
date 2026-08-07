import { handleOptions, ok, fail, requireParams, upstreamJson, toQuery, rawResponse } from "./utils.js";
import { SUNRISE_SUNSET_BASE, SUNRISE_SUNSET_PATH, MOON_TTL } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const q = toQuery({ lat: params.lat, lng: params.lon, date: "today", formatted: 0 });

  const { status, body } = await upstreamJson(`${SUNRISE_SUNSET_BASE}${SUNRISE_SUNSET_PATH}?${q}`);
  const raw = rawResponse(event, status, body.results ?? body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream moon request failed", { upstreamStatus: status });
  }
  return ok(body.results ?? body, { ttl: MOON_TTL });
}
