#pragma once
#include <Arduino.h>

// Netlify proxy routing for every widget fetch except ESPHome (which always hits
// cfg.esphome_host directly). When cfg.api_base is set, weather/forecast/ip/
// moon/trains/flights/incidents/stations requests go to
// https://<api_base>/api/<widget>?<params> with an "X-Periphery-Raw: 1" header so
// the function returns the upstream body verbatim (headers stripped) — the
// streaming parsers keep working unchanged. ESPHome is the only fetch that never
// goes through the proxy.

bool proxy_enabled();                       // true if api_base is set
const char* proxy_host();                   // host from api_base (no scheme/path)
String proxy_path(const char* widget, const String &query);  // "/api/<widget>?<query>"
