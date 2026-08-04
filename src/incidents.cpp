#include "logbuf.h"
#include "incidents.h"
#include "config.h"
#include "env.h"
#include "nettime.h"
#include "tlslock.h"
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

static const char* INC_HOST = INCIDENTS_HOST;
static const char* INC_PATH = INCIDENTS_PATH;
static const uint16_t INC_PORT = 443;
static const unsigned long INC_INTERVAL = 900000;  // 15 min refresh (TLS is heap-heavy)
static const unsigned long INC_RETRY = 30000;      // quick retry after a defer/fail
static const uint32_t INC_MIN_HEAP = 16000;        // skip fetch if heap too low

static IncidentData gData;
static bool gUpdated = false;

// Incident fingerprints the user has dismissed this boot (in-RAM only, cleared
// on reboot). Keyed on fp (natureza+concelho+dataHora) instead of the feed's
// ID_oc because ArcGIS regenerates ID_oc on every refresh; the array simply
// holds the most recent INCIDENT_DISMISS_MAX dismissals.
static uint32_t dismissedFps[INCIDENT_DISMISS_MAX] = {0};
static int dismissedCount = 0;

// FNV-1a hash of a C string.
static uint32_t fnv1a(const char *s) {
  uint32_t h = 2166136261u;
  for (; *s; s++) { h ^= (uint8_t)*s; h *= 16777619u; }
  return h;
}

// Stable identity for a physical incident across feed refreshes.
static uint32_t incident_fp(const Incident &inc) {
  uint32_t h = fnv1a(inc.natureza);
  h = (h ^ fnv1a(inc.concelho)) * 16777619u;
  return (h ^ fnv1a(inc.dataHora)) * 16777619u;
}

void incidents_dismiss(uint32_t fp) {
  if (!fp) return;
  for (int i = 0; i < dismissedCount; i++) {
    if (dismissedFps[i] == fp) return;   // already known
  }
  if (dismissedCount >= INCIDENT_DISMISS_MAX) {
    memmove(dismissedFps, dismissedFps + 1, (INCIDENT_DISMISS_MAX - 1) * sizeof(uint32_t));
    dismissedCount = INCIDENT_DISMISS_MAX - 1;
  }
  dismissedFps[dismissedCount++] = fp;
  mlog.printf("[INC] dismissed fp %08X\n", fp);
}

bool incidents_is_dismissed(uint32_t fp) {
  for (int i = 0; i < dismissedCount; i++) {
    if (dismissedFps[i] == fp) return true;
  }
  return false;
}

// One BearSSL client, created per-fetch to release its buffers between requests.
static BearSSL::WiFiClientSecure *cli = nullptr;

enum Phase { P_IDLE, P_CONN, P_WAIT, P_HDR, P_READ };
static Phase phase = P_IDLE;
static unsigned long timer = 0;
static unsigned long lastCycle = 0;
static unsigned long retryAt = 0;   // early retry time after a defer/fail
static bool first = true;

const IncidentData& incidents_data() { return gData; }

bool incidents_updated() {
  if (gUpdated) { gUpdated = false; return true; }
  return false;
}

int incidents_next_refresh_secs() {
  if (phase != P_IDLE) return 0;   // fetch in progress
  unsigned long now = millis();
  if (retryAt > 0) {               // early retry scheduled (defer/fail)
    if (now >= retryAt) return 0;
    return (int)((retryAt - now + 999) / 1000);
  }
  unsigned long elapsed = now - lastCycle;
  if (elapsed >= INC_INTERVAL) return 0;
  return (int)((INC_INTERVAL - elapsed + 999) / 1000);
}

void incidents_begin() {
  phase = P_IDLE;
  first = true;
  lastCycle = 0;
  retryAt = 0;
  gData.valid = false;
  gData.count = 0;
  gData.lastUpdated = 0;
  gData.lastOk = false;
  dismissedCount = 0;   // dismissals are in-RAM only; reset on boot
}

static void cleanup() {
  if (cli) { cli->stop(); delete cli; cli = nullptr; }
  tls_release();
}

static void fail(const char *why) {
  mlog.printf("[INC] %s\n", why);
  gData.lastUpdated = time_utc_now();
  gData.lastOk = false;
  cleanup();
  phase = P_IDLE;
  first = false;
  lastCycle = millis();
  retryAt = millis() + INC_RETRY;   // retry sooner than the full 15 min
}

static void copy_field(const char *src, char *dst, size_t len) {
  if (!src) { dst[0] = 0; return; }
  strncpy(dst, src, len - 1);
  dst[len - 1] = 0;
}

// Great-circle distance between two lat/lon points (km).
static float haversine_km(float lat1, float lon1, float lat2, float lon2) {
  const float R = 6371.0f;
  const float dLat = (lat2 - lat1) * 0.017453293f;
  const float dLon = (lon2 - lon1) * 0.017453293f;
  float a = sinf(dLat / 2) * sinf(dLat / 2) +
            cosf(lat1 * 0.017453293f) * cosf(lat2 * 0.017453293f) *
            sinf(dLon / 2) * sinf(dLon / 2);
  float c = 2 * atan2f(sqrtf(a), sqrtf(1 - a));
  return R * c;
}

