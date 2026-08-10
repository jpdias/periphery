#pragma once
#include <Arduino.h>
#include <time.h>

struct Weather {
  float temp = 0.0f;
  int humidity = 0;
  int code = 0;
  char desc[24] = {0};
  char sunrise[6] = {0};   // "HH:MM" local
  char sunset[6] = {0};    // "HH:MM" local
  bool valid = false;
};

struct DayForecast {
  int code = 0;
  float tmin = 0.0f;
  float tmax = 0.0f;
  bool valid = false;
};

struct Forecast {
  DayForecast days[3];
  bool valid = false;
};

void time_begin();
void time_update();                 // sync NTP + apply TZ
void time_tick();                   // periodic resync / retry (call from loop)
bool time_is_synced();              // true after first successful NTP sync
void time_now(int &h, int &m, int &s, int &dow, int &day, int &mon, int &yr);
const char* dow_name(int d);
time_t time_utc_now();      // current unix time (UTC seconds)
long time_tz_offset();      // local offset from UTC in seconds (incl. DST)

// Timezone helpers: friendly IANA name <-> POSIX TZ string, and dropdown list.
const char* tz_to_posix(const char* name);
int tz_count();
const char* tz_name_at(int i);

const char* weather_icon(int code);

// Shared body parsers (used by the non-blocking FSM). These parse the raw
// upstream bodies returned verbatim by the Netlify proxy (X-Periphery-Raw: 1).
bool parse_weather_body(const String &body, Weather &w);
bool parse_forecast_body(const String &body, Forecast &f);
bool parse_extip_body(const String &body, String &ip);

