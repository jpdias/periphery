#include "netsched.h"
#include "logbuf.h"
#include "netfsm.h"
#include "esphome.h"
#include "moon.h"
#include "trains.h"
#include "flight.h"
#include "incidents.h"
#include "config.h"
#include <Arduino.h>

static bool gGranted[NS_COUNT] = {false};
static int gCursor = 0;

static bool any_busy() {
  for (int i = 0; i < NS_COUNT; i++) {
    if (gGranted[i]) return true;
  }
  return false;
}

static const char* slot_name(NS_Slot s) {
  switch (s) {
    case NS_NET:       return "net";
    case NS_ESPHOME:   return "esphome";
    case NS_MOON:      return "moon";
    case NS_TRAINS:    return "trains";
    case NS_FLIGHT:    return "flight";
    case NS_INCIDENTS: return "incidents";
    default:           return "?";
  }
}

// A slot is "due" only when it is idle and its own trigger condition holds, so
// netsched_advance() can park the cursor on it instead of stalling the whole
// cascade behind a long-timer slot (moon 1/day, incidents 15 min).
static bool slot_due(NS_Slot s) {
  switch (s) {
    case NS_NET:       return netfsm_due();
    case NS_ESPHOME:   return esphome_due();
    case NS_MOON:      return moon_due();
    case NS_TRAINS:    return trains_due();
    case NS_FLIGHT:    return flight_due();
    case NS_INCIDENTS: return incidents_due();
    default:           return false;
  }
}

void netsched_begin() {
  gCursor = 0;
  for (int i = 0; i < NS_COUNT; i++) gGranted[i] = false;
}

bool netsched_can_start(NS_Slot s) {
  if (gGranted[s]) return true;            // already ours; keep driving
  if (any_busy()) return false;            // a fetch is in flight; no new starts
  if (s != gCursor) return false;          // not this slot's turn yet
  gGranted[s] = true;
  mlog.printf("[SCHED] %s start\n", slot_name(s));
  return true;
}

void netsched_done(NS_Slot s) {
  if (gGranted[s]) {
    gGranted[s] = false;
    mlog.printf("[SCHED] %s done\n", slot_name(s));
  }
  gCursor = (s + 1) % NS_COUNT;
}

void netsched_advance() {
  if (any_busy()) return;                  // never move the cursor mid-fetch
  for (int i = 0; i < NS_COUNT; i++) {
    NS_Slot c = (NS_Slot)((gCursor + i) % NS_COUNT);
    if (slot_due(c)) { gCursor = (int)c; return; }
  }
  gCursor = (gCursor + 1) % NS_COUNT;      // nothing due; keep rotating
}