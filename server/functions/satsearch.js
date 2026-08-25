import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  requireParams,
  upstreamJson,
} from "./utils.js";

// GET /api/satsearch?lat=XX&lon=YY -> satellites currently above the observer.
// Uses N2YO's free "above" endpoint (no API key needed for this endpoint).
// Returns [{id, name}] of visible satellites.
const N2YO_ABOVE = "https://api.n2yo.com/rest/v1/satellite/above";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const radius = params.radius || 90;
  const cat = params.cat || 0; // 0 = all categories

  const url = `${N2YO_ABOVE}/${lat}/${lon}/0/${radius}/${cat}`;

  const { status, body } = await upstreamJson(url, { timeoutMs: 8000 });
  if (status !== 200 || !body) {
    return fail(502, "Upstream satellite search failed", { upstreamStatus: status });
  }

  const sats = [];
  const above = body.above || [];
  for (const s of above) {
    if (sats.length >= 10) break;
    const id = String(s.satid || "");
    const name = String(s.satname || "").trim();
    if (id && name) sats.push({ id, name });
  }
  return ok({ sats }, { ttl: 300 });
}
