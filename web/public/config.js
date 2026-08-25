// Frontend config — the client-side analog of env.h. Loaded before app.js.
// Defaults live here; users override at runtime via the ⚙ settings (stored in
// localStorage). The API base is auto-detected when empty (same-origin /api/*,
// which works under netlify dev and the light dev server).
window.PERIPHERY_CONFIG = {
  apiBase: "https://prismatic-horse-4c465a.netlify.app", // Netlify API host; "" = same-origin
  useApiProxy: true, // route widget fetches through the API functions
  defaultLat: 41.17,
  defaultLon: -8.43,
  defaultFlightRange: 25,
  refreshMs: 60000,
  defaultUptimeSites: [
    { label: "Open-Meteo", url: "https://api.open-meteo.com" },
    { label: "NOAA SWPC", url: "https://services.swpc.noaa.gov" },
    { label: "USGS", url: "https://earthquake.usgs.gov" },
    { label: "APA", url: "https://sniambgeoogc.apambiente.pt" },
  ],
  earthquakeRadius: 1500,
  lightningRadius: 500,
  defaultClocks: [],
  hiddenWidgets: [],
  alerts: ["incidents", "warnings"],
  units: {
    temperature: "C",
    wind: "kmh",
    distance: "km",
    pressure: "hPa",
  },
  // External link templates per widget. Each {placeholder} resolves from
  // item-level data first, then falls back to cfg.lat / cfg.lon. Set a
  // value to null to disable linking for that widget.
  cardUrls: {
    weather: "https://www.windy.com/{lat}/{lon}",
    forecast: "https://www.windy.com/{lat}/{lon}",
    sunmoon: "https://www.timeanddate.com/sun/@{lat},{lon}",
    flights: "https://globe.adsbexchange.com/?icao={hex}",
    trains: "https://servicos.infraestruturasdeportugal.pt/pt-pt/estacoes?estacaoId={station}",
    incidents: "https://prociv.gov.pt/pt/ocorrencias/",
    seismic: "https://www.emsc-csem.org/",
    lightning: "https://map.blitzortung.org/#6.09/{lat}/{lon}",
    satellites: "https://www.n2yo.com/passes/?s={id}&lat={lat}&lng={lon}",
    warnings: "https://www.ipma.pt/pt/otempo/prev-sam/",
    fuel: "https://precoscombustiveis.dgEG.pt/",
    albufeiras: "https://infoagua.apambiente.pt/pt/seca",
    fx: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
    psi: "https://finance.yahoo.com/quote/{symbol}/",
    solar: "https://www.swpc.noaa.gov/",
    radiation: "https://safecast.org/radiation-map/",
    airquality: "https://www.iqair.com/",
    moon: "https://www.timeanddate.com/moon/@{lat},{lon}",
    astro: "https://www.amsmeteors.org/meteor-showers/meteor-shower-calendar/",
    ren: "https://datahub.ren.pt/en/",
    propagation: "https://www.hamqsl.com/solarmap.php",
  },
};
