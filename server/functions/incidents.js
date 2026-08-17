import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, toQuery, rawResponse, rememberGood, staleGood, isInPortugal } from "./utils.js";
import { ARC_GIS_URL, ARC_GIS_TOKEN, INCIDENT_RADIUS_M, INCIDENT_MAX, INCIDENT_TTL } from "./env.js";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  if (!ARC_GIS_URL) return fail(500, "ARC_GIS_URL env var not set");

  // The fire-incidents layer only covers Portugal — return an explicit empty
  // response outside the country.
  if (!isInPortugal(Number(params.lat), Number(params.lon))) {
    return ok({
      type: "FeatureCollection",
      outside_pt: true,
      features: [],
    }, { ttl: INCIDENT_TTL });
  }

  // Radius is optional, in km, overridable per request (mirrors flight range).
  const radiusKm = params.radius !== undefined ? Number(params.radius) : INCIDENT_RADIUS_M / 1000;
  const radiusM = (isFinite(radiusKm) && radiusKm > 0 ? radiusKm : INCIDENT_RADIUS_M / 1000) * 1000;

  const ll = `${params.lon},${params.lat}`;
  const q = toQuery({
    where: "1=1",
    outFields:
      "ID_oc,Natureza,EstadoOcorrencia,Concelho,Localidade,DataInicioOcorrencia,DataOcorrencia",
    geometry: ll,
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    distance: radiusM,
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    orderByFields: "DataOcorrencia DESC",
    resultRecordCount: INCIDENT_MAX,
    f: "geojson",
    outSR: 4326,
    token: ARC_GIS_TOKEN,
  });

  const { status, body } = await upstreamJson(`${ARC_GIS_URL}?${q}`);
  // Raw passthrough (device) mirrors the wrapped path's resilience: remember
  // the last healthy FeatureCollection and serve it verbatim if the upstream
  // throttles/errors, instead of forwarding an empty/broken body.
  const raw = rawResponse(event, status, body);
  if (raw) {
    if (status === 200 && body) rememberGood(`incidents:${ll}:${radiusM}`, body);
    else {
      const stale = staleGood(`incidents:${ll}:${radiusM}`);
      if (stale) return rawResponse(event, 200, stale);
    }
    return raw;
  }
  if (status !== 200 || !body) {
    return fail(502, "Upstream incidents request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: INCIDENT_TTL });
}
