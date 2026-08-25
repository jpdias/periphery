import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  requireParams,
  upstreamText,
} from "./utils.js";
import { CELESTRAK_BASE } from "./env.js";

// GET /api/satsearch?q=<name> -> satellite name search proxy for Celestrak.
// Fetches TLE format (compact) and extracts NORAD catalog number + name.
// Returns [{id, name}] capped at 20 results.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["q"]);
  if (error) return fail(400, error);

  const q = params.q.trim();
  if (q.length < 2) return fail(400, "Query must be at least 2 characters");

  const url = `${CELESTRAK_BASE}?NAME=${encodeURIComponent(q)}&FORMAT=tle`;

  const { status, body } = await upstreamText(url, { timeoutMs: 8000 });
  if (status !== 200 || !body) {
    return fail(502, "Upstream satellite search failed", { upstreamStatus: status });
  }

  const lines = body.split("\n").map((l) => l.trimEnd());
  const sats = [];
  for (let i = 0; i < lines.length && sats.length < 20; i++) {
    if (/^[12] /.test(lines[i]) && i > 0) {
      const name = lines[i - 1].trim();
      const catnr = lines[i].substring(2, 7).trim();
      if (name && catnr) sats.push({ id: catnr, name });
    }
  }
  return ok({ sats }, { ttl: 86400 });
}
