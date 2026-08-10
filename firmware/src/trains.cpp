#include "logbuf.h"
#include "trains.h"
#include "config.h"
#include "env.h"
#include "nettime.h"
#include "netproxy.h"
#include "tlslock.h"
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

static const char* TRAIN_HOST = TRAIN_HOST_DEF;
static const char* TRAIN_PATH = TRAIN_PATH_DEF;
static const uint16_t TRAIN_PORT = 443;
static const unsigned long TRAIN_INTERVAL = 300000;  // 5 min refresh
static const unsigned long TRAIN_RETRY = 30000;      // quick retry after a defer/fail
static const uint32_t TRAIN_MIN_HEAP = 8192;         // streaming parse: ~5-6KB contiguous is enough

// Public IP API needs no keys — only a real browser User-Agent. These hosts are
// public (see env.h) and contain no secrets.
static const char* TRAIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/144.0.0.0 Safari/537.36";

// Service-type filter required by the endpoint (URL-encoded, literal string).
static const char* TRAIN_SVC = "INTERNACIONAL,%20ALFA,%20IC,%20IR,%20REGIONAL,"
                               "%20URB%7CSUBUR,%20ESPECIAL,%20MERCADORIAS,%20SERVI%C3%87O";

static TrainData gData;
static bool gUpdated = false;

static BearSSL::WiFiClientSecure *cli = nullptr;

enum Phase { P_IDLE, P_API };
enum Step { S_REQ, S_HDR, S_BODY };
static Phase phase = P_IDLE;
static Step step = S_REQ;
static unsigned long timer = 0;
static unsigned long lastCycle = 0;
static unsigned long retryAt = 0;
static bool first = true;

const TrainData& trains_data() { return gData; }

bool trains_updated() {
  if (gUpdated) { gUpdated = false; return true; }
  return false;
}

int trains_next_refresh_secs() {
  if (phase != P_IDLE) return 0;   // fetch in progress
  unsigned long now = millis();
  if (retryAt > 0) {
    if (now >= retryAt) return 0;
    return (int)((retryAt - now + 999) / 1000);
  }
  unsigned long elapsed = now - lastCycle;
  if (elapsed >= TRAIN_INTERVAL) return 0;
  return (int)((TRAIN_INTERVAL - elapsed + 999) / 1000);
}

void trains_begin() {
  phase = P_IDLE;
  step = S_REQ;
  first = true;
  lastCycle = 0;
  retryAt = 0;
  gData.valid = false;
  gData.count = 0;
  gData.lastUpdated = 0;
  gData.lastOk = false;
}

static void cleanup() {
  if (cli) { cli->stop(); delete cli; cli = nullptr; }
  tls_release();
}

static void fail(const char *why) {
  mlog.printf("[TRN] %s\n", why);
  gData.lastUpdated = time_utc_now();
  gData.lastOk = false;
  cleanup();
  phase = P_IDLE;
  step = S_REQ;
  first = false;
  lastCycle = millis();
  retryAt = millis() + TRAIN_RETRY;
}

static void copy_field(const char *src, char *dst, size_t len) {
  if (!src) { dst[0] = 0; return; }
  strncpy(dst, src, len - 1);
  dst[len - 1] = 0;
}

// Parse the delay in minutes out of the IP "Observacoes" text. On-time trains
// carry an empty string; delayed ones read "Circula com atraso de 60 min."
static int parse_delay(const char *obs) {
  if (!obs || !*obs) return 0;
  const char *p = strstr(obs, "atraso de ");
  if (!p) return 0;
  return atoi(p + 10);
}

