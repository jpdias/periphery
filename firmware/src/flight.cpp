#include "logbuf.h"
#include "flight.h"
#include "config.h"
#include "env.h"
#include "netproxy.h"
#include "bodyutil.h"
#include "tlslock.h"
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

static const uint16_t FL_PORT = 443;
static const unsigned long FL_INTERVAL = 30000;  // 30s refresh (TLS is heap-heavy)
static const uint32_t FL_MIN_HEAP = 6144;           // TLS (2048+512) + filter doc
                                                      // + small JsonDocument: 6KB is enough

static FlightData gData;
static bool gUpdated = false;

// One BearSSL client, created per-fetch to release its buffers between requests.
// Non-blocking phases keep the main loop (and clock) alive.
static BearSSL::WiFiClientSecure *cli = nullptr;

enum Phase { P_IDLE, P_CONN, P_WAIT, P_HDR, P_READ };
static Phase phase = P_IDLE;
static unsigned long timer = 0;
static unsigned long lastCycle = 0;
static bool first = true;
static String bodyBuf;              // response body drained across loop ticks
static String hdrBuf;               // raw response headers (content-length scan)
static long httpContentLen = -1;    // Content-Length from the response (-1 unknown)

const FlightData& flight_data() { return gData; }

bool flight_updated() {
  if (gUpdated) { gUpdated = false; return true; }
  return false;
}

int flight_next_refresh_secs() {
  if (phase != P_IDLE) return 0;   // fetch in progress
  unsigned long elapsed = millis() - lastCycle;
  if (elapsed >= FL_INTERVAL) return 0;
  return (int)((FL_INTERVAL - elapsed + 999) / 1000);
}

void flight_begin() {
  phase = P_IDLE;
  first = true;
  lastCycle = 0;
  gData.valid = false;
  gData.count = 0;
}

static void cleanup() {
  if (cli) { cli->stop(); delete cli; cli = nullptr; }
  tls_release();
}

static void fail(const char *why) {
  mlog.printf("[FLT] %s\n", why);
  cleanup();
  phase = P_IDLE;
  lastCycle = millis();
}

static int insert_sorted(FlightAc *arr, int n, const FlightAc &a) {
  // Keep the FLIGHT_MAX closest aircraft, sorted ascending by distance.
  if (n < FLIGHT_MAX) {
    int i = n - 1;
    while (i >= 0 && arr[i].dst > a.dst) { arr[i + 1] = arr[i]; i--; }
    arr[i + 1] = a;
    return n + 1;
  }
  if (a.dst >= arr[n - 1].dst) return n;   // farther than our worst, drop
  int i = n - 2;
  while (i >= 0 && arr[i].dst > a.dst) { arr[i + 1] = arr[i]; i--; }
  arr[i + 1] = a;
  return n;
}

// Derive a short class tag from the ADS-B emitter category + military flag.
//   dbFlags bit0 -> military (wins over everything).
//   A7 -> helicopter; A3/A4/A5 -> commercial (large/heavy); A1/A2/A6 -> light GA;
//   B1 -> glider; B2 -> balloon/airship; B4 -> ultralight; B6 -> drone/UAV.
//   Anything unknown -> civilian.
static void classify(const char *cat, long dbFlags, char *out) {
  if (dbFlags & 1) { strcpy(out, "MIL"); return; }
  char a = cat[0], b = cat[1];
  if (a == 'A') {
    switch (b) {
      case '7':               strcpy(out, "HEL"); return;  // rotorcraft
      case '3': case '4': case '5': strcpy(out, "COM"); return;  // large/heavy
      case '1': case '2': case '6': strcpy(out, "LGT"); return;  // light GA
    }
  } else if (a == 'B') {
    switch (b) {
      case '1': strcpy(out, "GLI"); return;  // glider/sailplane
      case '2': strcpy(out, "BAL"); return;  // lighter-than-air
      case '4': strcpy(out, "ULT"); return;  // ultralight/paraglider
      case '6': strcpy(out, "UAV"); return;  // drone
    }
  }
  strcpy(out, "CIV");
}

