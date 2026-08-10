// Lightweight local dev server: serves public/ statically and runs the Netlify
// functions in-process under /api/<widget>. Same response contract as production
// (wrapped {ok,data} for browsers, raw passthrough for the firmware's
// X-Periphery-Raw header). Loads env vars from .env if present.
//
//   node dev-server.mjs          # default http://localhost:8080
//   PORT=3000 node dev-server.mjs
//
// NOTE: functions run in Node's global fetch; they behave identically here and
// under netlify dev. Use `netlify dev` for the full fidelity check.

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// ---- load .env (simple KEY=VALUE, no interpolation) ----
// Resolve relative paths from this file's location so the server works no
// matter what directory it is launched from.
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 8080);
const PUB = join(ROOT, "../web/public");
const FUNCS = join(ROOT, "functions");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function loadHandlers() {
  const handlers = new Map();
  const files = await readdir(FUNCS);
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const name = f.replace(/\.js$/, "");
    const mod = await import(join(FUNCS, f));
    handlers.set(name, mod.default);
  }
  return handlers;
}

function parseQs(url) {
  const idx = url.indexOf("?");
  const qs = idx >= 0 ? url.slice(idx + 1) : "";
  const params = {};
  if (qs) for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

function buildEvent(req, url, params) {
  return {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters: params,
    headers: req.headers,
  };
}

// Turn a web Response (from a function) into a node response.
async function sendRes(fnRes, res) {
  res.statusCode = fnRes.status || 200;
  for (const [k, v] of fnRes.headers) res.setHeader(k, v);
  const text = await fnRes.text();
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // ---- API routes: /api/<widget> ----
    const apiMatch = url.pathname.match(/^\/api\/([a-z]+)\/?$/);
    if (apiMatch) {
      const handlers = await loadHandlers();
      const handler = handlers.get(apiMatch[1]);
      if (!handler) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "No such function" }));
        return;
      }
      const event = buildEvent(req, url, parseQs(url.search));
      let fnRes;
      try {
        fnRes = await handler(event);
      } catch (e) {
        console.error(`[${apiMatch[1]}]`, e);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        return;
      }
      await sendRes(fnRes, res);
      return;
    }

    // ---- static files ----
    let filePath = normalize(join(PUB, url.pathname));
    if (filePath.endsWith("/") || !extname(filePath)) filePath = join(filePath, "index.html");
    if (url.pathname === "/") filePath = join(PUB, "index.html");

    try {
      const st = await stat(filePath);
      if (!st.isFile()) throw new Error("not file");
      const data = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
      // Never let the browser or the service worker serve stale dev assets.
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.end(data);
    } catch {
      // SPA fallback
      const data = await readFile(join(PUB, "index.html"));
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[".html"]);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.end(data);
    }
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`periphery dev server: http://localhost:${PORT}`);
  console.log(`  static  -> ${PUB}`);
  console.log(`  api     -> ${FUNCS} (loaded on each request)`);
});
