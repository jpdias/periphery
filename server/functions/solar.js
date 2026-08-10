import { normalizeEvent, handleOptions, ok, fail, upstreamJson } from "./utils.js";
import { SWPC_BASE, SOLAR_TTL } from "./env.js";

// Solar activity from NOAA SWPC GOES products. When lat/lon are supplied, the
// response also includes location-dependent impact estimates:
//   - is_day + sun_elevation: a flare's radio blackout (R-scale) only affects the
//     sunlit hemisphere, so it matters locally only while the sun is up.
//   - geomagnetic_latitude + aurora: whether the current Kp is strong enough for
//     aurora to reach the user's (dipole-approximated) geomagnetic latitude.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const params = event.queryStringParameters || {};
  const lat = params.lat !== undefined ? Number(params.lat) : NaN;
  const lon = params.lon !== undefined ? Number(params.lon) : NaN;
  const hasLoc = isFinite(lat) && isFinite(lon);

  const urls = [
    `${SWPC_BASE}/json/goes/primary/xray-flares-latest.json`,
    `${SWPC_BASE}/json/goes/primary/xray-background-7-day.json`,
    `${SWPC_BASE}/json/planetary_k_index_1m.json`,
  ];

  const results = await Promise.all(urls.map(u => upstreamJson(u)));
  const bad = results.find(r => r.status !== 200 || !r.body);
  if (bad) {
    return fail(502, "Upstream SWPC request failed", { upstreamStatus: bad.status });
  }

  const [flares, background, kp] = results.map(r => r.body);

  const flare = flares[flares.length - 1] || {};
  const bgEntry = background[background.length - 1] || {};
  const kpEntry = kp[kp.length - 1] || {};
  const kpVal = kpEntry.kp_index ?? kpEntry.estimated_kp ?? 0;
  const cls = flare.current_class || "";

  const data = {
    source: "NOAA SWPC (GOES)",
    updated: kpEntry.time_tag || flare.time_tag || null,
    flare: {
      current_class: cls || null,
      max_class: flare.max_class || null,
      begin_time: flare.begin_time || null,
      max_time: flare.max_time || null,
    },
    background_class: classFromFlux(bgEntry.background),
    kp: {
      index: kpEntry.kp_index ?? null,
      estimated: kpEntry.estimated_kp ?? null,
      label: kpEntry.kp || null,
      time_tag: kpEntry.time_tag || null,
    },
    geomagnetic_storm: kpStormLevel(kpVal),
    flare_storm: flareStormLevel(cls),
  };

  if (hasLoc) {
    const sun = solarPosition(lat, lon, new Date());
    data.location = {
      is_day: sun.elevation > -0.833,      // sun up (incl. refr. horizon)
      sun_elevation: round1(sun.elevation),
      geomagnetic_latitude: round1(geomagneticLat(lat, lon)),
    };
    // Radio blackout only reaches you while the sun is up.
    data.flare_storm.local_impact = sun.elevation > -0.833;
    // Aurora: needs enough Kp AND darkness at your location.
    const needKp = kpForAurora(data.location.geomagnetic_latitude);
    data.aurora = {
      min_kp: needKp,
      visible_now: kpVal >= needKp && sun.elevation < -6,
      chance: auroraChance(kpVal - needKp),
    };
  }

  return ok(data, { ttl: SOLAR_TTL });
}

function round1(v) { return Math.round(v * 10) / 10; }

// Convert X-ray flux (W/m2) to a GOES flare letter class.
function classFromFlux(flux) {
  if (flux == null || !isFinite(flux)) return null;
  const letter = ["A", "B", "C", "M", "X"][Math.min(4, Math.floor(Math.log10(flux) + 7))];
  const mag = flux / Math.pow(10, Math.floor(Math.log10(flux)));
  return `${letter}${mag.toFixed(1)}`;
}

// NOAA G-scale from Kp index (0..9).
function kpStormLevel(kp) {
  if (kp >= 9) return { label: "G5 · Extreme", level: "G5" };
  if (kp >= 8) return { label: "G4 · Severe", level: "G4" };
  if (kp >= 7) return { label: "G3 · Strong", level: "G3" };
  if (kp >= 6) return { label: "G2 · Moderate", level: "G2" };
  if (kp >= 5) return { label: "G1 · Minor", level: "G1" };
  return { label: "Quiet", level: "G0" };
}

// Flare class → R-scale radio blackout category.
function flareStormLevel(cls) {
  const c = (cls || "").trim().toUpperCase();
  if (c.startsWith("X")) return { label: "R3+ · Blackout", level: "R3" };
  if (c.startsWith("M")) return { label: "R1-R2 · Moderate", level: "R2" };
  if (c.startsWith("C")) return { label: "Minor", level: "R0" };
  return { label: "Quiet", level: "R0" };
}

// ---- Location helpers (no external API; enough accuracy for a dashboard) ----

// Solar elevation via the NOAA simplified solar position algorithm.
function solarPosition(lat, lon, date) {
  const rad = Math.PI / 180;
  const doy = dayOfYear(date);
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (utcH - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = 15 * (utcH + lon / 15 - 12) * rad;   // solar time
  const elev = Math.asin(
    Math.sin(lat * rad) * Math.sin(decl) +
    Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle),
  ) / rad;
  return { elevation: elev };
}

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
}

// Geomagnetic latitude via the centered-dipole approximation (north pole at
// ~80.65N, 72.68W for epoch ~2025).
function geomagneticLat(lat, lon) {
  const rad = Math.PI / 180;
  const poleLat = 80.65, poleLon = -72.68;
  const phi = rad * lat, lam = rad * lon;
  const phiP = rad * poleLat, lamP = rad * poleLon;
  const cosColat = Math.sin(phi) * Math.sin(phiP)
    + Math.cos(phi) * Math.cos(phiP) * Math.cos(lam - lamP);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosColat))) / rad;
}

// Approx. minimum Kp for aurora to reach a given geomagnetic latitude
// (fits NOAA's equatorward-boundary table: 66°@Kp1 … 38°@Kp9).
function kpForAurora(glat) {
  return Math.round(Math.max(1, Math.min(9, (66 - glat) / 3.3)));
}

// Chance label given the Kp margin above the local aurora threshold.
function auroraChance(margin) {
  if (margin >= 3) return "Excellent";
  if (margin >= 1) return "Good";
  if (margin >= 0) return "Possible";
  return "No";
}
