import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamText, upstreamJson, toQuery } from "./utils.js";
import { CELESTRAK_BASE, TLE_FALLBACK_BASE, SAT_TTL, SAT_DEFAULTS } from "./env.js";
import {
  twoline2satrec, propagate, eciToEcf, ecfToLookAngles,
  degreesToRadians, radiansToDegrees, gstime,
} from "satellite.js";

// Satellite tracker: fetches TLEs from Celestrak for a configurable NORAD-ID
// list (defaults: ISS, Tiangong, Hubble) and computes the next ground passes
// over the observer using SGP4 (satellite.js). Only overhead passes that reach
// a minimum elevation are reported — a pass is rise..set with a peak elevation.
const MIN_ELEV = 10;        // deg — ignore grazing passes
const WINDOW_H = 48;        // look ahead
const STEP_MS = 60 * 1000;  // propagation step (minute resolution is plenty)

function elevationAt(satrec, observerGd, date) {
  const pv = propagate(satrec, date);
  if (!pv.position) return -90;
  const ecf = eciToEcf(pv.position, gstime(date));
  const look = ecfToLookAngles(observerGd, ecf);
  return radiansToDegrees(look.elevation);
}

function findPasses(satrec, observerGd, start, hours) {
  const steps = Math.round((hours * 3600 * 1000) / STEP_MS);
  const passes = [];
  let cur = null;
  for (let i = 0; i < steps; i++) {
    const d = new Date(start.getTime() + i * STEP_MS);
    const elev = elevationAt(satrec, observerGd, d);
    if (elev >= MIN_ELEV) {
      if (!cur) cur = { rise: d, maxElev: elev, maxTime: d };
      else if (elev > cur.maxElev) { cur.maxElev = elev; cur.maxTime = d; }
    } else if (cur) {
      cur.set = d;
      cur.duration_min = Math.round((cur.set - cur.rise) / 60000);
      passes.push(cur);
      cur = null;
      if (passes.length >= 6) break;
    }
  }
  if (cur) {
    cur.set = new Date(start.getTime() + steps * STEP_MS);
    cur.duration_min = Math.round((cur.set - cur.rise) / 60000);
    passes.push(cur);
  }
  return passes;
}

async function fetchTle(noradId) {
  // Primary: Celestrak gp.php by catalog number. Fallback: TLE API mirror.
  try {
    const q = toQuery({ CATNR: noradId, FORMAT: "TLE" });
    const { status, body } = await upstreamText(`${CELESTRAK_BASE}?${q}`, { timeoutMs: 4000 });
    if (status === 200 && body) {
      const lines = body.split("\n").map(l => l.trimEnd());
      const tle = lines.filter(l => /^[12] /.test(l));
      if (tle.length >= 2) return { line1: tle[0], line2: tle[1] };
    }
  } catch { /* fall through to mirror */ }

  try {
    const { status, body } = await upstreamJson(`${TLE_FALLBACK_BASE}/${noradId}`);
    if (status === 200 && body && body.line1 && body.line2) {
      return { line1: body.line1, line2: body.line2 };
    }
  } catch { /* no TLE available */ }

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

  let sats = SAT_DEFAULTS;
  if (params.sats) {
    try { sats = JSON.parse(params.sats); } catch { return fail(400, "sats must be a JSON array of {id,name}"); }
    if (!Array.isArray(sats) || !sats.length) return fail(400, "sats must be a non-empty JSON array");
  }

  const observerGd = {
    longitude: degreesToRadians(lon),
    latitude: degreesToRadians(lat),
    height: 0.1, // km above ellipsoid
  };

  const now = new Date();
  const results = [];

  await Promise.all(sats.slice(0, 12).map(async s => {
    const tle = await fetchTle(String(s.id));
    if (!tle) {
      results.push({ id: s.id, name: s.name || s.id, error: "no TLE" });
      return;
    }
    const satrec = twoline2satrec(tle.line1, tle.line2);
    const passes = findPasses(satrec, observerGd, now, WINDOW_H);
    const next = passes.map(p => ({
      rise: p.rise.toISOString(),
      max_elev: Math.round(p.maxElev),
      culmination: p.maxTime.toISOString(),
      set: p.set.toISOString(),
      duration_min: p.duration_min,
    }));
    results.push({
      id: s.id,
      name: s.name || s.id,
      next: next[0] || null,
      passes: next.slice(0, 3),
    });
  }));

  results.sort((a, b) => {
    if (a.next && b.next) return a.next.rise.localeCompare(b.next.rise);
    return a.next ? -1 : b.next ? 1 : 0;
  });

  // Smart TTL: the computed passes only go stale once the next one has ended,
  // so cache until the earliest upcoming pass sets (clamped 1 min - 12 h).
  let ttl = SAT_TTL;
  let nextSet = Infinity;
  for (const s of results) {
    if (s.next && s.next.set) {
      const t = Date.parse(s.next.set);
      if (isFinite(t) && t < nextSet) nextSet = t;
    }
  }
  if (isFinite(nextSet)) {
    const secs = Math.round((nextSet - Date.now()) / 1000);
    ttl = Math.max(60, Math.min(secs, 12 * 3600));
  }

  return ok({
    source: "Celestrak + SGP4",
    observer: { lat, lon },
    min_elev: MIN_ELEV,
    window_h: WINDOW_H,
    satellites: results,
  }, { ttl });
}