// Keep the INCIDENT_MAX closest incidents, sorted ascending by distance.
static int insert_sorted(Incident *arr, int n, const Incident &a) {
  if (n < INCIDENT_MAX) {
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

// Parse straight from the TLS stream (with a filter) so we never buffer the
// whole response. GeoJSON Point coordinates arrive as [lon, lat] (outSR=4326).
static void parse(Stream &s) {
  // ArduinoJson v6 filter for an array of objects: index [0] wildcards all
  // elements (createNestedObject() matches nothing on v6).
  StaticJsonDocument<512> filter;
  JsonObject ffeat = filter["features"][0].to<JsonObject>();
  JsonObject fprop = ffeat["properties"].to<JsonObject>();
  fprop["ID_oc"] = true;
  fprop["Natureza"] = true;
  fprop["EstadoOcorrencia"] = true;
  fprop["Concelho"] = true;
  fprop["Localidade"] = true;
  fprop["DataInicioOcorrencia"] = true;
  ffeat["geometry"]["coordinates"] = true;

  DynamicJsonDocument doc(2048);
  DeserializationError err =
      deserializeJson(doc, s, DeserializationOption::Filter(filter));
  if (err) { mlog.printf("[INC] parse err %s\n", err.c_str()); gData.valid = false; return; }

  JsonArray features = doc["features"];
  int n = 0;
  for (JsonObject f : features) {
    if (n >= INCIDENT_MAX) break;
    Incident inc;
    JsonObject prop = f["properties"];
    inc.id = prop["ID_oc"] | 0;
    copy_field(prop["Natureza"] | "", inc.natureza, sizeof(inc.natureza));
    copy_field(prop["EstadoOcorrencia"] | "", inc.estado, sizeof(inc.estado));
    copy_field(prop["Concelho"] | "", inc.concelho, sizeof(inc.concelho));
    copy_field(prop["Localidade"] | "", inc.localidade, sizeof(inc.localidade));
    copy_field(prop["DataInicioOcorrencia"] | "", inc.dataHora, sizeof(inc.dataHora));
    inc.fp = incident_fp(inc);
    JsonArray coords = f["geometry"]["coordinates"];
    if (coords.size() >= 2) {
      inc.dst = haversine_km(cfg.lat, cfg.lon, (float)coords[1], (float)coords[0]);
    } else {
      inc.dst = 999.0f;
    }
    n = insert_sorted(gData.inc, n, inc);
  }
  gData.count = n;
  gData.valid = true;
  gData.lastUpdated = time_utc_now();
  gData.lastOk = true;
  gUpdated = true;
  mlog.printf("[INC] %d incidents\n", n);
}

// Non-blocking: consume HTTP response headers up to the blank line. Returns
// true once the body is reached.
static uint8_t hdrMatch = 0;   // progress through "\r\n\r\n"; reset per fetch
static bool skip_headers(Stream &s) {
  uint8_t &match = hdrMatch;
  while (s.available()) {
    char c = (char)s.read();
    if ((match == 0 || match == 2) && c == '\r') match++;
    else if ((match == 1 || match == 3) && c == '\n') { match++; if (match == 4) { match = 0; return true; } }
    else match = 0;
  }
  return false;
}

// The incidents within INCIDENT_RADIUS_M of the configured location, trimmed
// server-side with a spatial filter so the payload stays tiny for the ESP8266
// (avoids exceededTransferLimit too). Result order is by DataOcorrencia DESC.
static String inc_query() {
  char ll[40];
  snprintf(ll, sizeof(ll), "%.6f,%.6f", cfg.lon, cfg.lat);
  String q = String(INC_PATH)
    + "?where=1%3D1"
    + "&outFields=ID_oc%2CNatureza%2CEstadoOcorrencia%2CConcelho%2CLocalidade%2CDataInicioOcorrencia%2CDataOcorrencia"
    + "&geometry=" + ll
    + "&geometryType=esriGeometryPoint"
    + "&inSR=4326"
    + "&distance=" + String(INCIDENT_RADIUS_M)
    + "&units=esriSRUnit_Meter"
    + "&spatialRel=esriSpatialRelIntersects"
    + "&orderByFields=DataOcorrencia%20DESC"
    + "&resultRecordCount=" + String(INCIDENT_MAX)
    + "&f=geojson"
    + "&outSR=4326";
  return q;
}

void incidents_tick() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!INC_HOST[0] || !INC_PATH[0]) return;   // not configured in env.h

  // Global safety: abort any active phase that runs too long so the FSM can
  // never get wedged (mirrors the flight radar's watchdog).
  if (phase != P_IDLE && millis() - timer > 20000) { fail("phase timeout"); return; }

  switch (phase) {
    case P_IDLE:
      // Trigger: first boot fetch, the 15-min cycle, or an early retry.
      if (first || millis() - lastCycle >= INC_INTERVAL ||
          (retryAt > 0 && millis() >= retryAt)) {
        // Only start if there's enough contiguous heap for TLS + JSON.
        if (ESP.getMaxFreeBlockSize() < INC_MIN_HEAP) {
          mlog.println("[INC] low heap, deferring 30s");
          first = false;
          lastCycle = millis();       // remember for the countdown
          retryAt = millis() + INC_RETRY;   // retryAt overrides the interval
          return;
        }
        if (!tls_try_acquire()) {
          static unsigned long lastWarn = 0;
          if (millis() - lastWarn > 5000) { mlog.println("[INC] TLS busy, waiting"); lastWarn = millis(); }
          return;   // another TLS session (moon/flight) busy; retry next loop
        }
        first = false;
        cli = new BearSSL::WiFiClientSecure();
        if (!cli) { fail("alloc fail"); return; }
        cli->setInsecure();
        cli->setBufferSizes(4096, 512);   // smaller TLS buffers to fit heap
        cli->setTimeout(2000);
        phase = P_CONN;
        timer = millis();
      }
      break;

    case P_CONN:
      if (cli->connect(INC_HOST, INC_PORT)) {
        cli->print(String("GET ") + inc_query() + " HTTP/1.1\r\n" +
                   "Host: " + INC_HOST + "\r\n" +
                   "User-Agent: miniDash\r\n" +
                   "Connection: close\r\n\r\n");
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
      if (cli->available()) {
        parse(*cli);              // streams from the client, stops at closing brace
        cleanup();
        phase = P_IDLE;
        lastCycle = millis();
        retryAt = 0;
      } else if (!cli->connected()) {
        fail("empty body");
      } else if (millis() - timer > 8000) {
        fail("read stall");
      }
      break;
  }
}

// Synchronous first fetch used at boot. Blocks until the full response is parsed
// or timeoutMs elapses. At boot the flight radar has already released the TLS
// lock, so this is the only TLS session and is guaranteed to succeed if the
// network is up.
bool incidents_fetch_blocking(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) { mlog.println("[INC] block: no wifi"); return false; }
  if (!INC_HOST[0] || !INC_PATH[0]) return false;   // not configured in env.h
  if (!tls_try_acquire()) { mlog.println("[INC] block: tls busy"); return false; }

  BearSSL::WiFiClientSecure *c = new BearSSL::WiFiClientSecure();
  if (!c) { tls_release(); mlog.println("[INC] block: alloc fail"); return false; }
  c->setInsecure();
  c->setBufferSizes(4096, 512);
  c->setTimeout(3000);

  String url = inc_query();
  bool ok = false;
  if (c->connect(INC_HOST, INC_PORT)) {
    c->print(String("GET ") + url + " HTTP/1.1\r\n" +
             "Host: " + INC_HOST + "\r\n" +
             "User-Agent: miniDash\r\n" +
             "Connection: close\r\n\r\n");
    // Wait for the body, then parse straight from the stream.
    unsigned long t0 = millis();
    while (millis() - t0 < timeoutMs) {
      ESP.wdtFeed();
      if (c->available()) break;
      if (!c->connected()) { c->stop(); delete c; tls_release(); return false; }
    }
    // Skip headers up to the blank line.
    uint8_t m = 0;
    while (millis() - t0 < timeoutMs) {
      ESP.wdtFeed();
      while (c->available()) {
        char ch = c->read();
        if ((m == 0 || m == 2) && ch == '\r') m++;
        else if ((m == 1 || m == 3) && ch == '\n') { m++; if (m == 4) goto body; }
        else m = 0;
      }
      if (!c->connected() && !c->available()) break;
    }
body:
    if (m == 4) {
      parse(*c);   // streams from the client, stops at closing brace
      ok = gData.valid;
      if (!ok) {
        gData.lastUpdated = time_utc_now();
        gData.lastOk = false;
      }
    }
    lastCycle = millis();
    retryAt = 0;
    first = false;
  } else {
    mlog.println("[INC] block: connect failed");
    gData.lastUpdated = time_utc_now();
    gData.lastOk = false;
  }
  c->stop(); delete c;
  tls_release();
  return ok;
}

int incidents_geofence_hit() {
  if (!gData.valid || gData.count == 0) return -1;
  float radiusKm = INCIDENT_RADIUS_M / 1000.0f;
  for (int i = 0; i < gData.count; i++) {
    if (gData.inc[i].dst <= radiusKm && !incidents_is_dismissed(gData.inc[i].fp)) return i;
  }
  return -1;
}

int incidents_active_count() {
  if (!gData.valid || gData.count == 0) return 0;
  float radiusKm = INCIDENT_RADIUS_M / 1000.0f;
  int n = 0;
  for (int i = 0; i < gData.count; i++) {
    if (gData.inc[i].dst <= radiusKm) n++;
  }
  return n;
}
