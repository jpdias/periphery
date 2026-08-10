import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamText, rawResponse } from "./utils.js";
import { HORIZONS_BASE, HORIZONS_RTS_STEP, MOON_TTL } from "./env.js";

// Sun + Moon rise/transit/set from the NASA JPL Horizons observer ephemeris
// (the authoritative DE441 solution). We request the RTS-only table for the Sun
// (COMMAND='10') and Moon (COMMAND='301') as seen from the given coordinates,
// with illumination (quantity 10) so the moon phase glyph works. Times come back
// in UT; the frontend converts them to the viewer's local timezone.
//
// A 3-day window is requested so rise/set events near local midnight are not
// missed regardless of the viewer's timezone offset.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SUN_CMD = "10";     // Sun center
const MOON_CMD = "301";   // Moon center

function isoFromHorizons(dateStr, timeStr) {
  // dateStr like "2026-Aug-07", timeStr like "05:36"
  const [, y, mon, d] = /^(\d{4})-(\w{3})-(\d{2})$/.exec(dateStr) || [];
  if (!y) return null;
  const m = String(MONTHS.indexOf(mon) + 1).padStart(2, "0");
  return `${y}-${m}-${d}T${timeStr}:00Z`;
}

// Parse the RTS table (text between $$SOE / $$EOE). Each row looks like:
//   " 2026-Aug-07 05:36 *r  136.85449  16.51112  100.00000"
// The 3rd field's last char is the event type: r=rise, t=transit, s=set.
// If QUANTITIES includes 10, the last numeric field is % illumination.
function parseRts(text, wantIllum) {
  const events = [];
  let inBody = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.includes("$$SOE")) { inBody = true; continue; }
    if (line.includes("$$EOE")) break;
    if (!inBody) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [, , marker] = parts;
    const type = marker[marker.length - 1];
    if (type !== "r" && type !== "t" && type !== "s") continue;
    const ev = { type, time: isoFromHorizons(parts[0], parts[1]) };
    if (ev.time && wantIllum && parts.length >= 6) {
      ev.illum = parseFloat(parts[5]);
    }
    events.push(ev);
  }
  return events;
}

// Map % illumination + whether we are before/after full moon to a 0..1 phase
// fraction (0/1 = new, 0.5 = full) and a friendly name.
function phaseFromIllum(illum, illumPrev) {
  const f = Math.max(0, Math.min(100, illum)) / 100;
  const frac = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * f))) / (2 * Math.PI);
  const waning = illumPrev !== undefined && illum < illumPrev;
  const p = waning ? 1 - frac : frac;
  const names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
                 "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
  const idx = Math.round(p * 8) % 8;
  return { phase: p, name: names[idx] };
}

async function rtsFor(cmd, siteCoord, start, stop) {
  const params = new URLSearchParams({
    format: "text",
    COMMAND: `'${cmd}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@399'",
    COORD_TYPE: "'GEODETIC'",
    SITE_COORD: `'${siteCoord}'`,
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: `'${HORIZONS_RTS_STEP}'`,
    QUANTITIES: "'1,10'",
    ANG_FORMAT: "'DEG'",
    EXTRA_PREC: "'NO'",
    CSV_FORMAT: "'NO'",
    R_T_S_ONLY: "'YES'",
  });
  const url = `${HORIZONS_BASE}?${params.toString()}`;
  const { status, body } = await upstreamText(url);
  if (status !== 200 || !body) return null;
  return body;
}

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  // Reference date (UTC) for the 3-day window; callers may pass their local date.
  const date = params.date || new Date().toISOString().slice(0, 10);
  const d = new Date(`${date}T00:00:00Z`);
  const start = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 3);
  const stop = d.toISOString().slice(0, 10);
  const siteCoord = `${Number(params.lon).toFixed(4)},${Number(params.lat).toFixed(4)},0`;

  const [sunText, moonText] = await Promise.all([
    rtsFor(SUN_CMD, siteCoord, start, stop),
    rtsFor(MOON_CMD, siteCoord, start, stop),
  ]);

  if (!sunText || !moonText) {
    return fail(502, "Upstream Horizons request failed");
  }

  const sun = parseRts(sunText, false);
  const moon = parseRts(moonText, true);

  // First event of each type across the window; on no-rise days the moon has none.
  const first = (arr, type) => {
    const e = arr.find(x => x.type === type);
    return e ? e.time : null;
  };
  const data = {
    date,
    source: "NASA JPL Horizons",
    sunrise: first(sun, "r"),
    sunset: first(sun, "s"),
    solar_noon: first(sun, "t"),
    moonrise: first(moon, "r"),
    moonset: first(moon, "s"),
    moon_transit: first(moon, "t"),
    moon_illumination: moon.find(x => x.type === "t")?.illum ?? moon.find(x => x.type === "r")?.illum ?? null,
    sun_events: sun,
    moon_events: moon,
  };

  // Moon phase: use illumination trend across consecutive transit events to pick
  // waxing/waning; fall back to a date-based estimate if unavailable.
  const transits = moon.filter(x => x.type === "t");
  if (data.moon_illumination != null) {
    const prev = transits[0]?.illum;
    const cur = transits[1]?.illum ?? transits[0]?.illum;
    const { phase, name } = phaseFromIllum(cur, prev);
    data.moon_phase = phase;
    data.moon_phase_name = name;
  }

  const raw = rawResponse(event, 200, data);
  if (raw) return raw;
  return ok(data, { ttl: MOON_TTL });
}
