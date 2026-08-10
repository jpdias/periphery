import { handleOptions, ok, fail, requireParams } from "./utils.js";

// GET /api/region?lat=<y>&lon=<x> -> which PT widgets apply to this location.
// Returns { in_pt, region } where region is "mainland" | "madeira" | "azores"
// | "outside". The client uses this to hide Portugal-only widgets (trains,
// incidents, IPMA warnings) when the observer is outside Portugal, and to let
// the forecast fall back to a generic source.
export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["lat", "lon"]);
  if (error) return fail(400, error);

  const lat = Number(params.lat);
  const lon = Number(params.lon);
  if (!isFinite(lat) || !isFinite(lon)) return fail(400, "Invalid coordinates");

  const inMainland = lat >= 36.95 && lat <= 42.15 && lon >= -9.55 && lon <= -6.19;
  const inMadeira = lat >= 32.36 && lat <= 33.12 && lon >= -17.30 && lon <= -16.24;
  const inAzores =
    (lat >= 39.32 && lat <= 39.75 && lon >= -31.34 && lon <= -31.00) ||
    (lat >= 38.30 && lat <= 39.10 && lon >= -28.90 && lon <= -27.00) ||
    (lat >= 36.85 && lat <= 37.95 && lon >= -25.90 && lon <= -25.00);

  return ok({
    in_pt: inMainland || inMadeira || inAzores,
    region: inMainland ? "mainland" : inMadeira ? "madeira" : inAzores ? "azores" : "outside",
  }, { ttl: 3600 });
}
