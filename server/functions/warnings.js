import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, haversineKm, isInPortugal } from "./utils.js";
import { IPMA_BASE, IPMA_WARNINGS_PATH, WARNINGS_TTL } from "./env.js";

// Weather warnings (avisos) for Portugal from IPMA. The feed returns per-area
// warnings with a district code (idAreaAviso), a type (awarenessTypeName), a
// level (green/yellow/orange/red) and an active window. We only surface the
// district the observer is actually in (nearest by centroid), drop green
// noise, and group the rest by type for the widget.
const AREAS = {
  PTO: "Porto", LSB: "Lisboa", FAR: "Faro", BRG: "Braga", BGC: "Bragança",
  AVG: "Aveiro", CBR: "Coimbra", CBO: "Castelo Branco", EVR: "Évora",
  GDA: "Guarda", LRA: "Leiria", PTG: "Portalegre", STB: "Santarém",
  SET: "Setúbal", VCT: "Viana do Castelo", VRL: "Vila Real", VIS: "Viseu",
  MDR: "Madeira", MRM: "Madeira (S)", MPS: "Porto Santo",
  MCN: "Madeira (N)", MCS: "Madeira (E)",
  ACO: "Açores Ocidental", ACC: "Açores Central", AOC: "Açores (O)",
  AOR: "Açores (E)", ACE: "Açores (C)",
};

// District centroids (mainland + islands) for nearest-area resolution.
const CENTROIDS = {
  PTO: [41.15, -8.61], LSB: [38.72, -9.14], FAR: [37.02, -7.93],
  BRG: [41.55, -8.43], BGC: [41.81, -6.76], AVG: [40.64, -8.65],
  CBR: [40.21, -8.43], CBO: [39.82, -7.49], EVR: [38.57, -7.91],
  GDA: [40.54, -7.27], LRA: [39.74, -8.81], PTG: [39.29, -7.43],
  STB: [39.23, -8.69], SET: [38.52, -8.89], VCT: [41.69, -8.83],
  VRL: [41.30, -7.74], VIS: [40.66, -7.91], MDR: [32.66, -16.92],
  MPS: [33.06, -16.34], MCN: [32.74, -17.10], MCS: [32.72, -16.80],
  AOC: [39.42, -31.12], ACC: [38.73, -27.22], AOR: [37.74, -25.67],
};

const LEVELS = { green: 0, yellow: 1, orange: 2, red: 3 };

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  // IPMA advisories only cover Portugal — return an explicit empty response
  // outside the country so the widget can say so instead of guessing.
  if (!isInPortugal(lat, lon)) {
    return ok({
      source: "IPMA",
      outside_pt: true,
      area: null,
      max_level: "none",
      count: 0,
      alerts: [],
    }, { ttl: WARNINGS_TTL });
  }

  // Nearest district by centroid — this is the "current area".
  let areaCode = null, areaDist = Infinity;
  for (const [code, [clat, clon]] of Object.entries(CENTROIDS)) {
    const d = haversineKm(lat, lon, clat, clon);
    if (d < areaDist) { areaDist = d; areaCode = code; }
  }

  const { status, body } = await upstreamJson(`${IPMA_BASE}${IPMA_WARNINGS_PATH}`);
  if (status !== 200 || !body) {
    return fail(502, "Upstream IPMA request failed", { upstreamStatus: status });
  }

  const now = Date.now();
  const alerts = [];

  for (const w of body || []) {
    if (w.idAreaAviso !== areaCode) continue;
    const level = (w.awarenessLevelID || "").toLowerCase();
    const start = w.startTime ? new Date(w.startTime).getTime() : 0;
    const end = w.endTime ? new Date(w.endTime).getTime() : 0;
    if (level === "green" || !(LEVELS[level] > 0)) continue;
    if (end && end < now) continue;
    alerts.push({
      type: w.awarenessTypeName || "—",
      level,
      level_value: LEVELS[level] ?? 0,
      start: start ? new Date(start).toISOString() : null,
      end: end ? new Date(end).toISOString() : null,
    });
  }

  alerts.sort((a, b) => b.level_value - a.level_value);

  return ok({
    source: "IPMA",
    area: {
      code: areaCode,
      name: AREAS[areaCode] || areaCode,
      distance_km: Math.round(areaDist),
    },
    max_level: alerts.length ? alerts[0].level : "none",
    count: alerts.length,
    alerts,
  }, { ttl: WARNINGS_TTL });
}
