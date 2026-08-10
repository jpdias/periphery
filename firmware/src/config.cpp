#include "logbuf.h"
#include "config.h"
#include "env.h"
#include <LittleFS.h>
#include <ArduinoJson.h>

Config cfg;

static const char* CONFIG_PATH = "/config.json";

// Legacy EEPROM struct (v1 layout) for one-time migration into JSON.
struct LegacyConfig {
  char wifi_ssid[33];
  char wifi_pass[65];
  float lat;
  float lon;
  char tz[32];
  int weather_interval;
  bool show_metrics;
  char monitors[MONITOR_MAX][MONITOR_LEN];
  char esphome_host[MONITOR_LEN];
};

static void apply_defaults() {
  cfg = Config{};
  strncpy(cfg.wifi_ssid, WIFI_SSID, sizeof(cfg.wifi_ssid) - 1);
  strncpy(cfg.wifi_pass, WIFI_PASS, sizeof(cfg.wifi_pass) - 1);
  strncpy(cfg.monitors[0], "google.com", MONITOR_LEN - 1);
  strncpy(cfg.monitors[1], "github.com", MONITOR_LEN - 1);
  strncpy(cfg.monitors[2], "open-meteo.com", MONITOR_LEN - 1);
  strncpy(cfg.esphome_host, "ikea-hack.lan", MONITOR_LEN - 1);
}

static bool load_json() {
  File f = LittleFS.open(CONFIG_PATH, "r");
  if (!f) return false;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) { mlog.printf("[CFG] json parse error: %s\n", err.c_str()); return false; }

  strncpy(cfg.wifi_ssid, doc["wifi_ssid"] | "", sizeof(cfg.wifi_ssid) - 1);
  strncpy(cfg.wifi_pass, doc["wifi_pass"] | "", sizeof(cfg.wifi_pass) - 1);
  cfg.lat = doc["lat"] | 0.0f;
  cfg.lon = doc["lon"] | 0.0f;
  strncpy(cfg.tz, doc["tz"] | "Europe/Lisbon", sizeof(cfg.tz) - 1);
  strncpy(cfg.hostname, doc["hostname"] | "periphery", sizeof(cfg.hostname) - 1);
  cfg.weather_interval = doc["weather_interval"] | 600;
  cfg.show_metrics = doc["show_metrics"] | true;
  strncpy(cfg.esphome_host, doc["esphome_host"] | "", sizeof(cfg.esphome_host) - 1);
  strncpy(cfg.esphome_sensors, doc["esphome_sensors"] | cfg.esphome_sensors, sizeof(cfg.esphome_sensors) - 1);
  cfg.ntp_interval_min = doc["ntp_interval_min"] | 60;
  cfg.night_start = doc["night_start"] | 23;
  cfg.night_end = doc["night_end"] | 7;
  cfg.flight_range = doc["flight_range"] | 25;
  strncpy(cfg.ip_station, doc["ip_station"] | "", sizeof(cfg.ip_station) - 1);
  strncpy(cfg.ip_station_name, doc["ip_station_name"] | "", sizeof(cfg.ip_station_name) - 1);
  strncpy(cfg.api_base, doc["api_base"] | "", sizeof(cfg.api_base) - 1);
  cfg.use_api_proxy = doc["use_api_proxy"] | false;
  cfg.backlight_control = doc["backlight_control"] | true;
  cfg.backlight_active_high = doc["backlight_active_high"] | true;
  JsonArray scr = doc["screens"];
  if (!scr.isNull()) {
    for (int i = 0; i < SCREEN_MAX; i++) cfg.screen_enabled[i] = true;
    int si = 0;
    for (JsonVariant v : scr) {
      if (si >= SCREEN_MAX) break;
      cfg.screen_enabled[si++] = v.as<bool>();
    }
  }
  for (int i = 0; i < MONITOR_MAX; i++) cfg.monitors[i][0] = 0;
  JsonArray mons = doc["monitors"];
  int mi = 0;
  for (JsonVariant v : mons) {
    if (mi >= MONITOR_MAX) break;
    strncpy(cfg.monitors[mi++], v.as<const char*>(), MONITOR_LEN - 1);
  }
  return true;
}

