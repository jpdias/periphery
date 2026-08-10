import { normalizeEvent, handleOptions, ok, fail, upstreamJson, cachedFetch, upstreamText } from "./utils.js";
import { SWPC_BASE, SOLAR_TTL } from "./env.js";

// Radio propagation conditions for HF bands, derived from live space weather:
//   - SFI  (10.7 cm solar flux): daily, from SWPC's 30-day flux product. Higher
//     flux → more D/F-layer ionization → higher usable bands open.
//   - A-index + Kp (geomagnetic): disturbance decays HF (especially polar paths).
//   - Dst (Kyoto): ring-current storm index; negative = geomagnetic storm.
//   - Gray-line: around local sunrise/sunset the terminator enhances low-band DX
//     (160/80/40 m), so we flag when the observer is in that window.
// Band "quality" is a rule-of-thumb estimate (NOAA/ham lore), not an exact MUF:
// it's a heuristic dashboard, so treat numbers as guidance.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const lat = Number(event.queryStringParameters?.lat);
  const lon = Number(event.queryStringParameters?.lon);
  const hasLoc = isFinite(lat) && isFinite(lon);

  // --- gather upstream data (cached in-process to limit polling load) ---
  const [fluxRes, kpRes, dstRes, wwv] = await Promise.all([
    cachedFetch("prop:flux30", 3600 * 1000,
      () => upstreamJson(`${SWPC_BASE}/products/10cm-flux-30-day.json`),
      r => r.status === 200),
    cachedFetch("prop:kp", 300 * 1000,
      () => upstreamJson(`${SWPC_BASE}/json/planetary_k_index_1m.json`),
      r => r.status === 200),
    cachedFetch("prop:dst", 600 * 1000,
      () => upstreamJson(`${SWPC_BASE}/products/kyoto-dst.json`),
      r => r.status === 200),
    cachedFetch("prop:wwv", 6 * 3600 * 1000,
      () => upstreamText(`${SWPC_BASE}/text/wwv.txt`),
      t => t.status === 200),
  ]);

  const flux = fluxRes.body?.length ? fluxRes.body[fluxRes.body.length - 1] : null;
  const sfi = Number(flux?.flux) || null;

  const kpList = Array.isArray(kpRes.body) ? kpRes.body : [];
  const kpLast = kpList.length ? kpList[kpList.length - 1] : null;
  const kpNow = kpLast
    ? Number(kpLast.estimated_kp) || Number(kpLast.kp_index) || null
    : null;

  const dstRow = dstRes.body?.length ? dstRes.body[dstRes.body.length - 1] : null;
  const dst = dstRow && dstRow.dst != null ? Number(dstRow.dst) : null;

  // Daily A-index from the WWV geophysical alert text.
  const aIndex = parseAIndex(wwv.body || "");

  const now = new Date();
  const sun = hasLoc ? solarPosition(lat, lon, now) : null;

  const gray = hasLoc && sun
    ? grayLineState(lat, lon, now)
    : { active: false };

  const bands = computeBands({
    sfi, kp: kpNow, a: aIndex, dst,
    isDay: sun ? sun.elevation > -6 : null,   // civil twilight boundary
  });

  const overall = overallQuality(bands);

  return ok({
    source: "NOAA SWPC + Kyoto Dst",
    updated: flux?.time_tag || dstRow?.time_tag || now.toISOString(),
    indices: {
      sfi,
      sfi_trend: fluxTrend(fluxRes.body),
      a_index: aIndex,
      kp: kpNow,
      kp_label: kpLabel(kpNow),
      dst,
    },
    gray_line: gray,
    overall,
    bands,
  }, { ttl: SOLAR_TTL });
}

// ---- Data parsing ---------------------------------------------------------

// "Solar flux 101 and estimated planetary A-index 3."
function parseAIndex(text) {
  const m = text.match(/planetary A-index (\d+)/i);
  return m ? Number(m[1]) : null;
}

// 30-day flux trend: latest vs 7-day-old value (+/- sfu).
function fluxTrend(list) {
  if (!Array.isArray(list) || list.length < 8) return null;
  const now = Number(list[list.length - 1].flux);
  const weekAgo = Number(list[list.length - 7].flux);
  if (!isFinite(now) || !isFinite(weekAgo)) return null;
  return { delta: Math.round((now - weekAgo) * 10) / 10, direction: now >= weekAgo ? "up" : "down" };
}

// ---- Band model (rule-of-thumb, ham-lore calibrated) ----------------------

const BAND_CONFIG = [
  { band: "160m", freq: 1.8,  minSfi: 60,  night: true  },
  { band: "80m",  freq: 3.5,  minSfi: 60,  night: true  },
  { band: "40m",  freq: 7,    minSfi: 70,  night: null  }, // works day & night
  { band: "20m",  freq: 14,   minSfi: 90,  night: false },
  { band: "15m",  freq: 21,   minSfi: 110, night: false },
  { band: "10m",  freq: 28,   minSfi: 130, night: false },
];

