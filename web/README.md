# periphery Web

Static dashboard frontend (GitHub Pages compatible, PWA-capable). Desktop
friendly, same widgets as the device. Consumes the `/api/<widget>` endpoints
provided by the periphery server (`../server`).

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

`window.PERIPHERY_CONFIG` holds the client-side defaults (default lat/lon, flight
range, refresh interval, API base). `apiBase` points at the Netlify API host
(`https://prismatic-horse-4c465a.netlify.app`); leave it `""` for same-origin
`/api/*` during local dev. Runtime overrides made in the ⚙ settings are stored in
`localStorage` and take precedence over `config.js`.

## Local development

The static site alone can be served with any static file server:

```bash
cd ../server && npm run dev:light   # serves web/public + API on :8080
```

## Deploy

Hosted on **GitHub Pages** at `https://jpdias.me/periphery/` via
`.github/workflows/pages.yml` (repo must be named `periphery` so Pages serves
under `/periphery/`; it writes the `CNAME` for `jpdias.me`). The frontend calls
the Netlify API cross-origin via `apiBase`; the API is CORS-restricted to
`https://jpdias.me` (see `../server`). Configure the dashboard with your location
via the ⚙ settings button — it is stored in `localStorage` (geolocation button
fills it automatically).
