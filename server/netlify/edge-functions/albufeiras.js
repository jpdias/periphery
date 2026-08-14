// Albufeiras (reservoir storage) — Edge Function probe.
//
// PROBE STAGE: validates that SNIRH accepts an egress IP from Netlify's edge
// network before the full parsing port. Deployment serves the same public path
// (/api/albufeiras); the serverless Lambda under functions/albufeiras.js stays
// for local dev via dev-server.mjs.
//
// Run:  GET /api/albufeiras?debug=1  -> { egress_ip, snirh_status, caller }
//      Any other GET/OPTIONS         -> probe placeholder JSON
//
// Edge functions run on Deno, not Node: env vars come from Netlify.env, never
// process.env (so env.js/utils.js cannot be imported here).

const env = (name, fallback) => {
  const v = Netlify.env.get(name);
  return v === undefined || v === "" ? fallback : v;
};

const SNIRH_BASE = env("SNIRH_BASE", "");
const ALBUF_PATH = env("ALBUF_PATH", "/snirh/_dadossintese/albufeiras/tabelas/tabelageral.php");
const ALLOWED_ORIGIN = env("ALLOWED_ORIGIN", "");
const UPSTREAM_TIMEOUT_MS = Number(env("UPSTREAM_TIMEOUT_MS", "15000"));

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Accept-Encoding, Origin",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

// Hydrologic-year start year (same rule as the Lambda): Oct–Sep -> start year.
function anohiNow() {
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
}

// Same bulletin URL shape the production widget fetches.
function bulletinUrl() {
  const params = new URLSearchParams({
    percOUvolum: "1",
    anohi: String(anohiNow()),
    mes: "",
    bacia: "",
    albuf: "",
  });
  return `${SNIRH_BASE}${ALBUF_PATH}?${params.toString()}`;
}

async function snirhStatus(url) {
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
    const body = (await res.text()).slice(0, 120);
    return { status: res.status, ok: res.ok, bodyPreview: body };
  } catch (err) {
    return { status: 0, ok: false, bodyPreview: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(request, context) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders(), Allow: "GET, OPTIONS" } });
  }
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  const outbound = bulletinUrl();
  const probe = {
    stage: "probe",
    snirh_url: outbound,
    snirh_status: null,
    egress_ip: null,
    caller_geo: context.geo,
    caller_ip: context.ip,
    server_region: context.server && context.server.region,
  };

  if (debug) {
    const [egress, snirh] = await Promise.all([
      fetch("https://api.ipify.org?format=json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      snirhStatus(outbound),
    ]);
    probe.egress_ip = egress && egress.ip;
    probe.snirh_status = snirh;
  }

  probe.verdict = debug
    ? probe.snirh_status && probe.snirh_status.ok
      ? "PASS: SNIRH allowed the edge egress IP"
      : "FAIL: SNIRH rejected the edge egress IP (403 likely)"
    : "set ?debug=1 to probe";

  return json({ ok: true, data: probe });
}

export const config = { path: "/api/albufeiras" };