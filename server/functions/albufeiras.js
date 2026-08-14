import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  upstreamJson,
  upstreamText,
  cachedFetch,
  haversineKm,
  toQuery,
} from "./utils.js";
import {
  UPSTREAM_TIMEOUT_MS,
  INFOAGUA_BASE,
  INFOAGUA_PATH,
  ALBUF_GEOM_URL,
  ALBUF_TTL,
} from "./env.js";

// Reservoir storage (albufeiras) in Portugal from APA's InfoÁgua portal.
// InfoÁgua serves the current storage snapshot server-rendered on its seca
// page: a `DATA_VolumesMap` JSON object with one row per river basin (% of full
// capacity NPA, monthly average %, historical monthly minimum) + a national
// TOTAL row, and a `DATA_BasinVolumesEvolution` series of national totals.
//
// Unlike the legacy SNIRH bulletin (snirh.apambiente.pt — ASN/geo blocked for
// cloud egress), infoagua.apambiente.pt is served from a separate host that
// Netlify's cloud egress can fetch directly.
const INFG_MONTHS = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

// Map the geometry layer's basin names (SNIRH-style) to InfoÁgua's basin rows.
// Basins with no InfoÁgua row (MINHO/ÂNCORA) are skipped in the ranking.
const GEOM_ALIAS = {
  "ARADE": "Arade",
  "AVE": "Ave",
  "AVE/LEÇA": "Ave",
  "CÁVADO/RIBEIRAS COSTEIRAS": "Cávado",
  "DOURO": "Douro",
  "GUADIANA": "Guadiana",
  "LIMA": "Lima",
  "MIRA": "Mira",
  "MONDEGO": "Mondego",
  "RIBEIRAS DO ALENTEJO": "Ribeiras do Alentejo",
  "RIBEIRAS DO OESTE": "Ribeiras do Oeste",
  "SADO": "Sado",
  "TEJO": "Tejo",
  "VOUGA/RIBEIRAS COSTEIRAS": "Vouga",
};

// The geometry layer groups the Algarve under one bacia; InfoÁgua splits it by
// lon: west of the frontier (~ -8.4) is Barlavento, east is Sotavento.
function geomAlgarveLon(lon) {
  return lon < -8.4 ? "Ribeiras do Barlavento" : "Ribeiras do Sotavento";
}

// InfoÁgua serves a standard UTF-8 HTML page; grab the embedded JSON snapshot.
async function fetchInfoagua(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    });
    const text = await res.text();
    const m = text.match(/var DATA_VolumesMap = (\{[\s\S]*?\});/);
    let snap;
    try {
      snap = m ? JSON.parse(m[1]) : null;
    } catch {
      snap = null;
    }
    return { status: res.status, snap };
  } catch {
    return { status: 0, snap: null };
  } finally {
    clearTimeout(timer);
  }
}

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

  const url = `${INFOAGUA_BASE}${INFOAGUA_PATH}`;
  const geomUrl = `${ALBUF_GEOM_URL}?${toQuery({
    where: "1=1",
    outFields: "bacia,albufeira,longdd,latdd",
    returnGeometry: "false",
    resultRecordCount: 500,
    f: "pjson",
  })}`;

  const { status, snap, geom } = await cachedFetch(
    `albufeiras:${url}:${hasLatLon ? geomUrl : ""}`,
    ALBUF_TTL * 1000,
    async () => {
      const [pageRes, geomRes] = await Promise.all([
        fetchInfoagua(url),
        hasLatLon ? upstreamJson(geomUrl) : Promise.resolve(null),
      ]);
      return { status: pageRes.status, snap: pageRes.snap, geom: geomRes && geomRes.body };
    },
  );
  if (status !== 200 || !snap) {
    return fail(502, "Upstream InfoÁgua request failed", { upstreamStatus: status });
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
    // Rank basins by the distance to their nearest dam; keep the n closest.
    const dams = (geom && Array.isArray(geom.features) ? geom.features : [])
      .map((f) => {
        const a = f.attributes || {};
        const long = Number(a.longdd);
        const latt = Number(a.latdd);
        if (!Number.isFinite(long) || !Number.isFinite(latt)) return null;
        return { bacia: a.bacia, name: a.albufeira, lat: latt, lon: long };
      })
      .filter(Boolean);

    const basinDams = {};
    for (const d of dams) {
      const b = d.bacia === "RIB EIRAS DO ALGARVE" ? geomAlgarveLon(d.lon) : GEOM_ALIAS[d.bacia] || d.bacia;
      if (!basins.some((r) => r.name === b)) continue;
      (basinDams[b] = basinDams[b] || []).push(d);
    }

    const scored = result.map((r) => {
      const ds = basinDams[r.name] || [];
      const dist = ds.length
        ? Math.min(...ds.map((d) => haversineKm(lat, Number(params.lon), d.lat, d.lon)))
        : Infinity;
      return { ...r, dist };
    });
    result = scored
      .filter((r) => Number.isFinite(r.dist))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n)
      .map((r) => {
        const { dist, ...rest } = r;
        return { ...rest, distance_km: Math.round(dist) };
      });
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