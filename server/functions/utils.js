import { UPSTREAM_TIMEOUT_MS } from "./env.js";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Accept-Encoding, Origin",
  };
}

export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), Allow: "GET, OPTIONS" },
  });
}

export function cacheHeaders(ttlSeconds) {
  return {
    "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=60`,
  };
}

// Serialize JSON with CORS + extra headers. Pass `status` inside the headers
// object to override the response code (fail() relies on this).
export function json(data, headers = {}) {
  const status = typeof headers.status === "number" ? headers.status : 200;
  const { status: _drop, ...rest } = headers;
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...rest,
    },
  });
}

export function ok(data, extra = {}) {
  return json({ ok: true, ...extra, data }, cacheHeaders(extra.ttl ?? 60));
}

// Raw passthrough for the device firmware: when the caller sends
// "X-Minidash-Raw: 1", return the upstream body verbatim (headers stripped) so
// the ESP8266 streaming parsers work unchanged. Used by all widget functions.
export function rawResponse(event, status, body) {
  if (event.headers?.["x-minidash-raw"] !== "1") return null;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

export function fail(status, error, extra = {}) {
  return json({ ok: false, error, ...extra }, { status, "Cache-Control": "no-store" });
}

export async function upstreamJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: opts.headers ?? {},
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    // Timeout abort (AbortError) or network failure — surface as upstream error.
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Like upstreamJson but returns the raw response text (for text-based upstreams
// such as the NASA Horizons ephemeris, which is plain text, not JSON).
export async function upstreamText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: opts.headers ?? {},
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export function requireParams(event, names) {
  const params = event.queryStringParameters || {};
  for (const n of names) {
    if (params[n] === undefined || params[n] === "") {
      return { error: `Missing required parameter: ${n}`, params: null };
    }
  }
  return { error: null, params };
}

export function toQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Great-circle distance in km between two [lat, lon] pairs.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Bounding boxes covering Portugal (mainland + Madeira + Azores archipelagos).
// Used to decide which Portugal-only widgets (trains, incidents, IPMA warnings,
// IPMA forecast) apply to a given lat/lon, and which should fall back to
// generic sources (Open-Meteo, MeteoAlarm, ...).
const PT_BOXES = [
  // mainland
  { minLat: 36.95, maxLat: 42.15, minLon: -9.55, maxLon: -6.19 },
  // Madeira (+ Porto Santo)
  { minLat: 32.36, maxLat: 33.12, minLon: -17.30, maxLon: -16.24 },
  // Azores — western (Flores, Corvo)
  { minLat: 39.32, maxLat: 39.75, minLon: -31.34, maxLon: -31.00 },
  // Azores — central (Faial, Pico, S. Jorge, Graciosa, Terceira)
  { minLat: 38.30, maxLat: 39.10, minLon: -28.90, maxLon: -27.00 },
  // Azores — eastern (S. Miguel, Santa Maria)
  { minLat: 36.85, maxLat: 37.95, minLon: -25.90, maxLon: -25.00 },
];

export function isInPortugal(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return false;
  return PT_BOXES.some(b =>
    lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon);
}

// Find the nearest entry among an array of {lat, lon} records.
export function nearestTo(lat, lon, records) {
  let best = null;
  for (const r of records) {
    if (!isFinite(r.lat) || !isFinite(r.lon)) continue;
    const d = haversineKm(lat, lon, r.lat, r.lon);
    if (!best || d < best.distance) best = { ...r, distance: d };
  }
  return best;
}

// Build the query URL for an APA ArcGIS FeatureServer layer (used by RADNET
// and QualAr). Wraps a where clause + outFields and returns features as JSON.
export function apaQueryUrl(base, service, { where = "1=1", outFields = "*", orderBy = "", limit = 100, geometry = null, withGeometry = false, outSR = "4326" } = {}) {
  const params = {
    where,
    outFields,
    returnGeometry: geometry ? "true" : withGeometry ? "true" : "false",
    f: "geojson",
    outSR,
    resultRecordCount: limit,
  };
  if (orderBy) params.orderByFields = orderBy;
  if (geometry) {
    params.geometry = `${geometry.lon},${geometry.lat}`;
    params.geometryType = "esriGeometryPoint";
    params.inSR = 4326;
    params.distance = geometry.radiusM;
    params.units = "esriSRUnit_Meter";
    params.spatialRel = "esriSpatialRelIntersects";
  }
  return `${base}${service}/query?${toQuery(params)}`;
}

// In-process TTL cache for slow/rate-limited upstreams. The dev server keeps
// modules loaded between requests, so this survives across calls in a single
// process (Netlify also reuses lambdas between invocations). By default only
// truthy results are cached; pass `isOk` to decide what counts as good (e.g.
// don't cache upstream 429s). Always returns a Promise so callers can .then().
const cacheStore = new Map();
export function cachedFetch(key, ttlMs, fn, isOk = v => Boolean(v)) {
  const now = Date.now();
  const hit = cacheStore.get(key);
  if (hit && now < hit.expiresAt) return Promise.resolve(hit.value);
  return fn().then((value) => {
    if (isOk(value)) cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  });
}
