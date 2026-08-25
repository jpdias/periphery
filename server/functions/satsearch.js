import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  requireParams,
  upstreamJson,
} from "./utils.js";

// GET /api/satsearch?q=<name> -> satellite name search via tle.ivanstanojevic.me.
// Fast, free, no API key. Returns [{id, name}] capped at 20 results.
const TLE_SEARCH = "https://api.tle.ivanstanojevic.me/api/tle/search";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["q"]);
  if (error) return fail(400, error);

  const q = params.q.trim();
  if (q.length < 2) return fail(400, "Query must be at least 2 characters");

  const url = `${TLE_SEARCH}?query=${encodeURIComponent(q)}&limit=20`;

  const { status, body } = await upstreamJson(url, { timeoutMs: 8000 });
  if (status !== 200 || !body) {
    return fail(502, "Upstream satellite search failed", { upstreamStatus: status });
  }

  const sats = [];
  const items = body.data || [];
  for (const s of items) {
    const id = String(s.satelliteId || "");
    const name = String(s.name || "").trim();
    if (id && name) sats.push({ id, name });
  }
  return ok({ sats }, { ttl: 86400 });
}
