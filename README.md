# periphery

**periphery** is a "live edge dashboard" of Portuguese and global data, three
ways at once:

- an **ESP8266 + 1.8" TFT** wall display that lives at the edge of your network;
- a **web dashboard** (GitHub Pages PWA) with the same widgets, reorderable
  cards, alert toasts and offline caching;
- a thin **Netlify Functions API** that proxies and caches 20+ public data
  feeds, shared by the device and the browser.

```
periphery/
├── firmware/   # ESP8266 (Wemos D1 mini) + ST7735 TFT dashboard firmware
├── server/     # Netlify Functions API (/api/<widget>) + zero-dep dev server
└── web/        # Static dashboard frontend, deployed to GitHub Pages
```

| Part | What it does | Where it runs |
|------|--------------|---------------|
| `firmware/` | Clock, incidents geofence alerts, trains, forecast, flight radar, ESPHome sensors, system stats on a small TFT | On the ESP8266 device |
| `server/` | Aggregates + caches 20+ data feeds (weather, warnings, trains, flights, radiation, grid, seismic, fuel, FX, PSI…) behind CORS-restricted Netlify Functions | Netlify (API only) |
| `web/` | Desktop dashboard with the same widgets, reorderable/searchable cards, alert toasts, multi-clock, PWA | GitHub Pages at `https://jpdias.me/periphery/` |

---

