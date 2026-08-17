#include "moon.h"
#include "logbuf.h"
#include "config.h"
#include "nettime.h"
#include "netproxy.h"
#include "tlslock.h"
#include "netsched.h"
#include "httpfsm.h"
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <math.h>
#include <time.h>

// Sun + Moon data via the Netlify proxy (moon.js wraps the NASA JPL Horizons
// RTS table). TLS only; the FSM and blocking path share the tlslock with the
// other widget fetchers so only one BearSSL session is ever active.

static MoonInfo gMoon;
static bool gUpdated = false;
static int  gFetchedYday = -1;    // local day-of-year we last fetched for
static int  gFetchYr = 0, gFetchMon = 0, gFetchDay = 0;  // date requested by FSM

enum MPhase { M_IDLE, M_WAIT };
static MPhase phase = M_IDLE;
static HttpFsm http;
static unsigned long lastAttempt = 0;
static unsigned long timer = 0;

void moon_begin() {
  gMoon.valid = false;
  gFetchedYday = -1;
  http.consume();
}

const MoonInfo& moon_data() { return gMoon; }

bool moon_updated() {
  if (gUpdated) { gUpdated = false; return true; }
  return false;
}

static void fail(const char* why) {
  mlog.printf("[MOON] fail: %s\n", why);
  http.consume();
  tls_release();
  netsched_done(NS_MOON);
  phase = M_IDLE;
  lastAttempt = millis();
}

// Slice "HH:MM" from an ISO 8601 time ("2026-07-18T06:15:03Z").
// Null/missing input (ArduinoJson yields "") yields an empty string.
static void to_iso_hhmm(const char* src, char* dst) {
  dst[0] = 0;
  if (!src || strlen(src) < 16) return;   // need through "...THH:MM"
  snprintf(dst, 6, "%.2s:%.2s", src + 11, src + 14);
}

// Map a moon_phase_name to a rough 0..1 fraction for the glyph.
static float phase_fraction(const char* name, int illum) {
  if (!name) name = "";
  if (strstr(name, "New")) return 0.0f;
  if (strstr(name, "First Quarter")) return 0.25f;
  if (strstr(name, "Full")) return 0.5f;
  if (strstr(name, "Last Quarter")) return 0.75f;
  // Fall back to illumination: illum -> distance from new, waning on second half.
  float f = constrain(illum, 0, 100) / 100.0f;
  bool waning = strstr(name, "Waning") || strstr(name, "Last");
  float p = acosf(constrain(1.0f - 2.0f * f, -1.0f, 1.0f)) / (2.0f * (float)M_PI);
  return waning ? (1.0f - p) : p;
}

bool parse_moon_body(const String &body, MoonInfo &out) {
  int brace = body.indexOf('{');
  if (brace < 0) { mlog.println("[MOON] no JSON"); return false; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body.c_str() + brace);
  if (err) { mlog.printf("[MOON] parse err: %s\n", err.c_str()); return false; }

  // moon.js returns top-level sunrise/sunset/moonrise/moonset (null when absent).
  out.sunrise[0] = out.sunset[0] = out.moonrise[0] = out.moonset[0] = 0;
  to_iso_hhmm(doc["sunrise"] | "", out.sunrise);
  to_iso_hhmm(doc["sunset"]  | "", out.sunset);
  to_iso_hhmm(doc["moonrise"] | "", out.moonrise);
  to_iso_hhmm(doc["moonset"]  | "", out.moonset);   // null -> empty

  out.illum = (int)roundf(doc["moon_illumination"] | 0.0f);
  const char* cp = doc["moon_phase_name"] | "";
  strncpy(out.name, cp, sizeof(out.name) - 1);
  out.name[sizeof(out.name) - 1] = 0;
  out.phase = phase_fraction(cp, out.illum);

  out.valid = true;
  mlog.printf("[MOON] OK sun %s/%s moon %s/%s illum %d%% %s\n",
              out.sunrise, out.sunset, out.moonrise, out.moonset, out.illum, out.name);
  return true;
}

// Build the proxy request URL for the local date.
static String build_url(int yr, int mon, int day) {
  char date[16];
  // Modulo keeps the fields bounded so %04d/%02d can't overflow the buffer
  // (kills -Wformat-truncation).
  snprintf(date, sizeof(date), "%04d-%02d-%02d", yr % 10000, mon % 100, day % 100);
  String q = "lat=" + String(cfg.lat, 4) +
             "&lon=" + String(cfg.lon, 4) +
             "&date=" + String(date);
  return proxy_path("moon", q);
}

