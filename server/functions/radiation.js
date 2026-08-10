import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, apaQueryUrl, nearestTo, isInPortugal, toQuery } from "./utils.js";
import { APA_GEO_BASE, RADNET_SERVICE, RADNET_TTL, RADNET_MAX, SAFECAST_BASE, SAFECAST_PATH, SAFECAST_RADIUS_KM, SAFECAST_MAX, SAFECAST_TTL } from "./env.js";

// Gamma dose-rate in air. Inside Portugal we use RADNET (APA), the national
// environmental radioactivity alert network (~31 stations measuring H*(10)
// ambient dose rate in nSv/h). Outside Portugal we fall back to Safecast, a
// global crowd-sourced radiation network (counts per minute and dose rates).
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  // Outside Portugal: use the global Safecast network instead of RADNET.
  if (!isInPortugal(lat, lon)) {
    return fallbackSafecast(lat, lon);
  }

  const url = apaQueryUrl(APA_GEO_BASE, RADNET_SERVICE, {
    outFields: "nome_estacao,valor,unidade,data_hora,cod_tipo_medida,estado_estacao",
    orderBy: "data_hora DESC",
    limit: RADNET_MAX,
    geometry: { lat, lon, radiusM: 200000 },
  });

  const { status, body } = await upstreamJson(url);
  if (status !== 200 || !body) {
    return fail(502, "Upstream RADNET request failed", { upstreamStatus: status });
  }

  const feats = (body.features || []).map(f => {
    const a = f.properties || {};
    const c = (f.geometry || {}).coordinates || [];
    return {
      station: a.nome_estacao,
      dose: a.valor,
      unit: a.unit || a.unidade || "nSv/h",
      state: a.estado_estacao || a.estado || null,
      updated: a.data_hora != null ? new Date(a.data_hora).toISOString() : null,
      lat: c[1],
      lon: c[0],
    };
  }).filter(r => r.dose != null && isFinite(r.lat));

  const nearest = nearestTo(lat, lon, feats);
  if (!nearest) {
    return fail(502, "No RADNET stations within range");
  }

  return ok({
    source: "APA RADNET",
    nearest: {
      station: nearest.station,
      distance_km: Math.round(nearest.distance * 10) / 10,
      dose_nsvh: nearest.dose,
      unit: nearest.unit,
      updated: nearest.updated,
      status: nearest.state,
    },
    stations: feats.length,
  }, { ttl: RADNET_TTL });
}

// Global fallback: nearest recent Safecast measurement, shaped like the RADNET
// response so the client can render either source unchanged. Safecast units
// are cpm (counts per minute) or dose rates (uSv/h); we prefer dose-rate
// readings when present within range.
async function fallbackSafecast(lat, lon) {
  const q = toQuery({
    latitude: lat,
    longitude: lon,
    distance: SAFECAST_RADIUS_KM,
    max_measurements: SAFECAST_MAX,
  });
  const { status, body } = await upstreamJson(`${SAFECAST_BASE}${SAFECAST_PATH}?${q}`);
  if (status !== 200 || !Array.isArray(body)) {
    return fail(502, "Upstream Safecast request failed", { upstreamStatus: status });
  }

  const DOSE_UNITS = new Set(["uSv/h", "nSv/h", "mSv/h", "usv/h", "nsv/h"]);
  const rows = body
    .map(m => ({
      value: Number(m.value),
      unit: m.unit || "cpm",
      updated: m.captured_at != null ? new Date(m.captured_at).toISOString() : null,
      lat: Number(m.latitude),
      lon: Number(m.longitude),
    }))
    .filter(r => isFinite(r.value) && isFinite(r.lat) && isFinite(r.lon));

  const dose = rows.filter(r => DOSE_UNITS.has(r.unit.toLowerCase()));
  const pool = dose.length ? dose : rows;
  const nearest = nearestTo(lat, lon, pool);
  if (!nearest) {
    return fail(502, "No Safecast measurements within range");
  }

  return ok({
    source: "Safecast",
    nearest: {
      station: `Safecast sensor ${Math.round(nearest.lat * 100) / 100},${Math.round(nearest.lon * 100) / 100}`,
      distance_km: Math.round(nearest.distance * 10) / 10,
      dose_nsvh: nearest.value,
      unit: nearest.unit,
      updated: nearest.updated,
      status: "crowd-sourced",
    },
    stations: rows.length,
  }, { ttl: SAFECAST_TTL });
}
