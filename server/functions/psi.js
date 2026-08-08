import { handleOptions, ok, fail, upstreamJson, cachedFetch } from "./utils.js";
import { PSI_BASE, PSI_SYMBOL, PSI_TTL } from "./env.js";

// Lisbon stock index (PSI) from Yahoo Finance's chart endpoint. This is the
// only free, keyless, working source we found for the index itself (Euronext
// encrypts its live quotes; Google Finance needs scraping). Yahoo needs a
// browser-ish User-Agent.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const symbol = event.queryStringParameters?.symbol || PSI_SYMBOL;
  const url = `${PSI_BASE}/${encodeURIComponent(symbol)}?range=1d&interval=1d&includePrePost=false`;
  const { status, body } = await cachedFetch(`psi:${url}`, PSI_TTL * 1000,
    () => upstreamJson(url, { headers: { "User-Agent": UA } }),
    ({ status } = {}) => status === 200);
  if (status !== 200 || !body || !body.chart?.result?.length) {
    return fail(502, "Upstream Yahoo Finance request failed", { upstreamStatus: status });
  }

  const r = body.chart.result[0];
  const meta = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const open = first(q.open);
  const price = meta.regularMarketPrice ?? last(q.close);
  const prev = meta.chartPreviousClose;
  const dayHigh = meta.regularMarketDayHigh ?? maxOf(q.high);
  const dayLow = meta.regularMarketDayLow ?? minOf(q.low);

  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;

  return ok({
    source: "Yahoo Finance (LIS)",
    symbol,
    name: meta.shortName || meta.longName || "PSI",
    currency: meta.currency || "EUR",
    market_time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    market_state: meta.marketState || null,
    price,
    open,
    prev_close: prev,
    day_high: dayHigh,
    day_low: dayLow,
    change,
    change_pct: changePct != null ? Math.round(changePct * 100) / 100 : null,
    fifty_two_week: {
      high: meta.fiftyTwoWeekHigh ?? null,
      low: meta.fiftyTwoWeekLow ?? null,
    },
  }, { ttl: PSI_TTL });
}

function first(arr) { return Array.isArray(arr) ? arr.find(v => v != null) : null; }
function last(arr) { return Array.isArray(arr) ? arr[arr.length - 1] : null; }
function maxOf(arr) {
  if (!Array.isArray(arr)) return null;
  const vals = arr.filter(v => v != null);
  return vals.length ? Math.max(...vals) : null;
}
function minOf(arr) {
  if (!Array.isArray(arr)) return null;
  const vals = arr.filter(v => v != null);
  return vals.length ? Math.min(...vals) : null;
}
