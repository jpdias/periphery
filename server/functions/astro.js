import { normalizeEvent, handleOptions, ok, fail } from "./utils.js";

// Astronomical calendar — annual meteor showers (IMO Working List data).
// Peak dates are given as month/day and are stable year to year; the function
// resolves them to real dates for the current year, flags which are active /
// upcoming, and ranks by peak proximity so the widget can show "next shower".

const SHOWERS = [
  { code: "QUA", name: "Quadrantids",      peak: { m: 1,  d: 3  }, active: { m: 12, d: 28, endM: 1, endD: 12 }, zhr: 110, radiant: "Boötes", parent: "2003 EH1" },
  { code: "LYR", name: "Lyrids",           peak: { m: 4,  d: 22 }, active: { m: 4,  d: 14, endM: 4, endD: 30 }, zhr: 18,  radiant: "Lyra", parent: "C/1861 G1" },
  { code: "ETA", name: "Eta Aquariids",    peak: { m: 5,  d: 6  }, active: { m: 4,  d: 19, endM: 5, endD: 28 }, zhr: 50,  radiant: "Aquarius", parent: "1P/Halley" },
  { code: "CAP", name: "Alpha Capricornids",peak: { m: 7,  d: 30 }, active: { m: 7,  d: 3,  endM: 8,  endD: 15 }, zhr: 5,   radiant: "Capricornus", parent: "169P/NEAT" },
  { code: "SDA", name: "S. delta Aquariids",peak: { m: 7,  d: 30 }, active: { m: 7,  d: 12, endM: 8,  endD: 23 }, zhr: 25,  radiant: "Aquarius", parent: "96P/Machholz" },
  { code: "PER", name: "Perseids",         peak: { m: 8,  d: 12 }, active: { m: 7,  d: 17, endM: 8,  endD: 24 }, zhr: 100, radiant: "Perseus", parent: "109P/Swift-Tuttle" },
  { code: "DRA", name: "Draconids",        peak: { m: 10, d: 9  }, active: { m: 10, d: 6,  endM: 10, endD: 10 }, zhr: 10,  radiant: "Draco", parent: "21P/Giacobini-Zinner" },
  { code: "ORI", name: "Orionids",         peak: { m: 10, d: 21 }, active: { m: 10, d: 2,  endM: 11, endD: 7  }, zhr: 20,  radiant: "Orion", parent: "1P/Halley" },
  { code: "STA", name: "S. Taurids",       peak: { m: 11, d: 5  }, active: { m: 9,  d: 20, endM: 11, endD: 20 }, zhr: 5,   radiant: "Taurus", parent: "2P/Encke" },
  { code: "NTA", name: "N. Taurids",       peak: { m: 11, d: 12 }, active: { m: 10, d: 20, endM: 12, endD: 10 }, zhr: 5,   radiant: "Taurus", parent: "2P/Encke" },
  { code: "LEO", name: "Leonids",          peak: { m: 11, d: 17 }, active: { m: 11, d: 6,  endM: 11, endD: 30 }, zhr: 15,  radiant: "Leo", parent: "55P/Tempel-Tuttle" },
  { code: "GEM", name: "Geminids",         peak: { m: 12, d: 14 }, active: { m: 12, d: 4,  endM: 12, endD: 20 }, zhr: 150, radiant: "Gemini", parent: "3200 Phaethon" },
  { code: "URS", name: "Ursids",           peak: { m: 12, d: 22 }, active: { m: 12, d: 17, endM: 12, endD: 26 }, zhr: 10,  radiant: "Ursa Minor", parent: "8P/Tuttle" },
];

function dt(m, d) {
  return new Date(Date.UTC(2000, m - 1, d)); // year-agnostic for range math
}

function isActive(s, now) {
  const start = dt(s.active.m, s.active.d);
  const end = dt(s.active.endM, s.active.endD);
  // Handle showers spanning year boundary (Quadrantids).
  const t = dt(now.getUTCMonth() + 1, now.getUTCDate());
  if (end >= start) return t >= start && t <= end;
  return t >= start || t <= end;
}

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const now = new Date();
  const year = now.getUTCFullYear();

  const resolved = SHOWERS.map(s => {
    const peakDate = new Date(Date.UTC(year, s.peak.m - 1, s.peak.d));
    const days = Math.round((peakDate - now) / 86400000);
    return {
      code: s.code,
      name: s.name,
      zhr: s.zhr,
      radiant: s.radiant,
      parent: s.parent,
      peak_date: peakDate.toISOString().slice(0, 10),
      days_until_peak: days,
      active: isActive(s, now),
    };
  });

  resolved.sort((a, b) => a.days_until_peak - b.days_until_peak);

  const upcoming = resolved.filter(s => s.days_until_peak > 0).slice(0, 3);
  const active = resolved.filter(s => s.active);

  return ok({
    source: "IMO Working List of Meteor Showers",
    date: now.toISOString(),
    active: active.map(s => ({ code: s.code, name: s.name, zhr: s.zhr, peak_date: s.peak_date, radiant: s.radiant })),
    next: upcoming.map(s => ({
      code: s.code, name: s.name, zhr: s.zhr, peak_date: s.peak_date,
      days_until_peak: s.days_until_peak, radiant: s.radiant,
    })),
    calendar: resolved,
  }, { ttl: 86400 });
}
