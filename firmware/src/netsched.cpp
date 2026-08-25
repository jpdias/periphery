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

// Cooldown between consecutive fetchers: gives freed TLS buffers time to
// coalesce so the next fetcher starts from a less-fragmented heap.
static const unsigned long COOLDOWN_MS = 500;
static unsigned long cooldownUntil = 0;

// Minimum contiguous heap required before any new TLS fetch can start.
static const uint32_t SCHED_MIN_HEAP = 10240;

// Consecutive failure counter. If every fetcher keeps failing (heap too low,
// network down, etc.), reboot the device instead of spinning forever.
static int consecutiveFails = 0;
static const int MAX_CONSECUTIVE_FAILS = 6;

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
  cooldownUntil = 0;
  consecutiveFails = 0;
  for (int i = 0; i < NS_COUNT; i++) gGranted[i] = false;
}

bool netsched_can_start(NS_Slot s) {
  if (gGranted[s]) return true;            // already ours; keep driving
  if (any_busy()) return false;            // a fetch is in flight; no new starts
  if (s != gCursor) return false;          // not this slot's turn yet
  // Heap guard: refuse if not enough contiguous free memory for TLS buffers +
  // ArduinoJson working doc. The caller will defer and retry next loop.
  if (ESP.getMaxFreeBlockSize() < SCHED_MIN_HEAP) {
    mlog.printf("[SCHED] %s low heap blk=%u, deferring\n", slot_name(s),
                (unsigned)ESP.getMaxFreeBlockSize());
    return false;
  }
  // Cooldown: don't chain fetchers back-to-back; let freed TLS buffers coalesce.
  if (millis() < cooldownUntil) return false;
  gGranted[s] = true;
  mlog.printf("[SCHED] %s start\n", slot_name(s));
  return true;
}

void netsched_done(NS_Slot s) {
  bool wasGranted = gGranted[s];
  if (wasGranted) {
    gGranted[s] = false;
    mlog.printf("[SCHED] %s done\n", slot_name(s));
  }
  gCursor = (s + 1) % NS_COUNT;
  // Start the cooldown window for the next fetcher.
  if (wasGranted) cooldownUntil = millis() + COOLDOWN_MS;
}

void netsched_record_success() {
  consecutiveFails = 0;
}

void netsched_record_failure() {
  consecutiveFails++;
  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS * NS_COUNT) {
    mlog.printf("[SCHED] %d consecutive failures, rebooting\n", consecutiveFails);
    delay(200);
    ESP.restart();
  }
}

void netsched_advance() {
  if (any_busy()) return;                  // never move the cursor mid-fetch
  if (millis() < cooldownUntil) return;    // respect cooldown
  // Heap guard: don't start a new fetch if fragmented.
  if (ESP.getMaxFreeBlockSize() < SCHED_MIN_HEAP) return;
  // Find the next due slot that can actually start.  Skip past slots that are
  // due but blocked (e.g. heap too low) so the cascade doesn't stall behind
  // a single memory-hungry fetcher.
  for (int i = 0; i < NS_COUNT; i++) {
    NS_Slot c = (NS_Slot)((gCursor + i) % NS_COUNT);
    if (!slot_due(c)) continue;
    gCursor = (int)c;
    return;
  }
  gCursor = (gCursor + 1) % NS_COUNT;      // nothing due; keep rotating
}