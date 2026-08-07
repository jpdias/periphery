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

export function json(data, headers = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...headers,
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
