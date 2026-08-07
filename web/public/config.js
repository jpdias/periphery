// Frontend config — the client-side analog of env.h. Loaded before app.js.
// Defaults live here; users override at runtime via the ⚙ settings (stored in
// localStorage). The API base is auto-detected when empty (same-origin /api/*,
// which works under netlify dev and the light dev server).
window.MINIDASH_CONFIG = {
  apiBase: "",          // e.g. "https://minidash.netlify.app" ("" = same-origin)
  useApiProxy: true,    // route widget fetches through the API functions
  defaultLat: 41.17,
  defaultLon: -8.43,
  defaultFlightRange: 25,
  refreshMs: 60000,
};
