import { handleOptions, ok, fail, requireParams, upstreamJson, rawResponse } from "./utils.js";
import { TRAIN_HOST, TRAIN_PATH, TRAIN_SVC, TRAIN_UA, TRAIN_TTL, TRAIN_WINDOW_H } from "./env.js";

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["station"]);
  if (error) return fail(400, error);

  // Default window: [now, now+TRAIN_WINDOW_H], local server time. Caller may
  // override date/start/end (the firmware always sends all three).
  const date = params.date;
  const start = params.start;
  let end = params.end;
  if (!end) {
    const d = date ? new Date(`${date}T${start ?? "00:00"}:00`) : new Date();
    const e = new Date(d.getTime() + TRAIN_WINDOW_H * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    end = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
  }
  if (!date || !start) {
    return fail(400, "Missing required parameters: station, date, start");
  }

  const url = `https://${TRAIN_HOST}${TRAIN_PATH}/partidas-chegadas/${params.station}/${date}%20${start}/${date}%20${end}/${TRAIN_SVC}`;

  const { status, body } = await upstreamJson(url, {
    headers: { "User-Agent": TRAIN_UA, Accept: "application/json" },
  });
  const raw = rawResponse(event, status, body);
  if (raw) return raw;
  if (status !== 200 || !body) {
    return fail(502, "Upstream trains request failed", { upstreamStatus: status });
  }
  return ok(body, { ttl: TRAIN_TTL });
}