// Build the ADS-B request through the Netlify proxy: /api/flights?lat=..&lon=..
// &dist=.. (the function forwards to adsb.lol server-side).
static bool flight_request(String &host, String &url) {
  host = proxy_host();
  String q = "lat=" + String(cfg.lat, 4) +
             "&lon=" + String(cfg.lon, 4) +
             "&dist=" + String(cfg.flight_range);
  url = proxy_path("flights", q);
  return true;
}

// Parse the buffered body (framing already stripped by slice_json). The filter
// drops every field we don't need, keeping the working doc tiny.
static void parse(const String &json) {
  JsonDocument filter;
  JsonObject fac = filter["aircraft"].add<JsonObject>();
  fac["flight"] = true;
  fac["alt_baro"] = true;
  fac["track"] = true;
  fac["dst"] = true;
  fac["dir"] = true;
  fac["category"] = true;   // ADS-B emitter category (A1..A7, B1..)
  fac["dbFlags"] = true;    // bit 0 = military

  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, json, DeserializationOption::Filter(filter));
  if (err) { mlog.printf("[FLT] parse err %s\n", err.c_str()); gData.valid = false; return; }

  JsonArray arr = doc["aircraft"];
  int n = 0, total = 0;
  for (JsonObject o : arr) {
    total++;
    FlightAc a;
    const char *fl = o["flight"] | "";
    strncpy(a.flight, fl, sizeof(a.flight) - 1);
    a.flight[sizeof(a.flight) - 1] = 0;
    for (int k = (int)strlen(a.flight) - 1; k >= 0 && a.flight[k] == ' '; k--) a.flight[k] = 0;
    a.dst = o["dst"] | 999.0f;
    a.dir = o["dir"] | 0.0f;
    a.track = o["track"] | -1.0f;
    // cppcheck-suppress badBitmaskCheck ; ArduinoJson's operator| supplies a default
    a.alt = o["alt_baro"] | 0;
    // cppcheck-suppress badBitmaskCheck ; ArduinoJson's operator| supplies a default
    classify(o["category"] | "", o["dbFlags"] | 0, a.tag);
    n = insert_sorted(gData.ac, n, a);
  }
  gData.count = n;
  gData.total = total;
  gData.valid = true;
  gUpdated = true;
  mlog.printf("[FLT] %d aircraft (showing %d)\n", total, n);
}

// Non-blocking: consume HTTP response headers up to the blank line. Returns
// true once the body is reached and httpContentLen has been set from the
// Content-Length header (if present).
static uint8_t hdrMatch = 0;   // progress through "\r\n\r\n"; reset per fetch
static bool skip_headers(Stream &s) {
  uint8_t &match = hdrMatch;
  while (s.available()) {
    char c = (char)s.read();
    if (hdrMatch == 4) break;            // keep body bytes out of hdrBuf
    if (hdrBuf.length() < 1024) hdrBuf += c;
    if ((match == 0 || match == 2) && c == '\r') match++;
    else if ((match == 1 || match == 3) && c == '\n') {
      match++;
      if (match == 4) {
        match = 0;
        httpContentLen = header_content_length(hdrBuf);
        hdrBuf = "";
        return true;
      }
    } else match = 0;
  }
  return false;
}

