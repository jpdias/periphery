# PTMonitor Server

Netlify Functions + local dev server for the PTMonitor dashboard. Provides the
`/api/<widget>` endpoints consumed by both the web frontend (`../web`) and the
device firmware (via the `api_base` / `use_api_proxy` config).

## Layout

```
server/
├── functions/     # Netlify Functions (per widget)
│   ├── env.js     # central config: every URL/token/tunable with defaults
│   ├── utils.js
│   ├── weather.js     /api/weather
│   ├── forecast.js    /api/forecast
│   ├── moon.js        /api/moon
│   ├── incidents.js   /api/incidents
│   ├── flights.js     /api/flights
│   ├── trains.js      /api/trains
│   ├── ip.js          /api/ip
│   ├── radiation.js   /api/radiation   (APA RADNET gamma dose rate)
│   ├── airquality.js  /api/airquality  (APA QualAr IQAR + pollutants)
│   ├── astro.js       /api/astro       (IMO meteor shower calendar)
│   ├── uptime.js      /api/uptime      (configurable HTTP site monitors)
│   ├── earthquake.js  /api/earthquake  (USGS feed, geo-filtered)
│   ├── lightning.js   /api/lightning   (Blitzortung strikes via relay)
│   ├── warnings.js    /api/warnings    (IPMA district weather avisos)
│   ├── satellites.js  /api/satellites  (Celestrak TLE + SGP4 next passes)
│   ├── ren.js         /api/ren         (REN national grid: mix + supply + €/MWh)
│   ├── seismic.js     /api/seismic     (IPMA seismic activity, distances)
│   ├── fuel.js        /api/fuel        (DGEG fuel prices via API Aberta)
│   ├── fx.js          /api/fx          (ECB EUR reference rates)
│   └── psi.js         /api/psi         (PSI Lisbon index via Yahoo Finance)
├── dev-server.mjs  # zero-dep local dev server (no netlify-cli needed)
├── netlify.toml
├── package.json
├── .env.example    # copy to .env for local dev
└── .env            # local values (gitignored)
```

## API contract

Every widget endpoint is `GET /api/<widget>` and returns:

```json
{ "ok": true, "data": { ... } }
```

or on failure:

```json
{ "ok": false, "error": "message", "upstreamStatus": 502 }
```

Responses are cached with `Cache-Control: public, max-age=TTL,
stale-while-revalidate=60`. When the caller sends `X-Minidash-Raw: 1` (the
firmware), the function returns the upstream body verbatim so the ESP8266
streaming parsers work unchanged.

Newer geo widgets take `lat`/`lon` (and optional `radius` for earthquakes /
lightning) and return the nearest matching source. `uptime` is unique: the
frontend passes the site list as a JSON `sites` param (`[{label,url}]`), so no
redeploy is needed to add monitors. `satellites` takes a JSON `sats` param
(`[{id,name}]` — NORAD catalogue numbers, defaulting to ISS/Tiangong/Hubble) and
returns next passes computed with SGP4 (`satellite.js`); its data comes from
Celestrak TLE feeds.

## National infrastructure & economy widgets

- **`ren`** — Portuguese grid live demand, per-source generation mix, renewable
  share and daily energy totals from the REN Data Hub. The upstream is
  occasionally flaky, so each dataset is fetched independently and
  `degraded: true` is set when part of it is missing. (REN removed the OMIE
  day-ahead €/MWh endpoint from its public API, so `price` is always null.)
- **`seismic`** — recent quakes for Portugal from IPMA's open-data feeds
  (mainland + Azores), merged, deduped and tagged with distance from the
  observer. Raises alerts for M ≥ 4.0.
- **`fuel`** — national average, min/max and station count for road fuels
  (95/98 gasoline, diesel, LPG) from DGEG data via API Aberta (no key).
- **`fx`** — EUR reference rates (USD, GBP, CHF, JPY, BRL, CNY) from the ECB via
  Frankfurter, with the previous business day for a daily % change.
- **`psi`** — PSI (Lisbon) index level, daily change and 52-week range. Euronext
  encrypts its live quotes and Google Finance is scrape-only, so this uses
  Yahoo Finance's chart endpoint with a browser User-Agent.

## Environment variables

All defaults live in `functions/env.js` (the analog of the firmware `env.h`).
Override any as Netlify env vars (production) or in `.env` (local dev). Secrets
(`ARC_GIS_URL`, `ARC_GIS_TOKEN`, `IPINFO_TOKEN`) must be set in the Netlify UI —
never committed. See `.env.example` for the full list.

## Local development

```bash
npm install                          # installs netlify-cli (dev dependency)
cp .env.example .env                 # then edit with real values

# Option A — dev server (recommended; netlify dev may not work in your env):
npm run dev:light                    # http://localhost:8080

# Option B — full fidelity via netlify-cli:
npm run dev                          # http://localhost:8888
```

Static + API syntax checked with `npm run check`.
