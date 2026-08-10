# PTMonitor Web

Static dashboard frontend (GitHub Pages compatible, PWA-capable). Desktop
friendly, same widgets as the device. Consumes the `/api/<widget>` endpoints
provided by the PTMonitor server (`../server`).

## Layout

```
web/
└── public/            # the static site (deploy this folder to GitHub Pages)
    ├── index.html
    ├── style.css
    ├── config.js      # client-side defaults (analog of the firmware env.h)
    ├── app.js
    ├── manifest.json
    └── sw.js
```

## Frontend config (`public/config.js`)

`window.MINIDASH_CONFIG` holds the client-side defaults (default lat/lon, flight
range, refresh interval, API base). The API base is auto-detected when left
empty (same-origin `/api/*`, which works under `npm run dev:light` in `../server`
and under `netlify dev`); set it to your Netlify site URL when the static site is
hosted on GitHub Pages. Runtime overrides made in the ⚙ settings are stored in
`localStorage` and take precedence over `config.js`.

## Local development

The static site alone can be served with any static file server:

```bash
cd ../server && npm run dev:light   # serves web/public + API on :8080
```

## Deploy

1. Host `public/` on GitHub Pages (or let Netlify host it via the server's
   `netlify.toml`).
2. For GitHub Pages hosting, set `apiBase` in `config.js` to your Netlify site
   URL (see `../server` for the API side).
3. Configure the dashboard with your location via the ⚙ settings button — it is
   stored in `localStorage` (geolocation button fills it automatically).
