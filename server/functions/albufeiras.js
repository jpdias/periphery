import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  upstreamJson,
  cachedFetch,
  haversineKm,
  toQuery,
} from "./utils.js";
import { UPSTREAM_TIMEOUT_MS, SNIRH_BASE, ALBUF_PATH, ALBUF_GEOM_URL, ALBUF_TTL } from "./env.js";

// Reservoir storage (albufeiras) in Portugal from the SNIRH monthly bulletin.
// The bulletin is an HTML table: one header row with the 12 river basins, a
// capacity row (hm³), and a block of 12 month rows (OUT..SET) per hydrologic
// year. Each cell is the % of full capacity (NPA). anohi is the start year of
// the water year (Oct–Sep), so data published in July 2026 lives under
// anohi=2025. Values come back as "n/d" until published.
const MONTHS = ["OUT", "NOV", "DEZ", "JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET"];

// Alias the per-dam "bacia" attribute to the bulletin's aggregate basin names.
const BACIA_ALIAS = {
  "AVE/LEÇA": "AVE",
  AVE: "AVE",
};

// SNIRH cells use dot decimals and space thousands separators: "81.0", "1 169.6".
function num(s) {
  return Number(s.replace(/\s+/g, "").replace(",", "."));
}

// SNIRH serves its HTML as iso-8859-1 without advertising a charset, so plain
// res.text() mis-decodes accented basin names (CÁVADO -> C�VADO). Fetch the
// bytes and decode as windows-1252 explicitly.
async function fetchLatin1(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "Referer": "https://snirh.apambiente.pt/snirh/_dadossintese/albufeiras/albufeiras.htm",
        "Cache-Control": "no-cache",
      },
    });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("windows-1252").decode(buf);
    return { status: res.status, body: text };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Strip the SNIRH table into { basins, capacity, years: { "2025/26": [row..] } }.
function parseBulletin(html) {
  const cells = (tr) => {
    const out = [];
    for (const m of tr.matchAll(/<td class="tbl_val2">([^<]*)<\/td>/g)) out.push(m[1].trim());
    return out;
  };

  const header = html.match(/<td class="tbl_tit1">([^<]*)<\/td>/g) || [];
  const basins = header.map((h) => h.replace(/<[^>]+>/g, "").trim());
  if (basins.length !== 12) return null;

  const capRow = html.match(/Capacidade Total[\s\S]*?<\/tr>/);
  const capacity = capRow ? cells(capRow[0]) : [];
  if (capacity.length !== 12 || capacity.some((c) => c === "" || c === "n/d")) return null;

  // Groups rows by the hydrologic-year block they appear under.
  const years = {};
  let current = null;
  for (const m of html.matchAll(/<td rowspan="12" class="tbl_tit2">(\d{4}\/\d{2})<br>/g)) {
    current = m[1];
    years[current] = years[current] || [];
  }
  if (!current) return null;

  for (const row of html.matchAll(/<tr bgcolor="#E3EEF4">[\s\S]*?<\/tr>/g)) {
    const tds = row[0].match(/<td class="tbl_val2">([^<]*)<\/td>/g);
    if (!tds || tds.length !== 13) continue;
    const [label, ...vals] = tds.map((t) => t.replace(/<[^>]+>/g, "").trim());
    if (!MONTHS.includes(label) || vals.length !== basins.length) continue;
    // append to the most recent year block seen before this row
    if (!current) continue;
    years[current].push({ month: label, vals });
  }

  return { basins, capacity: capacity.map(num), years };
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

  // Hydrologic-year start year: Oct–Sep → July 2026 = start year 2025.
  const now = new Date();
  const anohi = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;

  const url = `${SNIRH_BASE}${ALBUF_PATH}?${toQuery({
    percOUvolum: 1,
    anohi,
    mes: "",
    bacia: "",
    albuf: "",
  })}`;

  const geomUrl = `${ALBUF_GEOM_URL}?${toQuery({
    where: "1=1",
    outFields: "bacia,albufeira,longdd,latdd",
    returnGeometry: "false",
    resultRecordCount: 500,
    f: "pjson",
  })}`;

  const { status, text, geom } = await cachedFetch(
    `albufeiras:${url}:${hasLatLon ? geomUrl : ""}`,
    ALBUF_TTL * 1000,
    async () => {
      const [textRes, geomRes] = await Promise.all([
        fetchLatin1(url),
        hasLatLon ? upstreamJson(geomUrl) : Promise.resolve(null),
      ]);
      return { status: textRes.status, text: textRes.body, geom: geomRes && geomRes.body };
    },
  );
  if (status !== 200 || !text) {
    return fail(502, "Upstream SNIRH bulletin request failed", { upstreamStatus: status });
  }

  const parsed = parseBulletin(text);
  if (!parsed) return fail(502, "Failed to parse SNIRH bulletin table");

  const { basins, capacity, years } = parsed;
  const yearKey = `${anohi}/${String(anohi + 1).slice(2)}`;

  // Latest published month across the current water year (skip n/d rows).
  const yearRows = (years[yearKey] || []).filter((r) => !r.vals.some((v) => v === "n/d"));
  const latest = yearRows[yearRows.length - 1] || null;
  if (!latest) return fail(502, "No published data found in the SNIRH bulletin");

  const prevIdx = MONTHS.indexOf(latest.month) - 1;
  const prev = yearRows.find((r) => MONTHS.indexOf(r.month) === prevIdx) || null;

  const rows = basins.map((name, i) => {
    const pct = num(latest.vals[i]);
    const pv = prev && prev.vals[i] !== "n/d" ? num(prev.vals[i]) : null;
    return {
      name,
      pct,
      capacity_hm3: capacity[i],
      prev_pct: pv,
      delta: pv === null ? null : +(pct - pv).toFixed(1),
    };
  });

  let result = rows;
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
      const b = BACIA_ALIAS[d.bacia] || d.bacia;
      if (!basins.includes(b)) continue;
      (basinDams[b] = basinDams[b] || []).push(d);
    }

    const scored = rows.map((r) => {
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

  const nationalAvg = +(rows.reduce((acc, r) => acc + r.pct, 0) / rows.length).toFixed(1);

  const mi = MONTHS.indexOf(latest.month);
  const monthYear = mi <= 2 ? anohi : anohi + 1; // OUT..DEZ -> start year, JAN..SET -> next CY
  const month = mi <= 2 ? mi + 10 : mi - 2; // OUT->10, NOV->11, DEZ->12, JAN->1, SET->9
  const date = `${monthYear}-${String(month).padStart(2, "0")}-01`;

  return ok(
    {
      source: "SNIRH / APA (snirh.apambiente.pt)",
      date,
      hydrologic_year: yearKey,
      latest_month: latest.month,
      national_avg: nationalAvg,
      range:
        result.length === 1 ? "nearest" : result.length < 12 ? `nearest ${result.length}` : "all",
      basins: result,
    },
    { ttl: ALBUF_TTL },
  );
}
