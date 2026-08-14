#include "logbuf.h"
#include "trains.h"
#include "config.h"
#include "env.h"
#include "nettime.h"
#include "netproxy.h"
#include "bodyutil.h"
#include "tlslock.h"
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

static const uint16_t TRAIN_PORT = 443;
static const unsigned long TRAIN_INTERVAL = 300000;  // default refresh (no timetable yet)
static const unsigned long TRAIN_MIN_INTERVAL = 60000;   // never poll faster than 1/min
static const unsigned long TRAIN_MAX_INTERVAL = 21600000L; // safety guard: the batch is
                                                          // exhausted once its LAST train
                                                          // passes; cap is only a bound
                                                          // (6h) against a bad parse
static const unsigned long TRAIN_RETRY = 30000;      // quick retry after a defer/fail
static const uint32_t TRAIN_MIN_HEAP = 8192;         // streaming parse: ~5-6KB contiguous is enough
// Adaptive request window (seconds). Start tiny so each body stays small enough
// to fit the tight boot heap; grow only when a window can't fill TRAIN_MAX.
static const time_t TRAIN_WIN_MIN = 900;             // 15 min — smallest useful window
static const time_t TRAIN_WIN_MAX = 21600;           // 6h cap (quiet station fallback)

// Sent to the Netlify proxy; it forwards whatever the IP API needs. Public API,
// no secrets.
static const char* TRAIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/144.0.0.0 Safari/537.36";

static TrainData gData;
static bool gUpdated = false;

static BearSSL::WiFiClientSecure *cli = nullptr;

// Rolling-cursor state. gCursor is the unix time of the LAST departure already
// fetched, so the next window starts 1 minute after it — the same trains are
// never requested twice. RAM-only (resets to 0 at boot, so the first fetch asks
// for everything from "now").
static time_t gCursor = 0;
static time_t gWinEnd = 0;           // end of the current window (empty-window advance)
static time_t gWinLen = TRAIN_WIN_MIN;   // current adaptive window (grows when a
                                         // window can't fill TRAIN_MAX)

enum Phase { P_IDLE, P_API };
enum Step { S_REQ, S_HDR, S_BODY };
static Phase phase = P_IDLE;
static Step step = S_REQ;
static String bodyBuf;              // response body drained across loop ticks
static String hdrBuf;               // raw response headers (content-length scan)
static long httpContentLen = -1;    // Content-Length from the response (-1 unknown)
static unsigned long timer = 0;
static unsigned long lastCycle = 0;
static unsigned long retryAt = 0;
static unsigned long gNextIn = TRAIN_INTERVAL;   // ms until next fetch (smart TTL)
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
  if (elapsed >= gNextIn) return 0;
  return (int)((gNextIn - elapsed + 999) / 1000);
}