// Build the IP timetable request for the configured station. Window: [now,
// now+3h]. A 3-hour window ensures quiet stations (a train per hour) still
// yield the full TRAIN_MAX departures; streaming parse + filter keeps the JSON
// doc small even at busy stations. Times are local (Europe/Lisbon via nettime).
// Returns false if the clock isn't synced or no station is set. In direct mode
// the date-times use %20 (space) in the path; in proxy mode they're plain query
// params for /api/trains?station=..&date=..&start=..&end=..
static bool train_request(String &host, String &url) {
  if (!cfg.ip_station[0]) return false;
  int h, m, s, dow, day, mon, yr;
  time_now(h, m, s, dow, day, mon, yr);
  if (yr < 2020) return false;      // clock not synced yet

  char date[16], start[16], end[16];
  // Modulo is redundant for real clock values but tells GCC the fields are
  // bounded so %04d/%02d can't overflow the buffers (kills -Wformat-truncation).
  snprintf(date, sizeof(date), "%04d-%02d-%02d", yr % 10000, mon % 100, day % 100);
  snprintf(start, sizeof(start), "%02d:%02d", h % 100, m % 100);
  int eh = h, em = m + 180;         // 3-hour window, clamped at end of day
  while (em >= 60) { em -= 60; eh++; }
  if (eh >= 24) { eh = 23; em = 59; }
  snprintf(end, sizeof(end), "%02d:%02d", eh % 100, em % 100);

  if (proxy_enabled()) {
    host = proxy_host();
    String q = "station=" + String(cfg.ip_station) +
               "&date=" + String(date) +
               "&start=" + String(start) +
               "&end=" + String(end);
    url = proxy_path("trains", q);
  } else {
    host = TRAIN_HOST;
    url = String(TRAIN_PATH) + "/partidas-chegadas/" + cfg.ip_station + "/" +
          date + "%20" + start + "/" + date + "%20" + end + "/" + TRAIN_SVC;
  }
  return true;
}

// Consume response headers up to the blank line; returns true when body reached.
static bool http_headers() {
  static uint8_t m = 0;
  while (cli->available()) {
    char c = (char)cli->read();
    if ((m == 0 || m == 2) && c == '\r') m++;
    else if ((m == 1 || m == 3) && c == '\n') { m++; if (m == 4) { m = 0; return true; } }
    else m = 0;
  }
  if (!cli->connected() && !cli->available()) return false;   // closed, no body
  if (millis() - timer > 6000) return false;                  // header timeout
  return false;                                               // need more data
}

// Stream wrapper that transparently strips the IP API's chunked transfer
// encoding, so ArduinoJson can parse straight from the TLS client without ever
// buffering the whole body. This keeps peak heap tiny (a 12KB body String can't
// be held while the TLS buffers are alive). Plain (non-chunked) identity bodies
// are streamed byte-by-byte too - never buffered into a String.
class ChunkedStream : public Stream {
 public:
  explicit ChunkedStream(WiFiClientSecure &c) : s(c) { s.setTimeout(10000); }

  int available() override { return s.available(); }
  int peek() override { return s.peek(); }
  size_t write(uint8_t b) override { (void)b; return 0; }   // read-only wrapper

  int read() override {
    if (eof) return -1;
    if (!decided) {
      // Decide chunked-vs-identity from the very first body byte without
      // consuming it. An identity body starts with '{' (minified JSON); any
      // other first byte means the chunk-size line has begun.
      int p = s.peek();
      if (p < 0) { eof = true; return -1; }
      identity = (p == '{');
      decided = true;
    }
    if (identity) {
      int c = s.read();
      if (c < 0) { eof = true; return -1; }
      return c;
    }
    if (chunk == -1) {
      String line = s.readStringUntil('\n');
      line.trim();
      if (line.length() == 0) { eof = true; return -1; }
      chunk = strtol(line.c_str(), NULL, 16);
      if (chunk <= 0) { eof = true; return -1; }
    }
    if (chunk > 0) {
      int c = s.read();
      if (c < 0) { eof = true; return -1; }
      chunk--;
      if (chunk == 0) {
        char crlf[2];
        s.readBytes((uint8_t*)crlf, 2);   // consume trailing CRLF
        chunk = -1;                        // next byte starts a size line
      }
      return c;
    }
    return -1;
  }

 private:
  WiFiClientSecure &s;
  long chunk = -1;
  bool eof = false;
  bool decided = false;
  bool identity = false;
};