// Try to import old EEPROM config into cfg. Returns true if a valid one existed.
static bool import_eeprom() {
  EEPROM.begin(CONFIG_SIZE);
  uint16_t magic = 0;
  uint8_t ver = 0;
  EEPROM.get(0, magic);
  EEPROM.get(2, ver);
  if (magic != CONFIG_MAGIC) { EEPROM.end(); return false; }
  LegacyConfig lc;
  EEPROM.get(4, lc);
  EEPROM.end();

  apply_defaults();  // start from defaults so new fields are populated
  strncpy(cfg.wifi_ssid, lc.wifi_ssid, sizeof(cfg.wifi_ssid) - 1);
  strncpy(cfg.wifi_pass, lc.wifi_pass, sizeof(cfg.wifi_pass) - 1);
  cfg.lat = lc.lat;
  cfg.lon = lc.lon;
  strncpy(cfg.tz, lc.tz, sizeof(cfg.tz) - 1);
  cfg.weather_interval = lc.weather_interval;
  cfg.show_metrics = lc.show_metrics;
  strncpy(cfg.esphome_host, lc.esphome_host, sizeof(cfg.esphome_host) - 1);
  for (int i = 0; i < MONITOR_MAX; i++) {
    lc.monitors[i][MONITOR_LEN - 1] = 0;
    strncpy(cfg.monitors[i], lc.monitors[i], MONITOR_LEN - 1);
  }
  mlog.println("[CFG] imported legacy EEPROM config");
  return true;
}

void config_load() {
  if (!LittleFS.begin()) mlog.println("[CFG] LittleFS mount failed");

  if (load_json()) {
    mlog.println("[CFG] loaded config.json");
    return;
  }
  if (import_eeprom()) {
    config_save();  // persist migrated config as JSON
    return;
  }
  mlog.println("[CFG] no config found, using defaults");
  apply_defaults();
  config_save();
}

void config_save() {
  JsonDocument doc;
  doc["wifi_ssid"] = cfg.wifi_ssid;
  doc["wifi_pass"] = cfg.wifi_pass;
  doc["lat"] = cfg.lat;
  doc["lon"] = cfg.lon;
  doc["tz"] = cfg.tz;
  doc["hostname"] = cfg.hostname;
  doc["weather_interval"] = cfg.weather_interval;
  doc["show_metrics"] = cfg.show_metrics;
  doc["esphome_host"] = cfg.esphome_host;
  doc["esphome_sensors"] = cfg.esphome_sensors;
  doc["ntp_interval_min"] = cfg.ntp_interval_min;
  doc["night_start"] = cfg.night_start;
  doc["night_end"] = cfg.night_end;
  doc["flight_range"] = cfg.flight_range;
  doc["ip_station"] = cfg.ip_station;
  doc["ip_station_name"] = cfg.ip_station_name;
  doc["api_base"] = cfg.api_base;
  doc["use_api_proxy"] = cfg.use_api_proxy;
  doc["backlight_control"] = cfg.backlight_control;
  doc["backlight_active_high"] = cfg.backlight_active_high;
  JsonArray scr = doc["screens"].to<JsonArray>();
  for (int i = 0; i < SCREEN_MAX; i++) scr.add(cfg.screen_enabled[i]);
  JsonArray mons = doc["monitors"].to<JsonArray>();
  for (int i = 0; i < MONITOR_MAX; i++) {
    if (cfg.monitors[i][0]) mons.add(cfg.monitors[i]);
  }

  if (doc.overflowed()) mlog.println("[CFG] WARN: JSON doc overflowed, data may be truncated");
  File f = LittleFS.open(CONFIG_PATH, "w");
  if (!f) { mlog.println("[CFG] save open failed"); return; }
  size_t n = serializeJsonPretty(doc, f);
  f.close();
  mlog.printf("[CFG] saved config.json (%u bytes)\n", (unsigned)n);
}

void config_reset() {
  apply_defaults();
  config_save();
}

