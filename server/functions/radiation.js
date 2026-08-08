import { handleOptions, ok, fail, requireParams, upstreamJson, apaQueryUrl, nearestTo } from "./utils.js";
import { APA_GEO_BASE, RADNET_SERVICE, RADNET_TTL, RADNET_MAX } from "./env.js";

// Gamma dose-rate in air from Portugal's RADNET (APA). RADNET is the national
// environmental radioactivity alert network (~31 active stations measuring
// H*(10) ambient dose rate in nSv/h). We pull the latest reading per station
// and return the one closest to the requested coordinates.
export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

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
