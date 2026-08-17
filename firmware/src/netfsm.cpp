#include "logbuf.h"
#include "netfsm.h"
#include "config.h"
#include "httpfsm.h"
#include "netproxy.h"
#include "tlslock.h"
#include "netsched.h"
#include <ESP8266WiFi.h>

enum NetTask { TASK_WEATHER, TASK_FORECAST, TASK_EXTIP };

static Weather gWeather;
static Forecast gForecast;
static String gExtIp = "";
static bool gUpdated = false;
static bool gFirstDone = false;

static HttpFsm http;
static NetTask netTask = TASK_WEATHER;
static unsigned long netInterval = 600000;
static unsigned long netLastCycle = 0;
static bool netFirst = true;
static bool netActive = false;

// The weather->forecast->ip cycle holds the TLS lock for its whole run so the
// three quick proxied GETs run back-to-back without contention.
static bool netHoldsLock = false;

// Forecast is "slow" data: fetch it at boot and twice a day (midnight + noon,
// local). Track which half-day we last fetched so we don't hammer the API on
// every weather refresh.
static int gForecastHalfDay = -1;

static int current_halfday() {
  // 0 = 00:00-11:59, 1 = 12:00-23:59, by local clock.
  int h = 0, m = 0, s = 0, dow = 0, day = 0, mon = 0, yr = 0;
  if (time_is_synced()) time_now(h, m, s, dow, day, mon, yr);
  return (h < 12) ? 0 : 1;
}

static bool forecast_stale() {
  if (!time_is_synced()) return false;     // can't decide without a clock
  return (gForecastHalfDay != current_halfday()) || !gForecast.valid;
}

Weather& net_weather() { return gWeather; }
Forecast& net_forecast() { return gForecast; }
String net_extip() { return gExtIp; }

void netfsm_mark_forecast_fresh() {
  if (time_is_synced()) gForecastHalfDay = current_halfday();
}

bool netfsm_updated() {
  if (gUpdated) { gUpdated = false; return true; }
  return false;
}

bool netfsm_first_done() { return gFirstDone; }

bool netfsm_due() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!cfg.api_base[0]) return false;   // proxy required
  return !netActive && (netFirst || millis() - netLastCycle >= netInterval);
}

void netfsm_begin(unsigned long intervalMs) {
  netInterval = intervalMs;
  netLastCycle = 0;
  netFirst = true;
  netActive = false;
  netHoldsLock = false;
  gForecastHalfDay = -1;   // boot's blocking fetch will set gForecast.valid
  http.consume();
}

// Begin a task. The TLS lock must already be held (acquired in netfsm_tick
// when the cycle starts).
static void start_task(NetTask t) {
  String url;
  switch (t) {
    case TASK_WEATHER:
      url = proxy_path("weather", "lat=" + String(cfg.lat, 4) +
                        "&lon=" + String(cfg.lon, 4));
      break;
    case TASK_FORECAST:
      url = proxy_path("forecast", "lat=" + String(cfg.lat, 4) +
                        "&lon=" + String(cfg.lon, 4));
      break;
    case TASK_EXTIP:
      url = proxy_path("ip", "");
      break;
  }
  mlog.printf("[NET] start %d -> %s\n", t, url.c_str());
  if (!http.begin(proxy_host(), url, 443, true, "X-Periphery-Raw: 1")) {
    tls_release();
    netHoldsLock = false;
    netActive = false;
    netsched_done(NS_NET);
  }
}

static void finish_task(NetTask t, const String &raw) {
  if (t == TASK_WEATHER) { parse_weather_body(raw, gWeather); gUpdated = true; }
  else if (t == TASK_FORECAST) { parse_forecast_body(raw, gForecast); gUpdated = true; }
  else if (t == TASK_EXTIP) {
    String ip;
    if (parse_extip_body(raw, ip) && ip.length()) gExtIp = ip;
    gUpdated = true;
  }
}

static void next_task() {
  if (netTask == TASK_WEATHER) {
    if (forecast_stale()) { netTask = TASK_FORECAST; start_task(netTask); }
    else { netTask = TASK_EXTIP; start_task(netTask); }
  }
  else if (netTask == TASK_FORECAST) {
    gForecastHalfDay = current_halfday();
    netTask = TASK_EXTIP; start_task(netTask);
  }
  else {
    netLastCycle = millis();
    gUpdated = true;
    gFirstDone = true;
    netActive = false;
    tls_release();
    netHoldsLock = false;
    netsched_done(NS_NET);
    mlog.println("[NET] cycle complete");
  }
}

void netfsm_tick() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!cfg.api_base[0]) return;   // proxy required; nothing to fetch without it

  if (!netActive) {
    if (netFirst || millis() - netLastCycle >= netInterval) {
      if (!netsched_can_start(NS_NET)) return;   // not our turn in the cascade
      if (!tls_try_acquire()) { netsched_done(NS_NET); return; }  // safety; cascade prevents overlap
      netHoldsLock = true;
      netFirst = false;
      netActive = true;
      netTask = TASK_WEATHER;
      start_task(netTask);
    }
    return;
  }

  http.tick();
  if (http.done()) {
    String raw = http.body();
    http.consume();
    finish_task(netTask, raw);
    next_task();
  } else if (http.failed()) {
    http.consume();
    next_task();   // skip failed task, keep cycle moving
  }
}
