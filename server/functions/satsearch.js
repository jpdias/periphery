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
// Fetches TLEs for known bright satellites from tle.ivanstanojevic.me
// (free, no key), propagates each with SGP4, and returns those with
// elevation > 0, sorted highest first.

const TLE_API = "https://tle.ivanstanojevic.me/api/tle";

// Curated list of bright / interesting satellites (ISS, stations, weather,
// Starlink constellation). More sats = higher chance of overhead ones.
const SAT_IDS = [
  "25544",
  "48274",
  "20580", // ISS, Tiangong, Hubble
  "28654",
  "33591",
  "43013",
  "28651", // NOAA 18/19, NOAA 20, MetOp-B
  "54216", // CSS Mengtian
  "44713",
  "44914",
  "44724",
  "44718",
  "44714", // Starlink
  "49141",
  "49140",
  "52550",
  "47554",
  "47752", // Starlink
  "52690",
  "52691",
  "52692",
  "59618",
  "58233", // Starlink
  "60197",
  "60061",
  "53550",
  "56704",
  "57463", // Starlink
  "59538",
  "45386",
  "68823",
  "43015",
  "40014", // Starlink, MIRATA
  "41770",
  "42917", // PeruSat, QZS-3
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
    const { status, body } = await upstreamJson(`${TLE_API}/${id}`, { timeoutMs: 5000 });
    if (status === 200 && body && body.line1 && body.line2) return body;
  } catch {
    /* skip */
  }
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

  // Fetch all TLEs in parallel
  const tles = await Promise.all(SAT_IDS.map((id) => fetchTle(id).then((t) => ({ id, tle: t }))));

  const results = [];
  for (const { id, tle } of tles) {
    if (!tle) continue;
    try {
      const satrec = twoline2satrec(tle.line1, tle.line2);
      const elev = elevationAt(satrec, observerGd, now);
      if (elev > 0) {
        results.push({ id, name: tle.name || id, elev: Math.round(elev) });
      }
    } catch {
      /* skip */
    }
  }

  results.sort((a, b) => b.elev - a.elev);

  return ok({ sats: results }, { ttl: 300 });
}