// Parse straight from the TLS stream with a small filter so the working doc
// stays tiny (the de-chunking wrapper above never buffers the full body). The
// 30-min window keeps the filtered result well within the auto-growing doc.
static void parse_timetable(Stream &s) {
  JsonDocument filter;
  JsonObject fresp = filter["response"][0].to<JsonObject>();
  fresp["TipoPedido"] = true;
  JsonObject fels = fresp["NodesComboioTabelsPartidasChegadas"][0].to<JsonObject>();
  fels["ComboioPassou"] = true;
  fels["DataHoraPartidaChegada"] = true;
  fels["NomeEstacaoDestino"] = true;
  fels["NComboio1"] = true;
  fels["Operador"] = true;
  fels["Observacoes"] = true;

  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, s, DeserializationOption::Filter(filter));
  if (err) {
    mlog.printf("[TRN] parse err %s free=%u blk=%u\n", err.c_str(), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxFreeBlockSize());
    gData.valid = false;
    return;
  }

  int n = 0;
  JsonArray response = doc["response"].as<JsonArray>();
  for (JsonObject tbl : response) {
    // Only the departures table (TipoPedido 1); TipoPedido 2 is arrivals.
    if ((tbl["TipoPedido"] | 0) != 1) continue;
    for (JsonObject el : tbl["NodesComboioTabelsPartidasChegadas"].as<JsonArray>()) {
      if (n >= TRAIN_MAX) break;
      if (el["ComboioPassou"] | false) continue;   // already left, skip
      const char *dep = el["DataHoraPartidaChegada"] | "";
      if (!dep[0]) continue;
      Train t;
      t.number = el["NComboio1"] | 0;
      copy_field(dep, t.departure, sizeof(t.departure));
      copy_field(el["NomeEstacaoDestino"] | "", t.destination, sizeof(t.destination));
      copy_field(el["Operador"] | "", t.service, sizeof(t.service));
      t.delay = parse_delay(el["Observacoes"] | "");
      gData.trains[n++] = t;
    }
    if (n >= TRAIN_MAX) break;
  }
  gData.count = n;
  gData.valid = true;
  gData.lastUpdated = time_utc_now();
  gData.lastOk = true;
  gUpdated = true;
  mlog.printf("[TRN] %d departures\n", n);
}

// Start a fetch: acquire TLS, open a client, and send the single GET request.
static void start_fetch() {
  if (ESP.getMaxFreeBlockSize() < TRAIN_MIN_HEAP) {
    mlog.println("[TRN] low heap, deferring 30s");
    first = false;
    lastCycle = millis();
    retryAt = millis() + TRAIN_RETRY;
    return;
  }
  if (!tls_try_acquire()) {
    static unsigned long lastWarn = 0;
    if (millis() - lastWarn > 5000) { mlog.println("[TRN] TLS busy, waiting"); lastWarn = millis(); }
    return;
  }
  first = false;
  cli = new BearSSL::WiFiClientSecure();
  if (!cli) { fail("alloc fail"); return; }
  cli->setInsecure();
  cli->setBufferSizes(4096, 512);
  cli->setTimeout(2000);
  phase = P_API;
  step = S_REQ;
  timer = millis();
}

