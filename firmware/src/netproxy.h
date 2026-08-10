#pragma once
#include <Arduino.h>

// Netlify proxy routing for the TLS widget fetchers. When cfg.use_api_proxy and
// cfg.api_base are set, flights/incidents/trains/moon requests are sent to
// https://<api_base>/api/<widget>?<params> with an "X-Periphery-Raw: 1" header so
// the function returns the upstream body verbatim (headers stripped) — the
// streaming parsers keep working unchanged. Weather/forecast/ip stay direct
// (plain HTTP to CORS-open public APIs, no benefit from proxying).

bool proxy_enabled();                       // true if api_base set + use_api_proxy
const char* proxy_host();                   // host from api_base (no scheme/path)
String proxy_path(const char* widget, const String &query);  // "/api/<widget>?<query>"
