import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  requireParams,
  upstreamJson,
  rawResponse,
} from "./utils.js";
import { CELESTRAK_BASE } from "./env.js";

// GET /api/satsearch?q=<name> -> satellite name search proxy for Celestrak.
// Returns [{id, name}] from the upstream gp search results (NORAD catalog
// numbers + object names). Limit to 20 results to keep the payload tiny.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["q"]);
  if (error) return fail(400, error);

  const q = params.q.trim();
  if (q.length < 2) return fail(400, "Query must be at least 2 characters");

  const url = `${CELESTRAK_BASE}?NAME=${encodeURIComponent(q)}&FORMAT=json`;

  const { status, body } = await upstreamJson(url, { timeoutMs: 6000 });
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream satellite search failed", { upstreamStatus: status });
  }

  const sats = [];
  const items = Array.isArray(body) ? body : [];
  const limit = 20;
  for (const s of items) {
    if (sats.length >= limit) break;
    const id = String(s.NORAD_CAT_ID || "");
    const name = String(s.OBJECT_NAME || "").trim();
    if (id && name) sats.push({ id, name });
  }
  return ok({ sats }, { ttl: 86400 });
}
