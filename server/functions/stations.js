import { handleOptions, ok, fail, requireParams, upstreamJson, rawResponse } from "./utils.js";
import { TRAIN_HOST, TRAIN_PATH, TRAIN_UA } from "./env.js";

// GET /api/stations?q=<name> -> station search proxy for the IP trains API.
// Mirrors the firmware's /api/stations (same-origin proxy for the browser; the
// IP API sends no Access-Control-Allow-Origin). Returns [{id,name}] from the
// upstream "response" array.
export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["q"]);
  if (error) return fail(400, error);

  const url = `https://${TRAIN_HOST}${TRAIN_PATH}/estacao-nome/${encodeURIComponent(params.q)}`;

  const { status, body } = await upstreamJson(url, {
    headers: { "User-Agent": TRAIN_UA, Accept: "application/json" },
  });
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream station search failed", { upstreamStatus: status });
  }

  const stations = [];
  const resp = body.response;
  if (Array.isArray(resp)) {
    for (const s of resp) {
      if (s.NodeID === undefined || s.Nome === undefined) continue;
      stations.push({ id: String(s.NodeID), name: String(s.Nome) });
    }
  }
  return ok({ stations }, { ttl: 3600 });
}
