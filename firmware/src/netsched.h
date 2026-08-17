#pragma once

// Serializes every widget fetch so only one data pull is ever in flight. The
// scheduler hands the network to one "slot" at a time in a fixed round-robin
// order, so the main-loop fetchers no longer race first-come-first-served for
// the TLS lock or spike the heap by overlapping request sequences. This is the
// runtime counterpart to the deterministic blocking boot sequence in setup().
//
// A slot claims the wire with netsched_can_start() the moment it's idle and due
// (it may only claim when it's the scheduler's current pick). It must report
// back with netsched_done() once its whole fetch cycle finishes (success or
// fail), which hands the turn to the next slot. netsched_advance() is called
// once per loop to park the cursor on the next due slot.

enum NS_Slot {
  NS_NET,        // netfsm        weather -> forecast -> external IP (one cycle)
  NS_ESPHOME,    // esphome       per-sensor batch
  NS_MOON,       // moon          once per local day
  NS_TRAINS,     // trains        smart TTL (biggest body, most heap)
  NS_FLIGHT,     // flight radar  30s
  NS_INCIDENTS,  // incidents     15 min / early retry
  NS_COUNT
};

// true only for the slot currently holding the network (or the one the cursor
// is parked on while everything is idle). Call when idle and due, just before
// starting a fetch.
bool netsched_can_start(NS_Slot s);

// Report that the slot's fetch cycle has finished. Advances the cursor to the
// next slot. Safe to call even if the slot never claimed the wire.
void netsched_done(NS_Slot s);

// Reset scheduler state (call once after all fetchers' _begin() in setup()).
void netsched_begin();

// Called each loop: when nothing is in flight, park the cursor on the next due
// slot so it can start at its turn. Idempotent.
void netsched_advance();