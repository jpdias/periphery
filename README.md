# periphery

ESP8266 dashboard that lives at the edge of your network: a TFT wall display,
plus a web dashboard of live Portuguese/global data, backed by a thin Netlify
API layer.

```
periphery/
├── firmware/   # ESP8266 (Wemos D1 mini) + 1.8" ST7735 TFT dashboard
├── server/     # Netlify Functions API (/api/<widget>) + local dev server
└── web/        # Static dashboard frontend, hosted on GitHub Pages
```

| Part | What it does | Where it runs |
|------|--------------|---------------|
| `firmware/` | Clock, incidents geofence alerts, forecast, flight radar, ESPHome sensors on a small TFT | On the ESP8266 device |
| `server/` | Aggregates + caches 20+ data feeds (weather, warnings, trains, flights, radiation, grid, seismic…) behind CORS-restricted Netlify Functions | Netlify (API only) |
| `web/` | Desktop dashboard with the same widgets, reorderable cards, alert toasts, PWA | GitHub Pages at `https://jpdias.me/periphery/` |

## Layout

- **`firmware/`** — Arduino/PlatformIO firmware (see its README for screens,
  hardware wiring, and configuration). Talks to the API via `api_base` +
  `use_api_proxy`, sending `X-Periphery-Raw: 1` for raw upstream passthrough.
- **`server/`** — zero-dependency Netlify Functions + a local dev server
  (`npm run dev:light` → `http://localhost:8080` serves `web/public` and the
  API). Central config in `functions/env.js`, overridable via `.env`/Netlify env
  vars.
- **`web/`** — static frontend (`config.js` + `app.js`), PWA with offline
  caching, deployed to GitHub Pages by `.github/workflows/pages.yml`.

## Architecture

```
ESP8266 ─┐                        ┌─→ open-meteo, IPMA, Celestrak, USGS, REN…
         │  /api/<widget>         │
browser ─┴──→ Netlify Functions ──┴─→ weather, incidents, trains, flights,
         (GitHub Pages,             radiation, air quality, seismic, fuel,
          CORS = jpdias.me)          FX, PSI, lightning, satellites, …
```

- The web frontend is served by **GitHub Pages**; it calls the **Netlify API**
  cross-origin. The API sends `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`
  (default `https://jpdias.me`), so only the dashboard host can call it from a
  browser. Firmware doesn't send an `Origin` header and is unaffected.
- Responses are cached (`Cache-Control: public, max-age=TTL,
  stale-while-revalidate=60`); the frontend stores its config in `localStorage`.
- Everything geo-aware: the API answers `in_pt`/`region`; PT-only widgets
  (trains, incidents, warnings) hide and IPMA forecast falls back to Open-Meteo
  when the location is outside Portugal.

## Local development

```bash
cd server
npm install
cp .env.example .env      # edit with real values (secrets never committed)
npm run dev:light         # http://localhost:8080 — serves web/public + API
```

Lint / format / syntax check at the repo root:

```bash
npm run lint
npm run format
```

See `server/README.md` for the full API contract and `web/README.md` for the
frontend config (`apiBase`, units, alerts, clocks).

## Deploy

- **API** → Netlify (repo connected; `server/netlify.toml` has no publish dir).
  Set the env vars from `.env.example` (secrets: `ARC_GIS_URL`, `ARC_GIS_TOKEN`,
  `IPINFO_TOKEN`; `ALLOWED_ORIGIN` must be `https://jpdias.me`). The site is
  behind Netlify Edge Access — add an allow rule for `/.netlify/functions/*`
  (or `/api/*`) so the Pages frontend can reach it.
- **Web** → GitHub Pages. The repo must be named `periphery` so Pages serves
  under `/periphery/`; `.github/workflows/pages.yml` uploads `web/public` and
  writes the `CNAME` for `jpdias.me`.
- **Device** → flash `firmware/` (see its README).