void trains_tick() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!cfg.ip_station[0]) return;   // no station configured

  // Global watchdog so the FSM can never wedge.
  if (phase != P_IDLE && millis() - timer > 20000) { fail("phase timeout"); return; }

  switch (phase) {
    case P_IDLE:
      if (first || millis() - lastCycle >= TRAIN_INTERVAL ||
          (retryAt > 0 && millis() >= retryAt)) {
        start_fetch();
      }
      break;

    case P_API: {
      // --- GET the IP timetable (no credentials needed) ---
      if (step == S_REQ) {
        if (!cli || !cli->connected()) {
          if (cli && cli->connect(proxy_enabled() ? proxy_host() : TRAIN_HOST, TRAIN_PORT)) {
            String host, q;
            if (!train_request(host, q)) { fail("no query"); break; }
            String req = String("GET ") + q + " HTTP/1.1\r\n" +
                         "Host: " + host + "\r\n" +
                         "User-Agent: " + TRAIN_UA + "\r\n" +
                         "Accept: application/json\r\n";
            if (proxy_enabled()) req += "X-Periphery-Raw: 1\r\n";
            req += "Connection: close\r\n\r\n";
            cli->print(req);
            step = S_HDR;
            timer = millis();
          } else if (millis() - timer > 8000) {
            fail("api connect fail");
          }
        }
      } else if (step == S_HDR) {
        if (http_headers()) { step = S_BODY; timer = millis(); }
        else if (!cli->connected() && !cli->available()) fail("api no body");
        else if (millis() - timer > 6000) fail("api header timeout");
      } else { // S_BODY
        if (cli->available()) {
          ChunkedStream cs(*cli);
          parse_timetable(cs);
          cleanup();            // free TLS buffers (now empty/streamed)
          phase = P_IDLE;
          step = S_REQ;
          lastCycle = millis();
          retryAt = 0;
        } else if (!cli->connected()) {
          fail("api empty body");
        } else if (millis() - timer > 8000) {
          fail("api read stall");
        }
      }
      break;
    }
  }
}

// Synchronous first fetch used at boot. Single GET to the IP timetable API.
// Blocks until done or timeoutMs elapses. Skipped if no station is configured.
// At boot this is the only TLS session (flight/incidents have released the
// lock), so it's guaranteed to succeed if the network is up.
bool trains_fetch_blocking(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) { mlog.println("[TRN] block: no wifi"); return false; }
  if (!cfg.ip_station[0]) return false;
  if (ESP.getMaxFreeBlockSize() < TRAIN_MIN_HEAP) {
    mlog.printf("[TRN] block: low heap blk=%u, deferring\n", (unsigned)ESP.getMaxFreeBlockSize());
    return false;
  }
  if (!tls_try_acquire()) { mlog.println("[TRN] block: tls busy"); return false; }

  BearSSL::WiFiClientSecure *c = new BearSSL::WiFiClientSecure();
  if (!c) { tls_release(); mlog.println("[TRN] block: alloc fail"); return false; }
  c->setInsecure();
  c->setBufferSizes(4096, 512);
  c->setTimeout(3000);

  bool ok = false;
  unsigned long t0 = millis();
  String host = proxy_enabled() ? String(proxy_host()) : String(TRAIN_HOST);
  if (c->connect(host.c_str(), TRAIN_PORT)) {
    String q;
    if (!train_request(host, q)) { mlog.println("[TRN] block: no query"); }
    else {
      String req = String("GET ") + q + " HTTP/1.1\r\n" +
                   "Host: " + host + "\r\n" +
                   "User-Agent: " + TRAIN_UA + "\r\n" +
                   "Accept: application/json\r\n";
      if (proxy_enabled()) req += "X-Periphery-Raw: 1\r\n";
      req += "Connection: close\r\n\r\n";
      c->print(req);
      uint8_t m = 0;
      while (millis() - t0 < timeoutMs) {
        ESP.wdtFeed();
        while (c->available() && m < 4) {
          char ch = c->read();
          if ((m == 0 || m == 2) && ch == '\r') m++;
          else if ((m == 1 || m == 3) && ch == '\n') m++;
          else m = 0;
        }
        if (m == 4) break;
        if (!c->connected() && !c->available()) break;
      }
      if (m == 4) {
        ChunkedStream cs(*c);
        parse_timetable(cs);
        c->stop(); delete c; c = nullptr;
        tls_release();            // free TLS buffers (now empty/streamed)
        ok = gData.valid;
        if (!ok) { gData.lastUpdated = time_utc_now(); gData.lastOk = false; }
      }
    }
    lastCycle = millis();
    retryAt = 0;
    first = false;
  } else {
    mlog.println("[TRN] block: api connect failed");
    gData.lastUpdated = time_utc_now();
    gData.lastOk = false;
  }
  if (c) { c->stop(); delete c; }
  tls_release();
  return ok;
}