String config_to_json() {
  JsonDocument doc;
  doc["wifi_ssid"] = cfg.wifi_ssid;
  doc["wifi_pass"] = cfg.wifi_pass;
  doc["lat"] = cfg.lat;
  doc["lon"] = cfg.lon;
  doc["tz"] = cfg.tz;
  doc["hostname"] = cfg.hostname;
  doc["weather_interval"] = cfg.weather_interval;
  doc["show_metrics"] = cfg.show_metrics;
  doc["esphome_host"] = cfg.esphome_host;
  doc["esphome_sensors"] = cfg.esphome_sensors;
  doc["ntp_interval_min"] = cfg.ntp_interval_min;
  doc["night_start"] = cfg.night_start;
  doc["night_end"] = cfg.night_end;
  doc["flight_range"] = cfg.flight_range;
  doc["ip_station"] = cfg.ip_station;
  doc["ip_station_name"] = cfg.ip_station_name;
  doc["api_base"] = cfg.api_base;
  doc["use_api_proxy"] = cfg.use_api_proxy;
  doc["backlight_control"] = cfg.backlight_control;
  doc["backlight_active_high"] = cfg.backlight_active_high;
  JsonArray scr = doc["screens"].to<JsonArray>();
  for (int i = 0; i < SCREEN_MAX; i++) scr.add(cfg.screen_enabled[i]);
  JsonArray mons = doc["monitors"].to<JsonArray>();
  for (int i = 0; i < MONITOR_MAX; i++)
    if (cfg.monitors[i][0]) mons.add(cfg.monitors[i]);
  String s;
  serializeJsonPretty(doc, s);
  return s;
}

// Copy a C-string value into a fixed buffer, length-capped (safe). Returns false if
// the source was non-empty but longer than the buffer (still copies what fits).
static bool copy_capped(char *dst, size_t dstLen, const char *src, const char *fallback) {
  if (!src || !*src) {
    if (fallback) { strncpy(dst, fallback, dstLen - 1); dst[dstLen - 1] = 0; }
    else dst[0] = 0;
    return true;
  }
  strncpy(dst, src, dstLen - 1);
  dst[dstLen - 1] = 0;
  return strlen(src) < dstLen;
}