// Full "should we fetch today" predicate, shared by moon_tick() and moon_due()
// so the scheduler's parking and the FSM's start gate can never disagree.
static bool due() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!time_is_synced()) return false;
  if (!cfg.api_base[0]) return false;
  time_t now = time(nullptr);
  const struct tm *lt = localtime(&now);
  if (lt->tm_yday == gFetchedYday) return false;                   // already have today
  if (lastAttempt && millis() - lastAttempt < 10000) return false; // retry backoff
  return true;
}

bool moon_due() { return due(); }

void moon_tick() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!time_is_synced()) return;
  if (!cfg.api_base[0]) return;

  switch (phase) {
    case M_IDLE: {
      if (!due()) return;
      if (!netsched_can_start(NS_MOON)) return;   // wait for our cascade turn
      if (!tls_try_acquire()) { netsched_done(NS_MOON); return; }  // safety; cascade prevents overlap
      int h, m, s, dow, day, mon, yr;
      time_now(h, m, s, dow, day, mon, yr);
      gFetchYr = yr; gFetchMon = mon; gFetchDay = day;
      String url = build_url(yr, mon, day);
      mlog.printf("[MOON] GET %s\n", url.c_str());
      if (!http.begin(proxy_host(), url, 443, true, "X-Periphery-Raw: 1")) {
        tls_release();
        netsched_done(NS_MOON);
        lastAttempt = millis();
        return;
      }
      phase = M_WAIT;
      timer = millis();
      break;
    }

    case M_WAIT:
      if (millis() - timer > 20000) { fail("phase timeout"); break; }
      http.tick();
      if (http.done()) {
        String raw = http.body();
        http.consume();
        tls_release();
        netsched_done(NS_MOON);
        mlog.printf("[MOON] body len=%d\n", raw.length());
        if (parse_moon_body(raw, gMoon)) {
          // Mark today fetched using the date we actually requested.
          struct tm t;
          memset(&t, 0, sizeof(t));
          t.tm_year = gFetchYr - 1900; t.tm_mon = gFetchMon - 1; t.tm_mday = gFetchDay;
          t.tm_isdst = -1;
          time_t tt = mktime(&t);
          gFetchedYday = (tt >= 0) ? localtime(&tt)->tm_yday : -1;
          gUpdated = true;
        } else {
          lastAttempt = millis();
        }
        phase = M_IDLE;
      } else if (http.failed()) {
        http.consume();
        tls_release();
        netsched_done(NS_MOON);
        lastAttempt = millis();
        phase = M_IDLE;
      }
      break;
  }
}

// Synchronous, deterministic fetch used at boot (and any caller that can block).
// TLS to the Netlify proxy; holds the tlslock for the duration. On success sets
// gFetchedYday so moon_tick() won't re-fetch the same local day.
bool moon_fetch_blocking(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) { mlog.println("[MOON] block: no wifi"); return false; }
  if (!time_is_synced()) { mlog.println("[MOON] block: clock not synced"); return false; }
  if (!cfg.api_base[0]) return false;
  if (!tls_try_acquire()) { mlog.println("[MOON] block: tls busy"); return false; }

  int h, m, s, dow, day, mon, yr;
  time_now(h, m, s, dow, day, mon, yr);
  String url = build_url(yr, mon, day);

  BearSSL::WiFiClientSecure *c = new BearSSL::WiFiClientSecure();
  if (!c) { tls_release(); mlog.println("[MOON] block: alloc fail"); return false; }
  c->setInsecure();
  c->setBufferSizes(4096, 512);
  c->setTimeout(3000);

  bool ok = false;
  if (c->connect(proxy_host(), 443)) {
    c->print(String("GET ") + url + " HTTP/1.1\r\n" +
             "Host: " + proxy_host() + "\r\n" +
             "User-Agent: periphery\r\n" +
             "X-Periphery-Raw: 1\r\n" +
             "Connection: close\r\n\r\n");
    String body; bool inBody = false; String hdr;
    unsigned long t0 = millis();
    while (millis() - t0 < timeoutMs) {
      ESP.wdtFeed();
      while (c->available()) {
        char ch = c->read();
        if (!inBody) {
          hdr += ch;
          if (ch == '\n' && (hdr == "\r\n" || hdr == "\n")) inBody = true;
          hdr = (ch == '\n') ? "" : hdr;
        } else {
          body += ch;
        }
      }
      if (inBody && !c->connected() && !c->available()) break;
      if (body.length() > 4000) break;
    }
    mlog.printf("[MOON] block body len=%d\n", body.length());
    if (parse_moon_body(body, gMoon)) {
      time_t now = time(nullptr);
      gFetchedYday = localtime(&now)->tm_yday;
      gUpdated = true;
      ok = true;
    } else {
      lastAttempt = millis();
    }
  } else {
    mlog.println("[MOON] block: connect failed");
  }
  c->stop(); delete c;
  tls_release();
  return ok;
}
