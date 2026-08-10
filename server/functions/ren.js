import { normalizeEvent, handleOptions, ok, fail, upstreamJson, cachedFetch } from "./utils.js";
import { REN_BASE, REN_TTL, REN_MAX } from "./env.js";

// Portuguese national grid live mix from the REN Data Hub (no auth). The API
// lives under /datahubapi/electricity/ and is occasionally flaky, so each
// dataset is fetched independently and the response includes whatever made it
// through, plus `degraded: true`.
//   ElectricityProductionBreakdownDaily — 96 x 15-min slots per day, one series
//     per source (Hydro, Solar, Wind, Natural Gas, Coal, Biomass, Wave, ...).
//   ElectricityConsumptionSupplyDaily  — flat array of {type, daily_Accumulation}.
// The OMIE day-ahead price endpoint was removed from the public API (404), so
// `price` is left null.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const today = new Date();
  // Try today, falling back to yesterday (and the day before) since the day is
  // only complete after midnight.
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Cache the assembled result in-process so we don't hammer the (sometimes
  // down, sometimes rate-limited) REN upstream on every 60s client poll.
  return cachedFetch(`ren:${dates[0]}`, REN_TTL * 1000, async () => {
    const [breakdown, supply] = await Promise.all([
      fetchBreakdown(dates), fetchSupply(dates),
    ]);
    const result = assemble(breakdown, supply, dates);
    // Don't cache a total outage — let the next poll retry the upstream.
    return { fail: result.fail, body: result.body };
  }, r => !r.fail).then(r => {
    if (r.fail) return fail(502, r.body.error, r.body.extra);
    return ok(r.body, { ttl: REN_TTL });
  });
}

function assemble(breakdown, supply, dates) {
  if (breakdown.error && supply.error) {
    return { fail: true, body: {
      error: "REN Data Hub unavailable",
      extra: { upstreamError: breakdown.error || supply.error },
    } };
  }
  return { fail: false, body: {
    source: "REN Data Hub",
    date: breakdown.date || supply.date || dates[0],
    degraded: Boolean(breakdown.error || supply.error),
    errors: {
      breakdown: breakdown.error || null,
      supply: supply.error || null,
    },
    mix: breakdown.mix || null,
    supply: supply.supply || null,
    price: null,   // day-ahead €/MWh no longer exposed by the public API
  } };
}

// Pick the latest date whose response actually parsed and had series data.
async function fetchBreakdown(dates) {
  for (const date of dates) {
    const url = `${REN_BASE}/ElectricityProductionBreakdownDaily?culture=en-US&date=${date}`;
    const { status, body } = await upstreamJson(url);
    if (status !== 200 || !body || !Array.isArray(body.series)) continue;
    const series = body.series.filter(s => Array.isArray(s.data));
    if (!series.length) continue;
    return { date, mix: buildMix(series, body.xAxis?.[0]?.categories || []) };
  }
  return { error: "No usable production breakdown" };
}

// Latest non-null value per source + aggregate stats for the day.
function buildMix(series, categories) {
  const last = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = Number(arr[i]);
      if (isFinite(v)) return v;
    }
    return null;
  };

  const byName = {};
  for (const s of series) byName[s.name] = s;

  const read = (names) => {
    for (const n of names) {
      const s = byName[n];
      if (s) { const v = last(s.data); if (v != null) return v; }
    }
    return null;
  };

  const hydro = read(["Hydro", "Hidrica", "Hidráulica"]);
  const solar = read(["Solar", "Fotovoltaica", "PV"]);
  const wind = read(["Wind", "Eólica"]);
  const gas = read(["Natural Gas", "Gás Natural"]);
  const coal = read(["Coal", "Carvão"]);
  const biomass = read(["Biomass", "Biomassa"]);
  const wave = read(["Wave", "Ondas"]);
  const otherThermal = read(["Other Thermal", "Outras Térmicas"]);
  const consumption = read(["Consumption", "Consumo"]);
  const consumptionStorage = read(["Consumption + Storage", "Consumption+Storage", "Consumo+Bombagem", "Consumo+Armazenamento"]);
  const exportMw = read(["Export", "Exportação"]);
  const importMw = read(["Import", "Importação"]);

  const gen = [hydro, solar, wind, gas, coal, biomass, wave, otherThermal]
    .filter(v => v != null).reduce((a, b) => a + b, 0);
  const res = [hydro, solar, wind].filter(v => v != null).reduce((a, b) => a + b, 0);

  return {
    units: "MW",
    consumption: consumption,
    consumption_plus_storage: consumptionStorage,
    export_mw: exportMw,
    import_mw: importMw,
    sources: {
      hydro, solar, wind, natural_gas: gas, coal, biomass, wave, other_thermal: otherThermal,
    },
    renewable_mw: res || null,
    renewable_share_pct: gen > 0 ? Math.round((res / gen) * 1000) / 10 : null,
    slots: (categories[0] && categories[categories.length - 1])
      ? `${categories[0]} → ${categories[categories.length - 1]}`
      : null,
    slot_count: REN_MAX,
  };
}

// Daily accumulated energy by type. The endpoint now returns a flat array of
// { type, daily_Accumulation } rows (e.g. CONSUMPTION, WIND, SOLAR, HYDRO...),
// sorted roughly by importance. We keep the most useful keys as named fields
// and also expose the raw map.
async function fetchSupply(dates) {
  for (const date of dates) {
    const url = `${REN_BASE}/ElectricityConsumptionSupplyDaily?culture=en-US&date=${date}`;
    const { status, body } = await upstreamJson(url);
    if (status !== 200 || !Array.isArray(body)) continue;
    if (!body.length) continue;
    const daily = {};
    for (const row of body) {
      const type = String(row.type || "").toUpperCase();
      const val = Number(row.daily_Accumulation);
      if (type && isFinite(val)) daily[type] = val;
    }
    if (!Object.keys(daily).length) continue;
    const g = (k) => daily[k] ?? null;
    return {
      date,
      supply: {
        units: "MWh",
        daily,
        consumption: g("CONSUMPTION"),
        consumption_plus_storage: g("CONSUMPTION_FOR_STORAGE"),
        wind: g("WIND"),
        solar: g("SOLAR"),
        hydro: g("HYDRO"),
        natural_gas: g("NATURAL_GAS"),
        biomass: g("BIOMASS"),
        imports: g("IMPORTS"),
        exports: g("EXPORTS"),
        total_generation: g("TOTAL_GENERATION"),
        renewable_generation: g("RENEWABLE_GENERATION"),
        non_renewable_generation: g("NON-RENEWABLE_GENERATION"),
      },
    };
  }
  return { error: "No usable supply data" };
}
