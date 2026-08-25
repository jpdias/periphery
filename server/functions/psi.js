import { normalizeEvent, handleOptions, ok, fail, upstreamJson, cachedFetch } from "./utils.js";
import { PSI_BASE, PSI_SYMBOL, PSI_TTL } from "./env.js";

// Market indexes from Yahoo Finance. The card now shows multiple global
// indexes instead of a single configurable one.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DEFAULT_INDEXES = [
  { symbol: PSI_SYMBOL, short: "PSI 20" },
  { symbol: "^GSPC", short: "S&P 500" },
  { symbol: "^DJI", short: "Dow Jones" },
  { symbol: "^IXIC", short: "NASDAQ" },
  { symbol: "^FTSE", short: "FTSE 100" },
  { symbol: "^GDAXI", short: "DAX" },
  { symbol: "^N225", short: "Nikkei 225" },
  { symbol: "^HSI", short: "Hang Seng" },
];

async function fetchOne(symbol, short) {
  const url = `${PSI_BASE}/${encodeURIComponent(symbol)}?range=1d&interval=1d&includePrePost=false`;
  const { status, body } = await cachedFetch(
    `psi:${url}`,
    PSI_TTL * 1000,
    () => upstreamJson(url, { headers: { "User-Agent": UA } }),
    ({ status } = {}) => status === 200,
  );
  if (status !== 200 || !body || !body.chart?.result?.length) return null;

  const r = body.chart.result[0];
  const meta = r.meta || {};
  const q = r.indicators?.quote?.[0] || {};
  const price = meta.regularMarketPrice ?? last(q.close);
  const prev = meta.chartPreviousClose;
  const change = price != null && prev != null ? price - prev : null;
  const changePct = change != null && prev ? (change / prev) * 100 : null;

  return {
    symbol,
    short,
    name: meta.shortName || meta.longName || short,
    currency: meta.currency || "",
    price,
    change_pct: changePct != null ? Math.round(changePct * 100) / 100 : null,
  };
}

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const results = await Promise.all(DEFAULT_INDEXES.map((idx) => fetchOne(idx.symbol, idx.short)));

  return ok({ indexes: results.filter(Boolean) }, { ttl: PSI_TTL });
}

function last(arr) {
  return Array.isArray(arr) ? arr[arr.length - 1] : null;
}