void flight_tick() {
  if (cfg.flight_range <= 0) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!cfg.api_base[0]) return;   // proxy required

  // Global safety: if any active phase runs too long, abort the whole cycle so
  // the FSM can never get wedged (which shows as a stuck countdown at 0).
  if (phase != P_IDLE && millis() - timer > 12000) { fail("phase timeout"); return; }

  switch (phase) {
    case P_IDLE:
      if (first || millis() - lastCycle >= FL_INTERVAL) {
        // Only start if there's enough contiguous heap for TLS + JSON, else
        // we just get NoMemory. Retry on the next interval.
        if (ESP.getMaxFreeBlockSize() < FL_MIN_HEAP) {
          if (first) mlog.println("[FLT] low heap, deferring");
          lastCycle = millis();
          return;
        }
        if (!tls_try_acquire()) {
          static unsigned long lastWarn = 0;
          if (millis() - lastWarn > 5000) { mlog.println("[FLT] TLS busy, waiting"); lastWarn = millis(); }
          return;   // moon fetch busy; retry next loop
        }
        first = false;
        hdrMatch = 0;   // a mid-header abort must not corrupt the next fetch
        hdrBuf = "";
        httpContentLen = -1;
        bodyBuf = "";
        cli = new BearSSL::WiFiClientSecure();
        if (!cli) { fail("alloc fail"); return; }
        cli->setInsecure();
        cli->setBufferSizes(2048, 512);   // smaller TLS buffers to fit heap
        cli->setTimeout(2000);
        phase = P_CONN;
        timer = millis();
      }
      break;

    case P_CONN:
      if (cli->connect(proxy_host(), FL_PORT)) {
        String host, url;
        flight_request(host, url);
        String req = String("GET ") + url + " HTTP/1.1\r\n" +
                     "Host: " + host + "\r\n" +
                     "User-Agent: periphery\r\n" +
                     "X-Periphery-Raw: 1\r\n\r\n";
        cli->print(req);
        phase = P_WAIT;
        timer = millis();
      } else if (millis() - timer > 8000) {
        fail("connect fail");
      }
      break;

    case P_WAIT:
      if (cli->available()) { phase = P_HDR; timer = millis(); }
      else if (!cli->connected()) { fail("closed early"); }
      else if (millis() - timer > 6000) fail("wait timeout");
      break;

    case P_HDR:
      if (skip_headers(*cli)) { phase = P_READ; timer = millis(); }
      else if (!cli->connected() && !cli->available()) fail("no body");
      else if (millis() - timer > 6000) fail("header timeout");
      break;

    case P_READ:
      // Drain the body across ticks into a String, completing when a balanced
      // top-level JSON object has arrived (covers Content-Length and chunked
      // keep-alive responses alike) or when the server closes the connection.
      while (cli->available()) {
        int ch = cli->read();
        if (ch < 0) break;
        if (bodyBuf.length() >= BODY_CAP) { bodyBuf = ""; httpContentLen = -1; fail("body too large"); break; }
        bodyBuf += (char)ch;
      }
      bool done = body_is_complete(bodyBuf) ||
                  (httpContentLen > 0 && (int)bodyBuf.length() >= httpContentLen) ||
                  (!cli->connected() && !cli->available());
      if (done) {
        String json = slice_json(bodyBuf);
        bodyBuf = "";
        httpContentLen = -1;
        parse(json);
        cleanup();
        phase = P_IDLE;
        first = false;
        lastCycle = millis();
      } else if (millis() - timer > 12000) {
        bodyBuf = "";
        httpContentLen = -1;
        fail("read stall");
      }
      break;
  }
}

// Synchronous first fetch used at boot. Drives the non-blocking flight FSM
// (which drains the body across loop iterations — immune to the BearSSL close
// race that drops a single-burst body). Blocks until the first fetch completes
// or timeoutMs elapses.
bool flight_fetch_blocking(unsigned long timeoutMs) {
  if (cfg.flight_range <= 0) return false;
  if (WiFi.status() != WL_CONNECTED) { mlog.println("[FLT] block: no wifi"); return false; }
  if (!cfg.api_base[0]) return false;   // proxy required

  flight_tick();   // begin the fetch
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs && !(first == false && phase == P_IDLE)) {
    ESP.wdtFeed();
    flight_tick();
    delay(50);
  }
  return gData.valid;
}
