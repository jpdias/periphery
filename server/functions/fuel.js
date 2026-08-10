import { handleOptions, ok, fail, upstreamJson, cachedFetch } from "./utils.js";
import { APIABERTA_BASE, FUEL_PATH, FUEL_TTL, FUEL_MAX } from "./env.js";

// Portuguese fuel prices from API Aberta (DGEG-sourced, ~06:55 daily, free).
// Response: { data: [{ fuel_slug, fuel_name, road_vehicle, avg_price_eur,
// min_price_eur, max_price_eur, station_count, date, updated_at }] }.
// We surface the road fuels people actually use, plus the overall date.
// The free tier of API Aberta is strictly rate-limited (429s under a 60s
// polling client), so we cache the upstream result for a long in-process TTL.
export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const url = `${APIABERTA_BASE}${FUEL_PATH}?limit=${FUEL_MAX}`;
  const { status, body } = await cachedFetch(`fuel:${url}`, 6 * 3600 * 1000,
    () => upstreamJson(url),
    ({ status } = {}) => status === 200);
  if (status !== 200 || !body || !Array.isArray(body.data)) {
    return fail(502, "Upstream API Aberta request failed", { upstreamStatus: status });
  }

  const rows = body.data;
  const wanted = [
    "gasoline_95", "gasoline_98", "diesel", "diesel_plus", "gpl_auto", "gnc_kg",
  ];
  const bySlug = Object.fromEntries(rows.map(r => [r.fuel_slug, r]));

  const fuels = wanted
    .map(slug => {
      const r = bySlug[slug];
      if (!r) return null;
      return {
        slug,
        name: r.fuel_name,
        avg: r.avg_price_eur,
        min: r.min_price_eur,
        max: r.max_price_eur,
        stations: r.station_count,
      };
    })
    .filter(Boolean);

  const date = rows.find(r => r.date)?.date || null;
  const updated = rows.find(r => r.updated_at)?.updated_at || null;

  return ok({
    source: "API Aberta / DGEG",
    date,
    updated_at: updated,
    currency: "EUR",
    fuels,
  }, { ttl: FUEL_TTL });
}
