import { handleOptions, ok, fail, requireParams, upstreamJson, toQuery, rawResponse } from "./utils.js";
import { ARC_GIS_URL, ARC_GIS_TOKEN, INCIDENT_RADIUS_M, INCIDENT_MAX, INCIDENT_TTL } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  if (!ARC_GIS_URL) return fail(500, "ARC_GIS_URL env var not set");

  const ll = `${params.lon},${params.lat}`;
  const q = toQuery({
    where: "1=1",
    outFields:
      "ID_oc,Natureza,EstadoOcorrencia,Concelho,Localidade,DataInicioOcorrencia,DataOcorrencia",
    geometry: ll,
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    distance: INCIDENT_RADIUS_M,
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    orderByFields: "DataOcorrencia DESC",
    resultRecordCount: INCIDENT_MAX,
    f: "geojson",
    outSR: 4326,
    token: ARC_GIS_TOKEN,
  });

  const { status, body } = await upstreamJson(`${ARC_GIS_URL}?${q}`);
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream incidents request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: INCIDENT_TTL });
}
