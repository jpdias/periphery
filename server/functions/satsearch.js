import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson } from "./utils.js";
import {
  twoline2satrec,
  propagate,
  eciToEcf,
  ecfToLookAngles,
  degreesToRadians,
  radiansToDegrees,
  gstime,
} from "satellite.js";

// Returns satellites currently overhead at the observer's position.
// Fetches TLEs for a curated set of bright/interesting satellites from
// tle.ivanstanojevic.me (free, no key), propagates with SGP4, and returns
// those with elevation > 0, sorted by highest elevation first.

const TLE_API = "https://tle.ivanstanojevic.me/api/tle";

const INTERESTING = [
  { id: "25544", name: "ISS" },
  { id: "48274", name: "Tiangong" },
  { id: "20580", name: "Hubble" },
  { id: "43013", name: "Starlink-1130" },
  { id: "43014", name: "Starlink-1131" },
  { id: "43015", name: "Starlink-1132" },
  { id: "52690", name: "Starlink-4292" },
  { id: "52691", name: "Starlink-4293" },
  { id: "52692", name: "Starlink-4294" },
  { id: "28654", name: "NOAA 18" },
  { id: "33591", name: "NOAA 19" },
  { id: "28651", name: "METOP-B" },
  { id: "40014", name: "GOES-16" },
  { id: "40015", name: "GOES-17" },
  { id: "54216", name: "GOES-18" },
  { id: "49015", name: "Cosmos 2551" },
  { id: "41770", name: "PeruSat-1" },
  { id: "42917", name: "PlanetScope 1646" },
];

function elevationAt(satrec, observerGd, date) {
  const pv = propagate(satrec, date);
  if (!pv.position) return -90;
  const ecf = eciToEcf(pv.position, gstime(date));
  const look = ecfToLookAngles(observerGd, ecf);
  return radiansToDegrees(look.elevation);
}

async function fetchTle(id) {
  try {
    const { status, body } = await upstreamJson(`${TLE_API}/${id}`, { timeoutMs: 4000 });
    if (status === 200 && body && body.line1 && body.line2) {
      return { line1: body.line1, line2: body.line2, name: body.name };
    }
  } catch { /* skip */ }
  return null;
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

  const tles = await Promise.all(INTERESTING.map((s) => fetchTle(s.id).then((t) => ({ ...s, tle: t }))));

  const results = [];
  for (const s of tles) {
    if (!s.tle) continue;
    try {
      const satrec = twoline2satrec(s.tle.line1, s.tle.line2);
      const elev = elevationAt(satrec, observerGd, now);
      if (elev > 0) {
        results.push({ id: s.id, name: s.tle.name || s.name, elev: Math.round(elev) });
      }
    } catch { /* skip */ }
  }

  results.sort((a, b) => b.elev - a.elev);

  return ok({ sats: results }, { ttl: 300 });
}
