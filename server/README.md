# miniDash Server

Netlify Functions + local dev server for the miniDash dashboard. Provides the
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
│   └── ip.js          /api/ip
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