void trains_begin() {
  phase = P_IDLE;
  step = S_REQ;
  first = true;
  lastCycle = 0;
  retryAt = 0;
  gNextIn = TRAIN_INTERVAL;
  gCursor = 0;
  gWinEnd = 0;
  gWinLen = TRAIN_WIN_MIN;
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
  gNextIn = TRAIN_INTERVAL;
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

// Build the IP timetable request through the Netlify proxy: /api/trains with
// station/date/start/end query params (the function translates them to the IP
// API path server-side). The window starts 1 minute after the last departure
// already fetched (gCursor) so departure batches are never re-fetched — each
// request returns the next batch ahead; on boot gCursor is 0 so it starts from
// the current clock. The proxy merges segments that cross midnight. Times are
// local (Europe/Lisbon via nettime). Returns false if the clock isn't synced or
// no station is set.
static bool train_request(String &host, String &url) {
  if (!cfg.ip_station[0]) return false;
  time_t now = time_utc_now();
  if (now < 1609459200UL) return false;      // clock not synced yet (>= 2021)

  // Window start: 1 minute after the last fetched departure, else now.
  time_t start = (gCursor > 0) ? gCursor + 60 : now;
  struct tm st;
  localtime_r(&start, &st);

  char date[16], startS[16], endS[16];
  // Modulo bounds the ints so GCC knows the %0Nd formats can't overflow (kills
  // -Wformat-truncation); the values themselves are already < their limits.
  snprintf(date, sizeof(date), "%04d-%02d-%02d",
           (st.tm_year + 1900) % 10000, (st.tm_mon + 1) % 100, st.tm_mday % 100);
  snprintf(startS, sizeof(startS), "%02d:%02d", st.tm_hour % 100, st.tm_min % 100);

  time_t windowEnd = start + gWinLen;      // adaptive window (grows if it can't
  gWinEnd = windowEnd;                      // fill TRAIN_MAX on a quiet station)
  struct tm et;
  localtime_r(&windowEnd, &et);
  snprintf(endS, sizeof(endS), "%02d:%02d", et.tm_hour % 100, et.tm_min % 100);

  host = proxy_host();
  String q = "station=" + String(cfg.ip_station) +
             "&date=" + String(date) +
             "&start=" + String(startS) +
             "&end=" + String(endS);
  url = proxy_path("trains", q);
  return true;
}

// Consume response headers up to the blank line; returns true when body reached
// and httpContentLen has been set from the Content-Length header (if present).
static uint8_t hdrMatch = 0;   // progress through "\r\n\r\n"; reset per fetch
static bool http_headers() {
  uint8_t &m = hdrMatch;
  while (cli->available()) {
    char c = (char)cli->read();
    if (hdrMatch == 4) break;            // keep body bytes out of hdrBuf
    if (hdrBuf.length() < 1024) hdrBuf += c;
    if ((m == 0 || m == 2) && c == '\r') m++;
    else if ((m == 1 || m == 3) && c == '\n') {
      m++;
      if (m == 4) {
        m = 0;
        httpContentLen = header_content_length(hdrBuf);
        hdrBuf = "";
        return true;
      }
    } else m = 0;
  }
  if (!cli->connected() && !cli->available()) return false;   // closed, no body
  if (millis() - timer > 6000) return false;                  // header timeout
  return false;                                               // need more data
}

// Smart TTL for the rolling cursor: once a batch is fetched, only refetch when
// the LAST shown departure has passed — that's when the batch is exhausted and
// the next TRAIN_MAX up ahead become the new head. Clamped so a busy station
// never polls faster than TRAIN_MIN_INTERVAL and a quiet one never goes stale
// past TRAIN_MAX_INTERVAL (delays/cancellations still get picked up within that
// bound).
static void set_next_refresh() {
  gNextIn = TRAIN_INTERVAL;
  if (!gData.valid || gData.count == 0) return;
  time_t last = gData.trains[gData.count - 1].depEpoch;
  if (last == 0) return;                          // no epoch parsed (shouldn't happen)
  long delta = (long)(last - time_utc_now());
  if (delta <= 0) { gNextIn = TRAIN_MIN_INTERVAL; return; }  // batch just exhausted → refetch soon
  unsigned long ms = (unsigned long)delta * 1000UL;
  if (ms < TRAIN_MIN_INTERVAL) ms = TRAIN_MIN_INTERVAL;
  if (ms > TRAIN_MAX_INTERVAL) ms = TRAIN_MAX_INTERVAL;
  gNextIn = ms;
  mlog.printf("[TRN] next batch in %lus\n", ms / 1000);
}

// Parse the buffered timetable JSON (framing already stripped by slice_json)
// with a small filter so the working doc stays tiny.
static void parse_timetable(const String &json) {
  JsonDocument filter;
  JsonObject fresp = filter["response"][0].to<JsonObject>();
  fresp["TipoPedido"] = true;
  JsonObject fels = fresp["NodesComboioTabelsPartidasChegadas"][0].to<JsonObject>();
  fels["ComboioPassou"] = true;
  fels["DataHoraPartidaChegada"] = true;
  fels["DataHoraPartidaChegada_ToOrderByi"] = true;
  fels["NomeEstacaoDestino"] = true;
  fels["NComboio1"] = true;
  fels["Operador"] = true;
  fels["Observacoes"] = true;

  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, json, DeserializationOption::Filter(filter));
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
      // /Date(1786706790000+0100)/ -> epoch seconds (ms is UTC-based).
      t.depEpoch = 0;
      const char *ms = strstr(el["DataHoraPartidaChegada_ToOrderByi"] | "", "(");
      if (ms) t.depEpoch = (time_t)(atoll(ms + 1) / 1000);
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
  // Rolling cursor: the next fetch must start after the LAST departure we got.
  if (n > 0) {
    time_t lastDep = gData.trains[n - 1].depEpoch;
    if (lastDep > gCursor) gCursor = lastDep;
    // Quiet station (window didn't fill TRAIN_MAX): widen the next request so
    // it looks further ahead; a full batch means the current width is enough,
    // so keep it minimal — the fewer trains per request the better the heap.
    if (n < TRAIN_MAX && gWinLen < TRAIN_WIN_MAX) {
      gWinLen = (gWinLen * 2 > TRAIN_WIN_MAX) ? TRAIN_WIN_MAX : gWinLen * 2;
      mlog.printf("[TRN] quiet, window %.0fmin\n", (double)gWinLen / 60.0);
    }
  } else {
    // Nothing new in this window; jump the cursor to the far edge so a later
    // request keeps looking ahead instead of re-requesting the same batch.
    if (gWinEnd > gCursor) gCursor = gWinEnd;
    if (gWinLen < TRAIN_WIN_MAX) {   // truly quiet/gap: widen next request
      gWinLen = (gWinLen * 2 > TRAIN_WIN_MAX) ? TRAIN_WIN_MAX : gWinLen * 2;
      mlog.printf("[TRN] gap, window %.0fmin\n", (double)gWinLen / 60.0);
    }
  }
  gUpdated = true;
  set_next_refresh();
  mlog.printf("[TRN] %d departures, cursor=%ld\n", n, (long)gCursor);
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
  hdrMatch = 0;   // a mid-header abort must not corrupt the next fetch
  hdrBuf = "";
  httpContentLen = -1;
  bodyBuf = "";
  cli = new BearSSL::WiFiClientSecure();
  if (!cli) { fail("alloc fail"); return; }
  cli->setInsecure();
  cli->setBufferSizes(2048, 512);
  cli->setTimeout(2000);
  phase = P_API;
  step = S_REQ;
  timer = millis();
}

