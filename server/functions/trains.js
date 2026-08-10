import { normalizeEvent, handleOptions, ok, fail, requireParams, upstreamJson, rawResponse, cachedFetch } from "./utils.js";
import { TRAIN_HOST, TRAIN_PATH, TRAIN_SVC, TRAIN_UA, TRAIN_TTL, TRAIN_WINDOW_H } from "./env.js";

export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["station", "date", "start"]);
  if (error) return fail(400, error);

  let date = params.date;
  let start = params.start;
  let end = params.end;
  if (!end) {
    const d = date ? new Date(`${date}T${start ?? "00:00"}:00`) : new Date();
    const e = new Date(d.getTime() + TRAIN_WINDOW_H * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    end = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
  }

  // The IP upstream endpoint takes a single date for both bounds, so a window
  // crossing midnight must be split into per-day segments and merged.
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayAfter = (isoDate) => {
    const [y, m, d] = isoDate.split("-").map(Number);
    return iso(new Date(Date.UTC(y, m - 1, d + 1)));
  };
  const segments = [];
  if (end < start) {
    // Crosses midnight: today start→23:59 plus tomorrow 00:00→end.
    segments.push({ date, start, end: "23:59" });
    segments.push({ date: dayAfter(date), start: "00:00", end });
  } else {
    segments.push({ date, start, end });
  }

  const all = await cachedFetch(`trains:${params.station}:${date}:${start}:${end}`, TRAIN_TTL * 1000, async () => {
    const merged = [];
    for (const seg of segments) {
      const url = `https://${TRAIN_HOST}${TRAIN_PATH}/partidas-chegadas/${params.station}/${seg.date}%20${seg.start}/${seg.date}%20${seg.end}/${TRAIN_SVC}`;
      const { status, body } = await upstreamJson(url, {
        headers: { "User-Agent": TRAIN_UA, Accept: "application/json" },
      });
      const raw = rawResponse(event, status, body);
      if (raw) return raw;
      if (status === 200 && body && Array.isArray(body.response)) merged.push(...body.response);
    }
    return merged.length ? merged : null;
  });

  if (!all) {
    return fail(502, "Upstream trains request failed");
  }
  if (all instanceof Response) return all;
  return ok({ response: all }, { ttl: TRAIN_TTL });
}
