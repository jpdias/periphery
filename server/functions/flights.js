import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, cachedFetch, rawResponse, rememberGood, staleGood } from "./utils.js";
import { ADSB_BASE, ADSB_FALLBACK_BASE, ADSB_PATH, FLIGHTS_TTL, FLIGHT_DEFAULT_DIST } from "./env.js";

// Try each ADS-B provider in order (primary, then fallback). adsb.lol throttles
// (429) under coincident load; adsb.fi serves the identical /api/v2 schema, so
// ask the next provider instead of failing the device.
export async function aircraftUpstream(lat, lon, dist) {
  for (const base of [ADSB_BASE, ADSB_FALLBACK_BASE]) {
    if (!base) continue;
    const url = `${base}${ADSB_PATH}/lat/${lat}/lon/${lon}/dist/${dist}`;
    const { status, body } = await upstreamJson(url);
    if (status === 200 && body) return { status, body };
  }
  return null;
}

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const dist = params.dist ?? FLIGHT_DEFAULT_DIST;

  // Raw passthrough: the firmware consumes the upstream body unchanged. If every
  // provider is down (e.g. adsb.lol 429 + adsb.fi outage), serve the last healthy
  // body verbatim (stale) so the device never sees a broken 429 HTML/null body.
  if (event.headers?.["x-periphery-raw"] === "1") {
    const cacheKey = `flights:${params.lat},${params.lon},${dist}`;
    const up = await aircraftUpstream(params.lat, params.lon, dist);
    if (up) {
      rememberGood(cacheKey, up.body);
      const raw = rawResponse(event, up.status, up.body);
      if (raw) return raw;
    }
    const stale = staleGood(cacheKey);
    if (stale) return rawResponse(event, 200, stale);
    return fail(502, "Upstream flights request failed", { upstreamStatus: up?.status ?? -1 });
  }

  // Cache keyed on the request. Upstream rate-limits (429) are not cached, but
  // a previous good response is served for the TTL while it recovers.
  const data = await cachedFetch(`flights:${params.lat},${params.lon},${dist}`, FLIGHTS_TTL * 1000, () =>
    aircraftUpstream(params.lat, params.lon, dist).then((up) => (up ? up.body : null))
  );

  if (!data) {
    return fail(502, "Upstream flights request failed");
  }
  return ok(data, { ttl: FLIGHTS_TTL });
}
