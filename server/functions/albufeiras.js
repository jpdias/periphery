// Reservoir storage (albufeiras) in Portugal from APA's InfoÁgua portal.
// InfoÁgua serves the current storage snapshot server-rendered on its seca
// page: a `DATA_VolumesMap` JSON object with one row per river basin (% of full
// capacity NPA, monthly average %, historical monthly minimum) + a national
// TOTAL row, and a `DATA_BasinVolumesEvolution` series of national totals.
//
// Unlike the legacy SNIRH bulletin (snirh.apambiente.pt — ASN/geo blocked for
// cloud egress), infoagua.apambiente.pt is served from a separate host that
// Netlify's cloud egress can fetch directly.
import { normalizeEvent, handleOptions, ok, fail, cachedFetch } from "./utils.js";
import {
  INFOAGUA_BASE,
  INFOAGUA_PATH,
  ALBUF_GEOM_URL,
  ALBUF_TTL,
} from "./env.js";
import { fetchInfoaguaPage, extractVar, fetchDams, rankBasins } from "./infoagua.js";

const INFG_MONTHS = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const params = event.queryStringParameters || {};
  const lat = Number(params.lat);
  const hasLatLon = Number.isFinite(lat) && Number.isFinite(Number(params.lon));
  const n = hasLatLon ? Math.min(Math.max(parseInt(params.n, 10) || 3, 1), 12) : 12;
  if (params.lat !== undefined && !hasLatLon) {
    return fail(400, "lat and lon must both be numeric");
  }

  if (!INFOAGUA_BASE) {
    return fail(500, "INFOAGUA_BASE env var is not set");
  }

  const url = `${INFOAGUA_BASE}${INFOAGUA_PATH}`;

  const { status, snap, dams } = await cachedFetch(
    `albufeiras:${url}:${hasLatLon ? ALBUF_GEOM_URL : ""}`,
    ALBUF_TTL * 1000,
    async () => {
      const [pageRes, geometry] = await Promise.all([
        fetchInfoaguaPage(url),
        hasLatLon ? fetchDams(ALBUF_GEOM_URL) : Promise.resolve([]),
      ]);
      return { status: pageRes.status, snap: extractVar(pageRes.html, "DATA_VolumesMap"), dams: geometry };
    },
  );
  if (status !== 200 || !snap) {
    return fail(502, `Upstream InfoÁgua request failed (${url})`, { upstreamStatus: status });
  }

  const block = snap.data && snap.data[0];
  if (!block || !Array.isArray(block.rows) || !block.rows.length) {
    return fail(502, "Failed to parse InfoÁgua storage snapshot");
  }

  // National total row (id "total"), then the per-basin rows.
  const totalRow = block.rows.find((r) => String(r.id).toLowerCase() === "total");
  const rows = block.rows.filter((r) => String(r.id).toLowerCase() !== "total");
  if (!totalRow || typeof totalRow.value !== "number" || !rows.length) {
    return fail(502, "No storage values found in the InfoÁgua snapshot");
  }

  // Snapshot date: "2026-08-10 00:00:00.000000" (Europe/Lisbon).
  const dt = block.datetime && block.datetime.date;
  const dateStr = typeof dt === "string" ? dt.split(" ")[0] : new Date().toISOString().slice(0, 10);
  const [y, mo] = dateStr.split("-").map((v) => Number(v));
  const latestMonth = INFG_MONTHS[(mo || 1) - 1];
  const yearKey = `${(mo ?? 1) >= 10 ? y : y - 1}/${String((mo ?? 1) >= 10 ? y + 1 : y).slice(2)}`;

  const basins = rows.map((r) => ({
    name: r.bacia,
    pct: typeof r.value === "number" ? r.value : null,
    avg_pct: typeof r.average === "number" ? r.average : null,
    min_historical: typeof r.min === "string" ? r.min : null,
    capacity_hm3: null,
    prev_pct: null,
    delta: null,
  }));

  let result = basins;
  if (hasLatLon) {
    const basinNames = basins.map((r) => r.name);
    const ranked = rankBasins(lat, Number(params.lon), dams, basinNames);
    const dist = new Map(ranked.map((r) => [r.name, r.distance]));
    result = basins
      .map((r) => ({ ...r, dist: dist.get(r.name) ?? Infinity }))
      .filter((r) => Number.isFinite(r.dist))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n)
      .map(({ dist: d, ...rest }) => ({ ...rest, distance_km: Math.round(d) }));
    if (!result.length) {
      return fail(502, "No dam data available to rank basins by proximity");
    }
  }

  const nationalAvg = totalRow.value;

  return ok(
    {
      source: "APA InfoÁgua (infoagua.apambiente.pt)",
      date: dateStr,
      hydrologic_year: yearKey,
      latest_month: latestMonth,
      national_avg: nationalAvg,
      range:
        result.length === 1 ? "nearest" : result.length < 15 ? `nearest ${result.length}` : "all",
      basins: result,
    },
    { ttl: ALBUF_TTL },
  );
}