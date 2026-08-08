import { handleOptions, ok, fail, requireParams, upstreamJson, apaQueryUrl, nearestTo } from "./utils.js";
import { APA_GEO_BASE, QAR_SERVICE, QAR_POLUENTES, AIRQUALITY_TTL } from "./env.js";

// Air quality from APA's QualAr. The QAR_global layer carries the global IQAR
// index per station (indice 1..5: Muito bom..Mau, 0 = N.D.). We find the nearest
// station with a reported index, then enrich it with the per-pollutant indices
// from the QAR_poluentes layer (O3, SO2, NO2, PM10, PM2.5).
export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const url = apaQueryUrl(APA_GEO_BASE, QAR_SERVICE, {
    outFields: "estacao_id,estacao_nome,indice,indice_nome,poluente_responsavel_abv,data,concelho_nome,regiao_nome",
    orderBy: "data DESC",
    limit: 300,
    withGeometry: true,
  });

  const { status, body } = await upstreamJson(url);
  if (status !== 200 || !body) {
    return fail(502, "Upstream QualAr request failed", { upstreamStatus: status });
  }

  // Latest record per station (data DESC makes the first row the freshest).
  const byStation = new Map();
  for (const f of body.features || []) {
    const a = f.properties || {};
    const c = (f.geometry || {}).coordinates || [];
    const id = a.estacao_id;
    if (id == null || !byStation.has(id) && a.indice != null) {
      byStation.set(id, {
        id,
        name: a.estacao_nome,
        county: a.concelho_nome,
        region: a.regiao_nome,
        index: a.indice,
        indexName: a.indice_nome,
        pollutant: a.poluente_responsavel_abv || null,
        updated: a.data != null ? new Date(a.data).toISOString() : null,
        lat: c[1],
        lon: c[0],
      });
    }
  }

  const nearest = nearestTo(lat, lon, [...byStation.values()]);
  if (!nearest) return fail(502, "No QualAr stations in range");

  // A station may be geometrically nearest but have no index (Sem índice);
  // fall back to the nearest station that actually reports an index.
  let station = nearest;
  if (!station.index || station.index === 0) {
    const withIndex = [...byStation.values()].filter(s => s.index && s.index > 0);
    const nearestIndexed = nearestTo(lat, lon, withIndex);
    if (nearestIndexed) station = nearestIndexed;
  }

  // Enrich with per-pollutant indices for the chosen station.
  let pollutants = [];
  const puUrl = apaQueryUrl(APA_GEO_BASE, QAR_POLUENTES, {
    where: `estacao_id = ${station.id}`,
    outFields: "poluente_abv,indice,indice_nome,avg_display,poluente_unidade,data,hora_display,alerta",
    orderBy: "data DESC",
    limit: 40,
  });
  const puRes = await upstreamJson(puUrl);
  if (puRes.status === 200 && puRes.body) {
    const seen = new Map();
    for (const f of puRes.body.features || []) {
      const a = f.properties || {};
      const key = a.poluente_abv;
      if (key && !seen.has(key)) {
        seen.set(key, {
          pollutant: key,
          index: a.indice,
          indexName: a.indice_nome,
          value: a.avg_display || null,
          alert: !!a.alerta,
        });
      }
    }
    pollutants = [...seen.values()];
  }

  return ok({
    source: "APA QualAr",
    station: {
      name: station.name,
      county: station.county,
      region: station.region,
      distance_km: Math.round(station.distance * 10) / 10,
      updated: station.updated,
    },
    global_index: {
      value: station.index,
      label: station.indexName,
      responsible_pollutant: station.pollutant,
    },
    pollutants,
  }, { ttl: AIRQUALITY_TTL });
}
