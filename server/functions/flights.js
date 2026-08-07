import { handleOptions, ok, fail, requireParams, upstreamJson, rawResponse } from "./utils.js";
import { ADSB_BASE, ADSB_PATH, FLIGHTS_TTL, FLIGHT_DEFAULT_DIST } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const dist = params.dist ?? FLIGHT_DEFAULT_DIST;
  const url = `${ADSB_BASE}${ADSB_PATH}/lat/${params.lat}/lon/${params.lon}/dist/${dist}`;

  const { status, body } = await upstreamJson(url);
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream flights request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: FLIGHTS_TTL });
}
