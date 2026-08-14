import {
  normalizeEvent,
  handleOptions,
  ok,
  fail,
  upstreamJson,
  toQuery,
  cachedFetch,
} from "./utils.js";
import { DGEG_BASE, FUEL_PATH, FUEL_TTL, FUEL_IDS } from "./env.js";

// Portuguese average fuel prices straight from the DGEG official portal
// (precoscombustiveis.dgeg.gov.pt). Preço médio diário is published once a day
// on the portal; its own JS fetches /api/PrecoComb/PMD, which returns avg, min
// and max price per fuel type per day plus station count. We surface the road
// fuels people actually use, plus the overall date.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const params = {
    idsTiposComb: Object.values(FUEL_IDS).join(","),
    dataIni: fmt(yesterday),
    dataFim: fmt(today),
    qtdPorPagina: 20,
    pagina: 1,
    orderDesc: 1,
  };
  const url = `${DGEG_BASE}${FUEL_PATH}?${toQuery(params)}`;

  const { status, body } = await cachedFetch(
    `fuel:${url}`,
    6 * 3600 * 1000,
    () => upstreamJson(url),
    ({ status } = {}) => status === 200,
  );
  if (status !== 200 || !body || !body.status || !Array.isArray(body.resultado)) {
    return fail(502, "Upstream DGEG request failed", { upstreamStatus: status });
  }

  // Prices arrive as strings in the "1,8854 €/litro"-style format (comma
  // decimal). Strip anything after the number, then swap the comma.
  const parseEur = (s) => {
    const m = String(s).match(/[\d.]+,[\d]+|[\d]+\.[\d]+/);
    return m ? Number(m[0].replace(",", ".")) : NaN;
  };

  // The PMD feed doesn't echo the numeric type id, only the descriptive name.
  // Map each widget slug to the exact TipoCombustivel string the API returns.
  const nameById = {
    3201: "Gasolina simples 95",
    3400: "Gasolina 98",
    2101: "Gasóleo simples",
    2105: "Gasóleo especial",
    1120: "GPL Auto",
    1143: "GNC (gás natural comprimido) - €/kg",
  };

  const byName = {};
  for (const row of body.resultado) {
    (byName[row.TipoCombustivel] ||= []).push(row);
  }

  const fuels = Object.keys(FUEL_IDS)
    .map((slug) => {
      const rows = byName[nameById[FUEL_IDS[slug]]] || [];
      // The orderDesc=1 feed groups by date; take the most recent published day.
      const daily = rows.slice().sort((a, b) => (b.Data || "").localeCompare(a.Data || ""))[0];
      if (!daily) return null;
      return {
        slug,
        name: daily.TipoCombustivel,
        avg: parseEur(daily.PrecoMedioC4 || daily.PrecoMedio),
        min: parseEur(daily.PrecoMin),
        max: parseEur(daily.PrecoMax),
        stations: daily.NumPostos ?? null,
      };
    })
    .filter(Boolean);

  const date = fuels.length
    ? Object.values(byName)
        .flat()
        .map((r) => r.Data)
        .sort((a, b) => b.localeCompare(a))[0]
    : null;

  return ok(
    {
      source: "DGEG (precoscombustiveis.dgeg.gov.pt)",
      date,
      updated_at: date ? `${date}T00:00:00Z` : null,
      currency: "EUR",
      fuels,
    },
    { ttl: FUEL_TTL },
  );
}
