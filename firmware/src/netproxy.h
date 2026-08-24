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

// Shared header parser that skips HTTP response headers up to \r\n\r\n.
// Detects Transfer-Encoding: chunked and sets an internal flag. Returns true
// once the body stream is positioned at the first body byte.
bool skip_proxy_headers(Stream &s);

// After skip_proxy_headers returns true for a chunked response, call this to
// discard the chunk-size prefix line. Returns true once the prefix is consumed,
// false if more data is needed (call again on next loop iteration).
bool skip_chunk_prefix(Stream &s);
