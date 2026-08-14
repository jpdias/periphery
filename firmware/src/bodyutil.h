#pragma once
#include <Arduino.h>

// Shared body handling for the per-widget HTTP FSMs.
//
// The requests do NOT send "Connection: close". The Netlify proxy answers
// HTTP/1.1 keep-alive, but the framing is not deterministic: small bodies come
// back with Content-Length, larger ones as chunked. Either way the connection
// stays open, so completion is detected by a balanced top-level JSON object in
// the buffered bytes (body_is_complete) — immune to the BearSSL close race,
// which otherwise discards undecrypted trailing records the moment close_notify
// is processed (mirrored in WiFiClientSecureBearSSL.cpp's _run_until returning
// -1 once the engine state is BR_SSL_CLOSED).

// Hard cap for a single buffered body. The device's feeds are small (incidents
// ~1 KB, flights ~4 KB, trains ~5 KB); anything larger is treated as a malformed
// runaway response rather than risking a heap failure.
#define BODY_CAP 16384

// Slice the JSON object out of a raw HTTP body, ignoring any transfer encoding.
// Returns "" if no balanced-looking object is present.
static inline String slice_json(const String &raw) {
  int b = raw.indexOf('{');
  int e = raw.lastIndexOf('}');
  if (b < 0 || e <= b) return String();
  return raw.substring(b, e + 1);
}

// Parse the Content-Length from a captured HTTP response header block.
// Returns -1 when absent (callers then fall back to close-delimited reading).
static inline long header_content_length(const String &hdrs) {
  String lower = hdrs;
  lower.toLowerCase();
  int idx = lower.indexOf("content-length:");
  if (idx < 0) return -1;
  int e = lower.indexOf('\n', idx);
  if (e < 0) e = hdrs.length();
  String val = hdrs.substring(idx + 15, e);   // "content-length:" is 15 chars
  val.trim();
  return val.toInt();
}

// True once the buffered raw body contains a balanced top-level JSON object
// (first '{' to a matching final '}'). Robust regardless of transfer encoding:
// nets an identity body, a content-length body, and a keep-alive chunked body
// whose terminal "0\r\n\r\n" arrives after the object's closing brace.
static inline bool body_is_complete(const String &raw) {
  int depth = 0;
  bool inStr = false, started = false;
  for (size_t i = 0; i < raw.length(); i++) {
    char c = raw[i];
    if (inStr) {
      if (c == '\\') i++;
      else if (c == '"') inStr = false;
      continue;
    }
    if (c == '"') { inStr = true; started = true; continue; }
    if (c == '{') { depth++; started = true; }
    else if (c == '}') {
      depth--;
      if (depth == 0 && started) return true;
      if (depth < 0) return false;
    }
  }
  return false;
}