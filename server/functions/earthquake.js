import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, haversineKm } from "./utils.js";
import { USGS_BASE, USGS_FEED, EARTHQUAKE_TTL, EARTHQUAKE_MAX } from "./env.js";

// Recent earthquakes from the USGS GeoJSON feed, filtered to a radius around
// the requested location and sorted by magnitude. Feeds have no CORS and are
// public domain, so this is a thin proxy + geo filter.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  const radius = params.radius !== undefined ? Number(params.radius) : 1500;
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const url = `${USGS_BASE}/${USGS_FEED}`;
  const { status, body } = await upstreamJson(url);
  if (status !== 200 || !body) {
    return fail(502, "Upstream USGS request failed", { upstreamStatus: status });
  }

  const quakes = (body.features || [])
    .map(f => {
      const p = f.properties || {};
      const [lonq, latq, depth] = f.geometry?.coordinates || [];
      return {
        mag: p.mag,
        place: p.place,
        depth_km: Math.round(depth * 10) / 10,
        time: p.time != null ? new Date(p.time).toISOString() : null,
        distance_km: Math.round(haversineKm(lat, lon, latq, lonq)),
      };
    })
    .filter(q => q.mag != null && q.distance_km <= radius)
    .sort((a, b) => b.mag - a.mag)
    .slice(0, EARTHQUAKE_MAX);

  return ok({
    source: "USGS",
    feed: USGS_FEED,
    count: quakes.length,
    radius_km: radius,
    quakes,
  }, { ttl: EARTHQUAKE_TTL });
}