void trains_tick() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!cfg.api_base[0]) return;   // proxy required
  if (!cfg.ip_station[0]) return;   // no station configured

  // Global watchdog so the FSM can never wedge.
  if (phase != P_IDLE && millis() - timer > 20000) { fail("phase timeout"); return; }

  switch (phase) {
    case P_IDLE:
      if (first || millis() - lastCycle >= gNextIn ||
          (retryAt > 0 && millis() >= retryAt)) {
        start_fetch();
      }
      break;

    case P_API: {
      // --- GET the timetable via the Netlify proxy (no credentials needed) ---
      if (step == S_REQ) {
        if (!cli || !cli->connected()) {
          if (cli && cli->connect(proxy_host(), TRAIN_PORT)) {
            String host, q;
            if (!train_request(host, q)) { fail("no query"); break; }
            String req = String("GET ") + q + " HTTP/1.1\r\n" +
                         "Host: " + host + "\r\n" +
                         "User-Agent: " + TRAIN_UA + "\r\n" +
                         "Accept: application/json\r\n" +
                         "X-Periphery-Raw: 1\r\n\r\n";
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
          parse_timetable(json);
          bool ok = gData.valid;
          cleanup();            // free TLS buffers (body already buffered)
          phase = P_IDLE;
          step = S_REQ;
          first = false;
          lastCycle = millis();
          retryAt = ok ? 0 : (millis() + TRAIN_RETRY);   // bad parse: retry sooner
        } else if (millis() - timer > 12000) {
          bodyBuf = "";
          httpContentLen = -1;
          fail("api read stall");
        }
      }
      break;
    }
  }
}

// Synchronous first fetch used at boot. Drives the non-blocking trains FSM
// (which drains the body across loop iterations — immune to the BearSSL close
// race that drops a single-burst body). Blocks until the first successful fetch
// with departures completes, the window is exhausted/grown to its cap, or
// timeoutMs elapses. Skipped if no station is configured.
bool trains_fetch_blocking(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) { mlog.println("[TRN] block: no wifi"); return false; }
  if (!cfg.api_base[0]) return false;
  if (!cfg.ip_station[0]) return false;

  trains_tick();   // begin the fetch
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    ESP.wdtFeed();
    if (phase == P_IDLE) {
      // Cycle finished. Done when we have departures, gave up, or hit the cap.
      if (gData.valid && gData.count > 0) return true;
      if (gData.valid && gWinLen >= TRAIN_WIN_MAX) return gData.count > 0;
      // Empty/gap window: fire the next fetch immediately so the adaptive
      // window keeps widening until there's something to show at boot.
      if (first || retryAt == 0 || millis() >= retryAt) {
        start_fetch();   // safe: phase is P_IDLE and we're in the same unit
      }
    }
    trains_tick();
    delay(50);
  }
  return gData.valid && gData.count > 0;
}
