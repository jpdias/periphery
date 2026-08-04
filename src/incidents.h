#pragma once
#include <Arduino.h>
#include <time.h>

#define INCIDENT_MAX 5

// Geofence trigger radius (meters). Configurable constant.
#define INCIDENT_RADIUS_M 10000

struct Incident {
  uint32_t id = 0;            // ID_oc
  float dst = 0.0f;           // haversine distance from device position (km)
  char natureza[28] = {0};    // e.g. "3313 - Movimento de massa"
  char estado[24] = {0};      // e.g. "Chegada ao TO"
  char concelho[48] = {0};    // e.g. "Serta"
  char localidade[48] = {0};  // e.g. "Pedrogao Pequeno"
  char dataHora[17] = {0};    // e.g. "05/02/2026 10:00"
};

struct IncidentData {
  Incident inc[INCIDENT_MAX];  // sorted nearest-first by distance
  int count = 0;
  bool valid = false;
  time_t lastUpdated = 0;      // unix time of last fetch attempt (ok or fail)
  bool lastOk = false;         // result of that last fetch attempt
};

// Non-blocking incidents fetcher (TLS to the ArcGIS FeatureServer). Refreshes
// every ~15 min; gated on the "Incidents" screen being enabled (screen index 1).
// The query is spatially filtered to INCIDENT_RADIUS_M of the configured
// location, so only incidents inside the geofence are returned.
void incidents_begin();
void incidents_tick();
bool incidents_updated();          // true once after a refresh
const IncidentData& incidents_data();
int incidents_next_refresh_secs(); // seconds until next fetch (0 = fetching now)

// Synchronous first fetch used at boot (the only TLS session by then, after the
// flight radar has released the lock). Blocks up to timeoutMs. Skipped if the
// Incidents screen is disabled.
bool incidents_fetch_blocking(unsigned long timeoutMs = 12000);

// Index into incidents_data().inc of the nearest incident within the geofence
// radius, or -1 if none / no valid data.
int incidents_geofence_hit();
