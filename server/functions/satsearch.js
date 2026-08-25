import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamText } from "./utils.js";
import { CELESTRAK_BASE } from "./env.js";
import {
  twoline2satrec,
  propagate,
  eciToEcf,
  ecfToLookAngles,
  degreesToRadians,
  radiansToDegrees,
  gstime,
} from "satellite.js";

// Returns the top 10 satellites currently overhead at the observer's position.
// Fetches the Celestrak "visual" group TLE batch (fast single request) and
// propagates each satellite to compute the current elevation angle.

const VISUAL_TLE_URL = `${CELESTRAK_BASE}?GROUP=visual&FORMAT=tle`;

function elevationAt(satrec, observerGd, date) {
  const pv = propagate(satrec, date);
  if (!pv.position) return -90;
  const ecf = eciToEcf(pv.position, gstime(date));
  const look = ecfToLookAngles(observerGd, ecf);
  return radiansToDegrees(look.elevation);
}

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const observerGd = {
    longitude: degreesToRadians(lon),
    latitude: degreesToRadians(lat),
    height: 0.1,
  };

  const now = new Date();

  const { status, body } = await upstreamText(VISUAL_TLE_URL, { timeoutMs: 8000 });
  if (status !== 200 || !body) {
    return fail(502, "Failed to fetch TLE data", { upstreamStatus: status });
  }

  const lines = body.split("\n").map((l) => l.trimEnd());
  const results = [];
  for (let i = 0; i < lines.length - 2 && results.length < 10; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!/^[12] /.test(line1) || !/^[12] /.test(line2)) continue;
    try {
      const satrec = twoline2satrec(line1, line2);
      const elev = elevationAt(satrec, observerGd, now);
      if (elev > 0) {
        const idMatch = line1.substring(2, 7).trim();
        results.push({ id: idMatch, name, elev: Math.round(elev) });
      }
    } catch {
      /* skip malformed TLE */
    }
  }

  results.sort((a, b) => b.elev - a.elev);

  return ok({ sats: results }, { ttl: 300 });
}
