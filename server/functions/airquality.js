import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, apaQueryUrl, nearestTo, isInPortugal, toQuery } from "./utils.js";
import { APA_GEO_BASE, QAR_SERVICE, QAR_POLUENTES, AIRQUALITY_TTL, OPEN_METEO_AQ_BASE, OPEN_METEO_AQ_PATH } from "./env.js";

// Air quality. Inside Portugal we use APA's QualAr (per-station IQAR index 1..5
// and per-pollutant indices). Outside Portugal we fall back to the Open-Meteo
// air-quality API, mapping the US AQI onto the same 1..5 scale so the card
// renders unchanged anywhere in the world.
const AQI_BAND = aqi => (aqi == null ? null : aqi <= 50 ? 1 : aqi <= 100 ? 2 : aqi <= 150 ? 3 : aqi <= 200 ? 4 : 5);
const AQI_CAT = ["Good", "Moderate", "Unhealthy for sensitive groups", "Unhealthy", "Very unhealthy", "Hazardous"];

async function fallbackOpenMeteoAq(lat, lon) {
  const q = toQuery({
    latitude: lat,
    longitude: lon,
    current: "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide",
    timezone: "UTC",
  });
  const { status, body } = await upstreamJson(`${OPEN_METEO_AQ_BASE}${OPEN_METEO_AQ_PATH}?${q}`);
  if (status !== 200 || !body?.current) {
    return fail(502, "Upstream air quality request failed", { upstreamStatus: status });
  }
  const c = body.current;
  const band = AQI_BAND(c.us_aqi);
  const pollutants = [
    ["US AQI", c.us_aqi, band != null ? AQI_CAT[band - 1] : "—"],
    ["PM2.5", c.pm2_5, "µg/m³"],
    ["PM10", c.pm10, "µg/m³"],
    ["O3", c.ozone, "µg/m³"],
    ["NO2", c.nitrogen_dioxide, "µg/m³"],
    ["SO2", c.sulphur_dioxide, "µg/m³"],
    ["CO", c.carbon_monoxide, "µg/m³"],
  ].filter(([, v]) => v != null).map(([name, v, unit]) => ({
    pollutant: name,
    indexName: unit,
    value: v,
    alert: band != null && band >= 4,
  }));
  return ok({
    source: "Open-Meteo AQI",
    station: {
      name: "Open-Meteo",
      county: null,
      region: null,
      distance_km: 0,
      updated: c.time != null ? new Date(c.time).toISOString() : null,
    },
    global_index: {
      value: band,
      label: c.us_aqi != null ? `US AQI ${c.us_aqi}` : "US AQI",
      responsible_pollutant: null,
    },
    pollutants,
  }, { ttl: AIRQUALITY_TTL });
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

  // Outside Portugal: use the generic Open-Meteo air-quality API.
  if (!isInPortugal(lat, lon)) {
    return fallbackOpenMeteoAq(lat, lon);
  }

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