## Table of contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Data sources](#data-sources)
- [Quick start](#quick-start)
  - [Server (local dev)](#server-local-development)
  - [Web dashboard](#web-dashboard)
  - [Device firmware](#firmware)
- [Configuration](#configuration)
  - [Server env](#server-environment-variables)
  - [Web config](#web-frontend-config)
  - [Firmware config](#firmware-configuration)
- [Deploy](#deploy)
  - [Netlify (API)](#netlify-api)
  - [GitHub Pages (web)](#github-pages-web)
  - [Device OTA](#ota-updates)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
 ESP8266 ─────────┐ │                                             │
                 ┌┴┐                       ┌─────────────────┐    │
 browser ────────┤ │  /api/<widget>        │ Netlify Edge /  │    │
 (GitHub Pages)  └┬┘   (X-Periphery-Raw,   │ Functions (TS)  │►───┴──► open-meteo, IPMA, REN,
                  │     CORS allowlist)    └─────────────────┘        adsb.fi, Celestrak, USGS,
                  │                                                ANEPC ArcGIS, IP, Safecast…
                  └────────────────────────────────────────────────┘
```

- **The API is the single door.** Both the firmware and the browser call the
  same `/api/<widget>` endpoints. The functions fetch a public upstream, parse,
  normalize, geo-tag and cache the result.
- **Raw passthrough for the device.** When the firmware sends
  `X-Periphery-Raw: 1`, a function returns the upstream body *verbatim* so the
  ESP8266's streaming parsers work unchanged — no server-side reshaping on the
  device path.
- **CORS-gated browser access.** The API sends
  `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>` (default
  `https://jpdias.me`), so only the dashboard host can call it from a browser.
  The firmware sends no `Origin` header and is unaffected.
- **Caching everywhere.** API responses carry `Cache-Control: public,
  max-age=TTL, stale-while-revalidate=60`; the web frontend adds a per-widget
  client-side freshness window; the firmware uses smart TTLs (e.g. fetch the
  next train batch only once the last shown departure has passed).
- **Geo-aware widgets.** The API answers `in_pt`/`region`; PT-only widgets
  (trains, incidents, warnings, REN, seismic, PSI, fuel, IPMA forecast) hide or
  fall back to a global source when the location is outside Portugal (e.g.
  IPMA forecast → Open-Meteo, RADNET radiation → Safecast, IPMA seismic → USGS).

## Repository layout

### `server/` — the API

Zero-dependency Netlify Functions. One function per widget plus shared helpers;
all tunables (URLs, TTLs, tokens) live in `functions/env.js`.

```
server/
├── functions/
│   ├── env.js            # central config: every URL/token/tunable w/ defaults
│   ├── utils.js          # fetch, cache, CORS, geo helpers, raw passthrough
│   ├── weather.js        #   /api/weather      (open-meteo current + AQ)
│   ├── forecast.js       #   /api/forecast     (IPMA daily / open-meteo fallback)
│   ├── moon.js           #   /api/moon         (NASA Horizons ephemeris)
│   ├── incidents.js      #   /api/incidents    (ANEPC ArcGIS geofence)
│   ├── flights.js        #   /api/flights      (adsb.fi ADS-B)
│   ├── trains.js         #   /api/trains       (Infraestruturas de Portugal)
│   ├── stations.js       #   /api/stations     (IP station search)
│   ├── ip.js             #   /api/ip           (ipinfo.io external IP)
│   ├── radiation.js      #   /api/radiation    (APA RADNET + Safecast fallback)
│   ├── airquality.js     #   /api/airquality   (APA QualAr IQAR + pollutants)
│   ├── astro.js          #   /api/astro        (IMO meteor shower calendar)
│   ├── uptime.js         #   /api/uptime       (configurable HTTP site monitors)
│   ├── earthquake.js     #   /api/earthquake   (USGS feed, geo-filtered)
│   ├── lightning.js      #   /api/lightning    (Blitzortung strikes via relay)
│   ├── warnings.js       #   /api/warnings     (IPMA district weather avisos)
│   ├── satellites.js     #   /api/satellites   (Celestrak TLE + SGP4 next passes)
│   ├── ren.js            #   /api/ren          (REN national grid: mix/supply/€/MWh)
│   ├── seismic.js        #   /api/seismic      (IPMA mainland + Azores, distances)
│   ├── fuel.js           #   /api/fuel         (DGEG fuel prices via API Aberta)
│   ├── fx.js             #   /api/fx           (ECB EUR reference rates)
│   ├── psi.js            #   /api/psi          (PSI Lisbon index via Yahoo)
│   ├── solar.js          #   /api/solar        (NOAA SWPC X-ray/Kp)
│   ├── propagation.js    #   /api/propagation  (HF propagation / space weather)
│   └── region.js         #   /api/region       (PT region detection)
├── netlify.toml          # functions dir + /api/* rewrite (no publish dir)
├── dev-server.mjs        # local dev server: serves web/public + API on :8080
├── .env.example          # copy to .env for local dev (never commit secrets)
└── package.json
```

See [server/README.md](server/README.md) for the full API contract.

### `web/` — the frontend

Static, dependency-free (no build step) dashboard served from GitHub Pages.

```
web/
└── public/
    ├── index.html
    ├── style.css
    ├── config.js          # client defaults (analog of firmware env.h)
    ├── app.js             # fetch, cache, render, drag-drop, alerts, settings
    ├── manifest.json      # PWA metadata
    └── sw.js              # service worker: network-first shell, offline cache
```

Available widgets (all toggleable/reorderable in the ⚙ settings): **Clock**
(+ multiple extra clocks with timezones), **Sun & Moon**, **Weather**,
**Space Weather (solar)**, **Forecast**, **Incidents**, **Weather Warnings**,
**Trains**, **Flights**, **Radiation**, **Air Quality**, **Meteor Showers**,
**Uptime monitors**, **Lightning**, **Satellites**, **National Grid (REN)**,
**Seismic**, **Fuel Prices**, **FX Rates**, **PSI**, **Propagation**, **System**.
The frontend stores its config (units, alerts, hidden widgets, card order) in
`localStorage`.

### `firmware/` — the device

Arduino/PlatformIO firmware for the Wemos D1 mini + ST7735 TFT. See
[firmware/README.md](firmware/README.md) for screens, wiring, build and
troubleshooting. Key modules:

```
firmware/src/
├── main.cpp         # setup(), boot sequence, loop, screen dispatch
├── config.*         # Config struct, LittleFS JSON config (web-editable)
├── netfsm.*         # shared non-blocking HTTP state machine (weather/forecast/ip)
├── httpfsm.*        # generic HttpFsm fetch/read helper
├── nettime.*        # NTP sync + TZ (POSIX string from IANA dropdown)
├── portal.*         # WiFiManager portal + admin UI + /logtext + /update (OTA)
├── trains.*         # rolling-cursor train departures (adaptive window)
├── incidents.*      # geofence incidents + ALERTA popup
├── flight.*         # polar flight radar
├── moon.*           # sun/moon at boot + once per day
├── esphome.*        # ESPHome REST sensor reads
├── netmon.*         # HTTP reachability monitors
├── bodyutil.h       # shared body parsing: slice_json, body_is_complete
├── tlslock.*        # single-TLS-session lock (heap guard)
├── logbuf.*         # on-device log ring buffer (web-visible)
└── ui.*             # all screen rendering on the TFT
```

## Data sources

All upstream feeds are reached **through the API layer** (the firmware's only
direct network talk is NTP). Sources:

| Widget | `/api/…` | Upstream |
|--------|----------|----------|
| Weather / AQ | `weather` | [open-meteo](https://open-meteo.com) (no key) |
| Forecast | `forecast` | [IPMA](https://api.ipma.pt) (falls back to Open-Meteo outside PT) |
| Sun & Moon | `moon` | NASA JPL Horizons ephemeris |
| Incidents | `incidents` | ANEPC Ocorrencias ArcGIS FeatureServer |
| Trains | `trains` + `stations` | Infraestruturas de Portugal |
| Flights | `flights` | [adsb.fi](https://adsb.fi) open ADS-B |
| External IP | `ip` | ipinfo.io |
| Radiation | `radiation` | APA RADNET (Safecast fallback) |
| Air quality | `airquality` | APA QualAr |
| Meteor showers | `astro` | IMO |
| Uptime monitors | `uptime` | your configured sites |
| Earthquakes | `earthquake` | USGS GeoJSON feeds |
| Lightning | `lightning` | Blitzortung relay |
| Weather warnings | `warnings` | IPMA open data |
| Satellites | `satellites` | Celestrak TLE + SGP4 |
| National grid | `ren` | REN Data Hub |
| Seismic | `seismic` | IPMA (mainland + Azores), USGS fallback |
| Fuel prices | `fuel` | DGEG via API Aberta (no key) |
| FX rates | `fx` | ECB reference rates via Frankfurter |
| Stock index | `psi` | Yahoo Finance (PSI20.LS) |
| Space weather | `solar` | NOAA SWPC GOES products |
| Propagation | `propagation` | HF / space-weather summary |

## Quick start

### Server — local development

```bash
cd server
npm install
cp .env.example .env      # edit with real values (secrets never committed)
npm run dev:light         # http://localhost:8080 — serves web/public + API
```

`npm run dev` (Option B) runs the full-fidelity Netlify experience via
`netlify-cli` on `:8888` when it works in your environment.

Root-level tooling (Node):

```bash
npm install                # devDependencies (eslint + prettier)
npm run lint               # eslint on server + web
npm run format             # prettier write
npm run format:check       # prettier verify
```

Firmware tooling (PlatformIO + Python, separate):
see [firmware/README.md](firmware/README.md#code-quality-tools).

### Web dashboard

The static site alone can be served by any static file server, or just run the
server's dev mode above. Configure your location and preferences through the ⚙
settings button (stored in `localStorage`; a geolocation button fills
coordinates automatically). `apiBase` in `web/public/config.js` points at the
Netlify API host — leave it `""` for same-origin `/api/*` during local dev.

### Firmware

```bash
cd firmware
pio run              # build
pio run -t upload    # flash firmware
pio run -t uploadfs  # flash LittleFS image (web pages in data/)
```

See [firmware/README.md](firmware/README.md) for the boot sequence, hardware
wiring, every screen, and the full troubleshooting log.

## Configuration

### Server environment variables

All defaults live in `functions/env.js`; override any as Netlify env vars
(production) or in `.env` (local dev). Secrets (`ARC_GIS_URL`, `ARC_GIS_TOKEN`,
`IPINFO_TOKEN`) **must** be set in the Netlify UI — never committed.
`ALLOWED_ORIGIN` controls the browser CORS allowlist (default
`https://jpdias.me`). See [`.env.example`](server/.env.example) for the full
list of every URL/TTL/token.

### Web frontend config

`web/public/config.js` → `window.PERIPHERY_CONFIG` holds client defaults
(apiBase, lat/lon, flight range, refresh interval, default monitors,
satellites, units, alerts). Runtime ⚙ settings override it from
`localStorage`. See [web/README.md](web/README.md).

### Firmware configuration

First boot opens a `periphery-Setup` AP (pw `peripherypass`) for WiFi +
location. Once connected, the device serves a config page at its IP (port 80)
with a live terminal panel, and mDNS `http://<hostname>.local`. Configurable:

- WiFi SSID / password, **hostname** (mDNS/DHCP)
- Latitude / longitude, timezone (DST-aware dropdown)
- Weather refresh interval, night hours (screen-off window), NTP resync interval
- **ESPHome** host + `slug=label` sensor pairs
- **Monitor** hosts (HTTP reachability)
- **Flight radar range** (nm, 0 disables the screen)
- **IP station** node ID + display name (Trains screen)
- **Enabled screens** (per-screen checkboxes), **backlight control** polarity
- **API base** URL (the Netlify proxy)

Saving reboots the device. Config is stored in LittleFS as `/config.json`;
legacy EEPROM config is imported once on first boot after upgrade.

## Deploy

### Netlify (API)

1. Connect the repo to Netlify. `server/netlify.toml` sets the functions dir
   and has **no publish directory** — Netlify hosts the API only.
2. Set env vars in the Netlify UI (copy the list from `.env.example`; secrets
   required: `ARC_GIS_URL`, `ARC_GIS_TOKEN`, `IPINFO_TOKEN`; ensure
   `ALLOWED_ORIGIN` is `https://jpdias.me`).
3. **Edge Access**: the site is behind Netlify Edge Access — add an allow rule
   for `/.netlify/functions/*` (or `/api/*`) so the GitHub Pages frontend can
   reach it; CORS then gates browser access to the allowed origin.

### GitHub Pages (web)

`.github/workflows/pages.yml` deploys `web/public` on pushes touching it (or
`workflow_dispatch`). Pages must be served under `/periphery/`, so the repo
must be named `periphery`; the workflow writes the `CNAME` for `jpdias.me`.

### OTA updates (device)

An OTA web updater is mounted at `http://<device-ip>/update` (or
`http://<hostname>.local/update`); the config page also has an upload form.
Both **firmware** (`firmware.bin`) and **filesystem** (`littlefs.bin`) images
are accepted and auto-detected. Build with `pio run` / `pio run -t buildfs` and
upload the `.pio/build/<env>/*.bin` files.

```bash
# typical update loop (from the repo root, firmware built):
curl -F "firmware=@.pio/build/wemos_d1_mini/firmware.bin" http://<device-ip>/update
# then watch the boot log:
curl http://<device-ip>/logtext        # live on-device log
```

## Troubleshooting

Real issues, documented so the same wall isn't hit twice — see
[firmware/README.md](firmware/README.md#troubleshooting-problems-hit-during-development)
for the full list (TLS heap exhaustion, backlight pin choice, etc.).

The most common cross-cutting gotchas:

- **TLS heap exhaustion** — the ESP8266 rarely fits two concurrent BearSSL
  sessions. The firmware enforces a single-session `tlslock` and gates each
  fetch on contiguous heap. If a widget reads `EmptyInput` / `NoMemory`, check
  heap (`/logtext` shows `free`/`blk`) and the boot ordering, not certificates
  (`setInsecure()` is intentional).
- **Netlify response framing is non-deterministic** — small bodies come back
  with `Content-Length`, larger ones as keep-alive chunked. The firmware
  detects body completion by a balanced JSON object (`body_is_complete`), not
  by connection close.
- **API blocked by Edge Access** — after a Netlify deploy, confirm the
  `/.netlify/functions/*` allow rule is present or the dashboard shows the
  login wall instead of data.

## License / credits

This is a personal dashboard project. Upstream data retains its own licenses;
attribution is required where noted by the sources (e.g. sunrise-sunset.org).