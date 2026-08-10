// Frontend config — the client-side analog of env.h. Loaded before app.js.
// Defaults live here; users override at runtime via the ⚙ settings (stored in
// localStorage). The API base is auto-detected when empty (same-origin /api/*,
// which works under netlify dev and the light dev server).
window.PERIPHERY_CONFIG = {
  apiBase: "https://prismatic-horse-4c465a.netlify.app", // Netlify API host; "" = same-origin
  useApiProxy: true,    // route widget fetches through the API functions
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
  defaultSatellites: [
    { id: "25544", name: "ISS" },
    { id: "48274", name: "Tiangong" },
    { id: "20580", name: "Hubble" },
  ],
  defaultClocks: [],
  hiddenWidgets: [],
  alerts: ["incidents", "warnings"],
  units: {
    temperature: "C",
    wind: "kmh",
    distance: "km",
    pressure: "hPa",
  },
};