function computeBands({ sfi, kp, a, dst, isDay }) {
  const s = sfi ?? 0;
  const k = kp ?? 0;
  const aa = a ?? 0;

  return BAND_CONFIG.map(cfg => {
    let score = 2.0;   // "fair" baseline

    // Solar flux: more ionization → higher bands open.
    if (s >= 150) score += 1.5;
    else if (s >= 120) score += 1.0;
    else if (s >= 100) score += 0.5;
    else if (s < 80) score -= 1.0;

    // Day/night preference (null = both, scored lightly).
    if (cfg.night === true) score += isDay ? -0.5 : +1.5;
    else if (cfg.night === false) score += isDay ? +1.5 : -1.0;
    else score += 0.5;

    // Geomagnetic disturbance penalises high-latitude paths.
    if (k >= 6) score -= 2.5;
    else if (k >= 5) score -= 2.0;
    else if (k >= 4) score -= 1.0;
    else if (k >= 3) score -= 0.5;
    if (aa >= 30) score -= 1.5;
    else if (aa >= 15) score -= 0.8;
    else if (aa >= 10) score -= 0.4;
    if (dst != null && dst <= -150) score -= 1.5;
    else if (dst != null && dst <= -80) score -= 0.8;

    // Flux gate: bands above the current SFI are unlikely to open.
    if (s < cfg.minSfi) score -= 1.5;

    return { band: cfg.band, freq: cfg.freq, quality: qualityLabel(score), score: round1(score) };
  });
}

function qualityLabel(score) {
  if (score >= 3.5) return "excellent";
  if (score >= 2.5) return "good";
  if (score >= 1.5) return "fair";
  if (score >= 0.5) return "poor";
  return "closed";
}

function overallQuality(bands) {
  const weight = { closed: 0, poor: 1, fair: 2, good: 3, excellent: 4 };
  const vals = bands.map(b => weight[b.quality]);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg >= 3) return { label: "Excellent", level: "excellent" };
  if (avg >= 2.2) return { label: "Good", level: "good" };
  if (avg >= 1.5) return { label: "Fair", level: "fair" };
  if (avg >= 0.8) return { label: "Poor", level: "poor" };
  return { label: "Closed", level: "closed" };
}

function round1(v) { return Math.round(v * 10) / 10; }

function kpLabel(kp) {
  if (kp == null) return null;
  if (kp >= 9) return "extreme";
  if (kp >= 8) return "severe";
  if (kp >= 7) return "strong";
  if (kp >= 6) return "active";
  if (kp >= 5) return "minor storm";
  if (kp >= 4) return "unsettled";
  if (kp >= 3) return "quiet";
  return "very quiet";
}

// ---- Sun / gray-line ------------------------------------------------------

// Gray line = local sunrise/sunset window (terminator crossing the observer).
// Flag active when within ~±45 min of either, which boosts low-band DX.
function grayLineState(lat, lon, date) {
  const rad = Math.PI / 180;
  const doy = dayOfYear(date);
  const toUTC = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  // NOAA approximate solar declination + equation of time.
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (toUTC - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));

  const hourAngle = 90.833;   // sunrise/sunset refr. correction
  const cosH = (Math.cos(hourAngle * rad) - Math.sin(lat * rad) * Math.sin(decl))
    / (Math.cos(lat * rad) * Math.cos(decl));
  let half = null;
  if (cosH >= -1 && cosH <= 1) half = Math.acos(cosH) / rad / 15;   // hours from solar noon

  const solarNoon = 12 - lon / 15 - eqt / 60;   // UTC hour
  const sunrise = half != null ? solarNoon - half : null;
  const sunset = half != null ? solarNoon + half : null;

  const nowMin = toUTC * 60;
  const toMin = h => h == null ? null : h * 60;

  let active = false, label = "";
  if (sunrise != null && sunset != null) {
    const srMin = toMin(sunrise), ssMin = toMin(sunset);
    const W = 45;   // ±minutes around the terminator crossing
    if (Math.abs(nowMin - srMin) <= W) { active = true; label = `sunrise ${minToHHMM(srMin)} UTC`; }
    else if (Math.abs(nowMin - ssMin) <= W) { active = true; label = `sunset ${minToHHMM(ssMin)} UTC`; }
    else {
      label = nowMin < srMin
        ? `sunrise ${minToHHMM(srMin)} UTC`
        : nowMin < ssMin
          ? `sunset ${minToHHMM(ssMin)} UTC`
          : `sunrise ${minToHHMM(srMin + 1440)} UTC`;
    }
  }

  return {
    active,
    label,
    next_event: label.replace(/sunrise|sunset/i, "").trim(),
    solar_elevation: round1(solarElevation(lat, lon, date)),
  };
}

function solarPosition(lat, lon, date) {
  return { elevation: solarElevation(lat, lon, date) };
}

function solarElevation(lat, lon, date) {
  const rad = Math.PI / 180;
  const doy = dayOfYear(date);
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (utcH - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = 15 * (utcH + lon / 15 - 12) * rad;
  return Math.asin(
    Math.sin(lat * rad) * Math.sin(decl) +
    Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle),
  ) / rad;
}

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
}

function minToHHMM(min) {
  const h = Math.floor(((min % 1440) + 1440) % 1440 / 60);
  const m = Math.round(((min % 1440) + 1440) % 1440 % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
