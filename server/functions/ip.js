import { normalizeEvent, handleOptions, ok, fail, upstreamJson, rawResponse } from "./utils.js";
import { IPINFO_BASE, IPINFO_PATH, IPINFO_TOKEN, IP_TTL } from "./env.js";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const url = IPINFO_TOKEN
    ? `${IPINFO_BASE}${IPINFO_PATH}?token=${IPINFO_TOKEN}`
    : `${IPINFO_BASE}${IPINFO_PATH}`;

  const { status, body } = await upstreamJson(url);
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream ip request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: IP_TTL });
}