static float clampf(float v, float lo, float hi, float def) {
  if (isnan(v)) return def;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static int clampi(int v, int lo, int hi, int def) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// Read a numeric JSON value tolerantly: accepts a real number OR a numeric string
// (e.g. "23"), since the config form may send either. Falls back to `def`.
static float jnum(JsonVariant v, float def) {
  if (v.isNull()) return def;
  if (v.is<const char*>()) { const char* s = v.as<const char*>(); return (s && *s) ? String(s).toFloat() : def; }
  return v.as<float>();
}

static long jint(JsonVariant v, long def) {
  if (v.isNull()) return def;
  if (v.is<const char*>()) { const char* s = v.as<const char*>(); return (s && *s) ? String(s).toInt() : def; }
  return v.as<long>();
}

bool config_apply_json(const String &body, String &err) {
  // Work on a throwaway copy so a bad payload never mutates the live config.
  Config next = cfg;

  JsonDocument doc;
  DeserializationError derr = deserializeJson(doc, body.c_str());
  if (derr) { err = String("JSON parse error: ") + derr.c_str(); return false; }
  if (!doc.is<JsonObject>()) { err = "Top-level JSON must be an object"; return false; }

  // Strings: length-capped, unknown keys ignored.
  if (doc["wifi_ssid"].isNull() == false)   copy_capped(next.wifi_ssid,   sizeof(next.wifi_ssid),   doc["wifi_ssid"],   "");
  if (doc["wifi_pass"].isNull() == false)   copy_capped(next.wifi_pass,   sizeof(next.wifi_pass),   doc["wifi_pass"],   "");
  if (doc["tz"].isNull() == false)          copy_capped(next.tz,          sizeof(next.tz),          doc["tz"],          "Europe/Lisbon");
  if (doc["hostname"].isNull() == false) {
    // Reuse the DNS-label sanitizer via portal is awkward here; do a minimal safe
    // copy and let portal's sanitize_hostname handle the canonical form later.
    copy_capped(next.hostname, sizeof(next.hostname), doc["hostname"], "periphery");
  }
  if (doc["esphome_host"].isNull() == false)   copy_capped(next.esphome_host, sizeof(next.esphome_host), doc["esphome_host"], "");
  if (doc["esphome_sensors"].isNull() == false) copy_capped(next.esphome_sensors, sizeof(next.esphome_sensors), doc["esphome_sensors"], "");

  // Floats: range-clamped. (jnum accepts numbers or numeric strings.)
  if (doc["lat"].isNull() == false) next.lat = clampf(jnum(doc["lat"], cfg.lat), -90.0f, 90.0f, cfg.lat);
  if (doc["lon"].isNull() == false) next.lon = clampf(jnum(doc["lon"], cfg.lon), -180.0f, 180.0f, cfg.lon);

  // Ints: range-clamped. (jint accepts numbers or numeric strings.)
  if (doc["weather_interval"].isNull() == false) next.weather_interval = clampi(jint(doc["weather_interval"], cfg.weather_interval), 60, 86400, cfg.weather_interval);
  if (doc["ntp_interval_min"].isNull() == false)  next.ntp_interval_min  = clampi(jint(doc["ntp_interval_min"], cfg.ntp_interval_min), 1, 1440, cfg.ntp_interval_min);
  if (doc["night_start"].isNull() == false)       next.night_start       = clampi(jint(doc["night_start"], cfg.night_start), 0, 23, cfg.night_start);
  if (doc["night_end"].isNull() == false)         next.night_end         = clampi(jint(doc["night_end"], cfg.night_end), 0, 23, cfg.night_end);
  if (doc["flight_range"].isNull() == false)      next.flight_range      = clampi(jint(doc["flight_range"], cfg.flight_range), 0, 250, cfg.flight_range);
  if (doc["ip_station"].isNull() == false)        copy_capped(next.ip_station, sizeof(next.ip_station), doc["ip_station"], "");
  if (doc["ip_station_name"].isNull() == false)   copy_capped(next.ip_station_name, sizeof(next.ip_station_name), doc["ip_station_name"], "");
  if (doc["api_base"].isNull() == false)          copy_capped(next.api_base, sizeof(next.api_base), doc["api_base"], "");

  // Bools.
  if (doc["show_metrics"].isNull() == false)         next.show_metrics         = (jint(doc["show_metrics"], cfg.show_metrics ? 1 : 0) != 0);
  if (doc["use_api_proxy"].isNull() == false)        next.use_api_proxy        = (jint(doc["use_api_proxy"], cfg.use_api_proxy ? 1 : 0) != 0);
  if (doc["backlight_control"].isNull() == false)    next.backlight_control    = doc["backlight_control"] | cfg.backlight_control;
  if (doc["backlight_active_high"].isNull() == false) next.backlight_active_high = doc["backlight_active_high"] | cfg.backlight_active_high;

  // Screens array: bounded to SCREEN_MAX, defaults true if missing.
  if (doc["screens"].isNull() == false) {
    JsonArray scr = doc["screens"];
    if (!scr.isNull()) {
      for (int i = 0; i < SCREEN_MAX; i++) next.screen_enabled[i] = true;
      int si = 0;
      for (JsonVariant v : scr) { if (si >= SCREEN_MAX) break; next.screen_enabled[si++] = v.as<bool>(); }
    }
  }

  // Monitors: accept either an array of strings OR a single string (comma/newline
  // separated). Bounded to MONITOR_MAX, each entry length-capped and non-empty.
  for (int i = 0; i < MONITOR_MAX; i++) next.monitors[i][0] = 0;
  int mi = 0;
  auto add_mon = [&](const char *s) {
    if (mi >= MONITOR_MAX || !s || !*s) return;
    String h = s;
    h.trim();
    if (h.length() == 0 || h.length() >= MONITOR_LEN) return;  // skip empty / too long
    strncpy(next.monitors[mi++], h.c_str(), MONITOR_LEN - 1);
  };
  if (doc["monitors"].isNull() == false) {
    JsonVariant mv = doc["monitors"];
    if (mv.is<JsonArray>()) { for (JsonVariant v : mv.as<JsonArray>()) add_mon(v.as<const char*>()); }
    else if (mv.is<const char*>()) {
      String s = mv.as<const char*>();
      s.replace("\n", ",");
      int start = 0;
      for (int i = 0; i <= (int)s.length(); i++) {
        if (i == (int)s.length() || s[i] == ',') { String tok = s.substring(start, i); start = i + 1; add_mon(tok.c_str()); }
      }
    }
  }

  // Commit only after everything validated.
  cfg = next;
  err = "";
  return true;
}
