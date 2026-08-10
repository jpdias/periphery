#pragma once
// Build-time settings. This file is gitignored - never commit the real values.
// The #ifndef guards below act as fallbacks so the build always compiles.
//
// All widget data (weather, forecast, IP, moon, trains, flights, incidents,
// stations) now goes through the Netlify proxy configured in cfg.api_base —
// the only direct upstream left is NTP. The former direct hosts (IP timetable,
// ArcGIS, adsb, sunrise-sunset, Open-Meteo, ipinfo) were removed from the
// firmware as part of the "always use api" migration.

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
#define AP_NAME "periphery-Setup"
#endif
#ifndef AP_PASS
#define AP_PASS "peripherypass"
#endif
