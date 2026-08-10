import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, haversineKm, isInPortugal } from "./utils.js";
import { IPMA_BASE, IPMA_SEISMIC_PATH, IPMA_SEISMIC_PATH_AZORES, USGS_BASE, SEISMIC_USGS_FEED, SEISMIC_TTL, SEISMIC_MAX } from "./env.js";

// Recent seismic activity. Inside Portugal we use IPMA's open-data feeds
// (mainland + Madeira/Azores). Outside Portugal we fall back to the global
// USGS GeoJSON feed so the widget works anywhere in the world.
//   3.json — mainland (+ Madeira/Azores, depending on the day)
//   7.json — Azores
// Both are "last activity" lists, newest first. We merge them, dedupe by
// (lat,lon,time) and sort by time descending, tagging each event with its
// distance from the observer.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  // Outside Portugal: use the global USGS feed instead of IPMA.
  if (!isInPortugal(lat, lon)) {
    return fallbackUSGS(lat, lon);
  }

  const urls = [
    `${IPMA_BASE}${IPMA_SEISMIC_PATH}`,
    `${IPMA_BASE}${IPMA_SEISMIC_PATH_AZORES}`,
  ];
  const results = await Promise.all(urls.map(u => upstreamJson(u)));
  const bad = results.filter(r => r.status !== 200 || !r.body);
  if (bad.length === results.length) {
    return fail(502, "Upstream IPMA seismic request failed", { upstreamStatus: bad[0].status });
  }

  const seen = new Set();
  const events = [];
  for (const { body } of results) {
    if (!body || !Array.isArray(body.data)) continue;
    for (const e of body.data) {
      if (!e || e.magnitud == null || !e.lat || !e.lon) continue;
      const key = `${e.lat}|${e.lon}|${e.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        mag: Number(e.magnitud),
        depth_km: Number(e.depth) || 0,
        region: e.obsRegion || e.local || "—",
        time: e.time || null,
        lat: Number(e.lat),
        lon: Number(e.lon),
        distance_km: Math.round(haversineKm(lat, lon, Number(e.lat), Number(e.lon))),
      });
    }
  }

  events.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  const recent = events.slice(0, SEISMIC_MAX);

  const felt = recent.filter(e => e.mag >= 4.0);
  const biggest = recent.length ? Math.max(...recent.map(e => e.mag)) : null;

  return ok({
    source: "IPMA",
    last_activity: bodyLastActivity(results),
    count: events.length,
    max_mag: biggest,
    felt_count: felt.length,
    events: recent,
  }, { ttl: SEISMIC_TTL });
}

function bodyLastActivity(results) {
  for (const { body } of results) {
    if (body && body.lastSismicActivityDate) return body.lastSismicActivityDate;
  }
  return null;
}

// Global fallback: the USGS all-day GeoJSON feed, shaped like the IPMA response
// so the client can render either source unchanged.
async function fallbackUSGS(lat, lon) {
  const { status, body } = await upstreamJson(`${USGS_BASE}/${SEISMIC_USGS_FEED}`);
  if (status !== 200 || !body) {
    return fail(502, "Upstream USGS seismic request failed", { upstreamStatus: status });
  }

  const events = (body.features || [])
    .map(f => {
      const p = f.properties || {};
      const [elon, elat, depth] = f.geometry?.coordinates || [];
      if (p.mag == null || !isFinite(elat) || !isFinite(elon)) return null;
      return {
        mag: Number(p.mag),
        depth_km: Math.round(Number(depth || 0) * 10) / 10,
        region: p.place || "—",
        time: p.time != null ? new Date(p.time).toISOString() : null,
        lat: Number(elat),
        lon: Number(elon),
        distance_km: Math.round(haversineKm(lat, lon, elat, elon)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, SEISMIC_MAX);

  const felt = events.filter(e => e.mag >= 4.0);
  const biggest = events.length ? Math.max(...events.map(e => e.mag)) : null;

  return ok({
    source: "USGS",
    last_activity: events[0]?.time ?? null,
    count: events.length,
    max_mag: biggest,
    felt_count: felt.length,
    events,
  }, { ttl: SEISMIC_TTL });
}
