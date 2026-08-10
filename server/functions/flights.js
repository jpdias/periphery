import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, cachedFetch, rawResponse } from "./utils.js";
import { ADSB_BASE, ADSB_PATH, FLIGHTS_TTL, FLIGHT_DEFAULT_DIST } from "./env.js";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const dist = params.dist ?? FLIGHT_DEFAULT_DIST;
  const url = `${ADSB_BASE}${ADSB_PATH}/lat/${params.lat}/lon/${params.lon}/dist/${dist}`;

  // Raw passthrough: the firmware consumes the upstream adsb.lol body unchanged.
  if (event.headers?.["x-periphery-raw"] === "1") {
    const { status, body } = await upstreamJson(url);
    const raw = rawResponse(event, status, body);
    if (raw) return raw;
    return fail(502, "Upstream flights request failed", { upstreamStatus: status });
  }

  // Cache keyed on the request. Upstream rate-limits (429) are not cached, but
  // a previous good response is served for the TTL while it recovers.
  const data = await cachedFetch(`flights:${params.lat},${params.lon},${dist}`, FLIGHTS_TTL * 1000, async () => {
    const { status, body } = await upstreamJson(url);
    if (status === 200 && body) return body;
    return null;
  });

  if (!data) {
    return fail(502, "Upstream flights request failed");
  }
  return ok(data, { ttl: FLIGHTS_TTL });
}
