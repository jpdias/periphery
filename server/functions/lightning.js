import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, haversineKm, cachedFetch } from "./utils.js";
import { LIGHTNING_BASE, LIGHTNING_TTL, LIGHTNING_MAX } from "./env.js";

// Lightning strikes from Blitzortung (relayed by pocketworld.org). The relay
// returns the ~2000 most recent global strikes; we filter to a radius around
// the requested coordinates and report the nearest few. Direct Blitzortung
// endpoints are ToS-gated, so we rely on the public relay.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  const radius = params.radius !== undefined ? Number(params.radius) : 500;
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const strikes = await cachedFetch(`lightning:${lat},${lon},${radius}`, LIGHTNING_TTL * 1000, async () => {
    try {
      const upstream = await upstreamJson(LIGHTNING_BASE);
      if (upstream.status === 200 && upstream.body) {
        const now = Date.now();
        const list = (upstream.body.strikes || [])
          .map(s => ({
            lat: s.lat,
            lon: s.lng,
            time: s.time || null,
            seconds_ago: s.timestamp ? Math.round((now - s.timestamp * 1000) / 1000) : null,
            polarity: s.polarity,
            distance_km: Math.round(haversineKm(lat, lon, s.lat, s.lng)),
          }))
          .filter(s => s.distance_km <= radius)
          .sort((a, b) => a.distance_km - b.distance_km)
          .slice(0, LIGHTNING_MAX);
        return list.length ? list : null;
      }
      return null;
    } catch {
      return null;
    }
  }, v => Array.isArray(v) && v.length > 0) || [];

  return ok({
    source: "Blitzortung via pocketworld.org",
    count: strikes.length,
    radius_km: radius,
    strikes,
  }, { ttl: LIGHTNING_TTL });
}
