#pragma once
// Build-time settings. This file is gitignored - never commit the real values.
// The #ifndef guards below act as fallbacks: public API hosts get their defaults
// so the build always compiles, while secrets (incidents path, wifi creds) are
// empty until filled in here.

// Incidents (ArcGIS FeatureServer) - org-specific, keep private
#ifndef INCIDENTS_HOST
#define INCIDENTS_HOST "services-eu1.arcgis.com"
#endif
#ifndef INCIDENTS_PATH
#define INCIDENTS_PATH "/VlrHb7fn5ewYhX6y/arcgis/rest/services/OcorrenciasSite/FeatureServer/0/query"
#endif

// Public API hosts
#ifndef FLIGHT_HOST
#define FLIGHT_HOST "opendata.adsb.fi"
#endif
#ifndef MOON_HOST
#define MOON_HOST "api.sunrise-sunset.org"
#endif
#ifndef TRAIN_HOST_DEF
#define TRAIN_HOST_DEF "www.infraestruturasdeportugal.pt"
#endif
#ifndef TRAIN_PATH_DEF
#define TRAIN_PATH_DEF "/negocios-e-servicos"
#endif
#ifndef WEATHER_HOST
#define WEATHER_HOST "api.open-meteo.com"
#endif
#ifndef EXTIP_HOST
#define EXTIP_HOST "ipinfo.io"
#endif
#ifndef NTP_HOST
#define NTP_HOST "pool.ntp.org"
#endif

// Default WiFi credentials (used when no config.json exists)
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif

// Captive portal AP credentials
#ifndef AP_NAME
#define AP_NAME "PTMonitor-Setup"
#endif
#ifndef AP_PASS
#define AP_PASS "ptmonitorpass"
#endif
