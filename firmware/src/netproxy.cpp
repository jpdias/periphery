#include "logbuf.h"
#include "netproxy.h"
#include "config.h"

static char gHost[128] = {0};
static bool gChunked = false;
static bool gPrefixDone = false;

bool proxy_enabled() {
  return cfg.api_base[0] && proxy_host()[0];
}

// Extract the host (no scheme, no path) from cfg.api_base into a static buffer.
// Accepts "https://host/path", "host/path" or bare "host". Returns "" if empty.
const char* proxy_host() {
  if (!cfg.api_base[0]) { gHost[0] = 0; return gHost; }
  const char* src = cfg.api_base;
  if (strncmp(src, "https://", 8) == 0) src += 8;
  else if (strncmp(src, "http://", 7) == 0) src += 7;
  const char* slash = strchr(src, '/');
  size_t len = slash ? (size_t)(slash - src) : strlen(src);
  if (len >= sizeof(gHost)) len = sizeof(gHost) - 1;
  memcpy(gHost, src, len);
  gHost[len] = 0;
  // Trim any trailing port for display; connection always uses 443.
  char* colon = strchr(gHost, ':');
  if (colon) *colon = 0;
  return gHost;
}

String proxy_path(const char* widget, const String &query) {
  String p = String("/api/") + widget;
  if (query.length()) p += "?" + query;
  return p;
}

bool skip_proxy_headers(Stream &s) {
  int state = 0;
  gChunked = false;
  gPrefixDone = false;
  char hdr[128];
  int hdrLen = 0;

  while (s.available()) {
    char c = (char)s.read();

    if (state == 0 && c == '\r') state = 1;
    else if (state == 1 && c == '\n') state = 2;
    else if (state == 2 && c == '\r') state = 3;
    else if (state == 3 && c == '\n') {
      return true;
    } else {
      state = 0;
    }

    if (c == '\n') {
      hdr[hdrLen] = 0;
      if (strstr(hdr, "transfer-encoding") && strstr(hdr, "chunked"))
        gChunked = true;
      hdrLen = 0;
    } else if (c != '\r' && hdrLen < (int)sizeof(hdr) - 1) {
      hdr[hdrLen++] = (c >= 'A' && c <= 'Z') ? (c + 32) : c;
    }
  }
  return false;
}

bool skip_chunk_prefix(Stream &s) {
  if (!gChunked || gPrefixDone) return true;
  while (s.available()) {
    char ch = (char)s.read();
    if (ch == '\n') { gPrefixDone = true; return true; }
  }
  return false;
}
