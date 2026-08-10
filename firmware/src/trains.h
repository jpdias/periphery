#pragma once
#include <Arduino.h>
#include <time.h>

#define TRAIN_MAX 5

struct Train {
  uint32_t number = 0;
  char departure[6] = {0};     // "HH:MM" local (DataHoraPartidaChegada)
  char destination[32] = {0};  // NomeEstacaoDestino
  char service[24] = {0};      // Operador (e.g. "CP PORTO", "CP REGIONAL")
  char platform[8] = {0};      // not provided by IP API (unused)
  int  delay = 0;              // minutes, parsed from Observacoes (0 = on time)
};

struct TrainData {
  Train trains[TRAIN_MAX];     // next departures, time-ordered
  int count = 0;
  bool valid = false;
  time_t lastUpdated = 0;      // unix time of last fetch attempt (ok or fail)
  bool lastOk = false;         // result of that last fetch attempt
};

// Non-blocking train departures fetcher. Uses the public Infraestruturas de
// Portugal (IP) timetable API — no API keys, credentials or cookies; the only
// header needed is a browser User-Agent. Refreshes every ~5 min; the fetch is
// gated on an IP station node ID being configured (cfg.ip_station).
void trains_begin();
void trains_tick();
bool trains_updated();          // true once after a refresh
const TrainData& trains_data();
int trains_next_refresh_secs(); // seconds until next fetch (0 = fetching now)

// Synchronous first fetch used at boot (the only TLS session by then). Blocks up
// to timeoutMs. Skipped if no station node ID is configured.
bool trains_fetch_blocking(unsigned long timeoutMs = 12000);
