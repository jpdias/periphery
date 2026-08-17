// Shared InfoÁgua (APA) helpers used by the albufeiras and warnings widgets.
// This module exports no default handler, so it is never exposed as an API
// route — it is only imported by the actual endpoint functions.
import { UPSTREAM_TIMEOUT_MS } from "./env.js";
import { upstreamJson, toQuery, haversineKm } from "./utils.js";

// Map the geometry layer's basin names (SNIRH-style) to InfoÁgua's basin rows.
// Basins with no InfoÁgua row (MINHO/ÂNCORA) are skipped in the ranking.
export const GEOM_ALIAS = {
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
export function geomAlgarveLon(lon) {
  return lon < -8.4 ? "Ribeiras do Barlavento" : "Ribeiras do Sotavento";
}

// Fetch an InfoÁgua page. Sends a browser-ish User-Agent: the portal serves a
// standard UTF-8 HTML page with the JSON snapshots embedded as `var X = ...`.
export async function fetchInfoaguaPage(url) {
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
    return { status: res.status, html: await res.text() };
  } catch {
    return { status: 0, html: null };
  } finally {
    clearTimeout(timer);
  }
}

// Extract `var NAME = <object|array>;` from an InfoÁgua HTML page using a brace
// scanner (robust to nested objects/arrays), and JSON.parse the value.
export function extractVar(html, name) {
  if (!html) return null;
  const marker = `var ${name} =`;
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  let i = html.indexOf("=", idx) + 1;
  while (i < html.length && /[ \t\r\n]/.test(html[i])) i++;
  const open = html[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Fetch the dam geometry layer and map features to {bacia, name, lat, lon}.
// Expects the raw base URL (no query string); the query is built here.
export async function fetchDams(geomUrl) {
  const { status, body } = await upstreamJson(
    `${geomUrl}?${toQuery({
      where: "1=1",
      outFields: "bacia,albufeira,longdd,latdd",
      returnGeometry: "false",
      resultRecordCount: 500,
      f: "pjson",
    })}`,
  );
  if (status !== 200 || !body || !Array.isArray(body.features)) return [];
  return body.features
    .map((f) => {
      const a = f.attributes || {};
      const lon = Number(a.longdd);
      const lat = Number(a.latdd);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return { bacia: a.bacia, name: a.albufeira, lat, lon };
    })
    .filter(Boolean);
}

// Rank the given basin names by the distance from (lat, lon) to their nearest
// dam, using the GEOM_ALIAS mapping. Returns [{name, distance}] sorted.
export function rankBasins(lat, lon, dams, basinNames) {
  const buckets = {};
  for (const d of dams) {
    const b =
      d.bacia === "RIB EIRAS DO ALGARVE" ? geomAlgarveLon(d.lon) : GEOM_ALIAS[d.bacia] || d.bacia;
    if (!basinNames.includes(b)) continue;
    (buckets[b] = buckets[b] || []).push(haversineKm(lat, lon, d.lat, d.lon));
  }
  return Object.entries(buckets)
    .map(([name, dists]) => ({ name, distance: Math.min(...dists) }))
    .sort((a, b) => a.distance - b.distance);
}

// Drought state classes used on the InfoÁgua seca page (1 = driest).
export const DROUGHT_STATES = {
  1: "Seca hidrológica extrema",
  2: "Seca hidrológica severa",
  3: "Seca hidrológica moderada",
  4: "Seca hidrológica fraca",
  5: "Normal",
  6: "Húmido",
};

// Fetch the drought (seca) and flood (cheias) alert snapshots in parallel and
// return the raw `DATA_AlertsMap` arrays for each.
export async function fetchInfoaguaAlerts(base, secaPath, cheiasPath) {
  const [seca, cheias] = await Promise.all([
    fetchInfoaguaPage(`${base}${secaPath}`),
    fetchInfoaguaPage(`${base}${cheiasPath}`),
  ]);
  const droughtMap = extractVar(seca.html, "DATA_AlertsMap");
  const floodMap = extractVar(cheias.html, "DATA_AlertsMap");
  const drought = Array.isArray(droughtMap) ? droughtMap : null;
  const floods = Array.isArray(floodMap) ? floodMap : floodMap && typeof floodMap === "object"
    ? Object.values(floodMap)
    : null;
  return { drought, floods };
}