import { normalizeEvent, handleOptions, ok, fail, upstreamJson } from "./utils.js";
import { FX_BASE, FX_TTL, FX_SYMBOLS } from "./env.js";

// EUR reference exchange rates from the European Central Bank, served by
// Frankfurter (no API key, ~84 central banks aggregated). We also pull the
// previous business day to compute a daily change for each pair.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  const symbols = FX_SYMBOLS.split(",").map(s => s.trim()).filter(Boolean).join(",");

  const cur = await upstreamJson(`${FX_BASE}/latest?base=EUR&symbols=${encodeURIComponent(symbols)}`);
  if (cur.status !== 200 || !cur.body || !cur.body.rates) {
    return fail(502, "Upstream Frankfurter request failed", { upstreamStatus: cur.status });
  }

  // Change is measured against the previous business day BEFORE the latest
  // published date (walking back from "today" could land on the same date).
  const baseDate = cur.body.date || fmt(today);
  const prev = await prevBusinessDay(`${FX_BASE}`, symbols, baseDate);

  const rates = {};
  for (const [code, val] of Object.entries(cur.body.rates)) {
    const prevVal = prev.body?.rates?.[code];
    const prevRate = prevVal != null ? Number(prevVal) : null;
    const rate = Number(val);
    rates[code] = {
      rate,
      change_pct: prevRate ? Math.round(((rate - prevRate) / prevRate) * 10000) / 100 : null,
      prev: prevRate,
    };
  }

  return ok({
    source: "ECB / Frankfurter",
    base: "EUR",
    date: baseDate,
    rates,
  }, { ttl: FX_TTL });
}

// Fetch rates for the most recent business day strictly BEFORE `afterDate`,
// walking back up to five calendar days (weekends + ECB holidays → 404s we
// skip; upstream timeouts → treated as a miss so the loop keeps going).
async function prevBusinessDay(base, symbols, afterDate) {
  const d = new Date(afterDate);
  for (let i = 1; i <= 5; i++) {
    d.setDate(d.getDate() - 1);
    try {
      const { status, body } = await upstreamJson(
        `${base}/${d.toISOString().slice(0, 10)}?base=EUR&symbols=${encodeURIComponent(symbols)}`,
      );
      if (status === 200 && body?.rates) return { status, body };
    } catch {
      // network error / abort — skip this date, keep walking
    }
  }
  return { status: 404, body: null };
}
