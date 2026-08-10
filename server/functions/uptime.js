import { normalizeEvent, handleOptions, ok, fail, requireParams } from "./utils.js";
import { UPSTREAM_TIMEOUT_MS } from "./env.js";

// Uptime monitors: checks a configurable list of HTTP(S) sites and reports
// reachability + response time. The frontend sends the site list (label|url)
// so no redeploy is needed to add a monitor. HEAD is used first; a 405/501
// falls back to GET, which also guarantees we have a body to size.
export default async function handler(event) {
  event = normalizeEvent(event);
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "GET") return fail(405, "Method not allowed");

  const { error, params } = requireParams(event, ["sites"]);
  if (error) return fail(400, error);

  let sites;
  try {
    sites = JSON.parse(params.sites);
  } catch {
    return fail(400, "sites must be a JSON array of {label,url}");
  }
  if (!Array.isArray(sites) || sites.length === 0) return fail(400, "sites must be a non-empty JSON array");

  const checks = await Promise.all(sites.slice(0, 25).map(async s => {
    const label = String(s.label || s.url || "").trim();
    const url = String(s.url || "").trim();
    const entry = { label: label || url, url, ok: false, status: null, ms: null, error: null };
    if (!/^https?:\/\//i.test(url)) {
      entry.error = "invalid url";
      return entry;
    }
    for (const method of ["HEAD", "GET"]) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
        const res = await fetch(url, { method, redirect: "follow", signal: controller.signal });
        clearTimeout(timer);
        entry.ms = Date.now() - started;
        entry.status = res.status;
        // Any HTTP response means the host is reachable; only network-level
        // failures (DNS, refused, timeout) count as "down".
        entry.ok = true;
        if (res.status === 405 || res.status === 501) continue; // retry GET
        break;
      } catch (e) {
        entry.ms = Date.now() - started;
        entry.error = e.name === "AbortError" ? "timeout" : e.message;
        break;
      }
    }
    return entry;
  }));

  return ok({
    source: "http monitor",
    checked: checks.length,
    down: checks.filter(c => !c.ok).map(c => c.label),
    sites: checks,
  }, { ttl: 30 });
}
